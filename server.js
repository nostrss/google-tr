// 실시간 다국어 자막 서버: 정적 파일 + WebSocket(STT → NMT) + 용어집 교체(HTTP)
const config = require('./config'); // .env를 Google 클라이언트보다 먼저 읽는다
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');
const speech = require('@google-cloud/speech');
const { TranslationServiceClient } = require('@google-cloud/translate');
const { Storage } = require('@google-cloud/storage');

const { PROJECT, BUCKET, GLOSSARY_ID } = config; // 환경 변수 또는 .env (config.js)
const LOCATION = 'us-central1'; // glossary는 us-central1에만 둘 수 있다
const GLOSSARY = `projects/${PROJECT}/locations/${LOCATION}/glossaries/${GLOSSARY_ID}`;
const RECOGNIZER = `projects/${PROJECT}/locations/us/recognizers/_`;
// 화면에서 고르는 인식 모델(허용 목록). long은 interim이 단어 단위로 자주 오고, chirp_3는 약 5초에 한 번이다
const STT_MODELS = ['long', 'chirp_3'];
// long은 이 원문 언어에서 구문 힌트(adaptation)를 거부한다(2026-11-15 실행 확인. public/index.html에도 같은 목록이 있다)
const NO_HINTS = { long: ['zh-CN', 'hi', 'ru', 'ko'] };
const INTERIM_GAP_MS = 700; // 언어별 중간 번역 호출 사이 최소 간격
// 화면에서 고르는 번역 모델(허용 목록). nmt = Google NMT, llm = Translation LLM,
// adaptive = Adaptive Translation(용어집 끔: 인라인 예문, 용어집 켬: 예문 데이터셋 + glossary)
const MT_MODELS = ['nmt', 'llm', 'adaptive'];
// 용어집 적용 방식(허용 목록). forced = 용어 강제(조사 앞 공백·누락 가능), contextual = 문맥형(LLM·Adaptive만, 용어가 안 지켜질 수 있음).
// NMT에 contextual을 주면 'Contextual translation is only supported for LLM models.'(400)라서 NMT는 항상 forced
const GLOSSARY_MODES = ['forced', 'contextual'];
const ROTATE_MS = Number(process.env.STT_ROTATE_MS) || 270_000; // 4분 30초마다 STT 스트림 교체(5분 상한 대비). 점검 때만 짧게 덮어쓴다
const PHRASE_BOOST = 10;
// 번역/용어집 언어 코드 → STT 언어 코드
const LANGS = { en: 'en-US', 'zh-CN': 'cmn-Hans-CN', es: 'es-ES', hi: 'hi-IN', pt: 'pt-BR', ru: 'ru-RU', ja: 'ja-JP', ko: 'ko-KR', fr: 'fr-FR', de: 'de-DE' };

// ---------- 용어집 CSV 검사 (5.2절). 실패하면 첫 오류 1건을 Error로 던진다 ----------
function parseGlossaryCsv(buf) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } // TextDecoder는 BOM을 기본으로 지운다
  catch { throw new Error('UTF-8 파일이 아닙니다'); }
  const lines = text.split(/\r?\n/).map((s, i) => ({ s, no: i + 1 })).filter((l) => l.s.trim() !== '');
  const quoted = lines.find((l) => l.s.includes('"'));
  if (quoted) throw new Error(`${quoted.no}행: 따옴표(")는 쓸 수 없습니다`);
  if (!lines.length) throw new Error('빈 파일입니다');
  const header = lines[0].s.split(',').map((c) => c.trim());
  const want = Object.keys(LANGS);
  if (header.length !== want.length || new Set(header).size !== header.length || !want.every((c) => header.includes(c)))
    throw new Error(`${lines[0].no}행: 헤더는 ${want.join(',')} 10개여야 합니다(순서 무관, 중복 불가)`);
  const rows = lines.slice(1);
  if (!rows.length) throw new Error('용어 행이 없습니다');
  if (rows.length > 1000) throw new Error(`용어 행이 ${rows.length}개입니다(최대 1,000개)`);
  const terms = rows.map(({ s, no }) => {
    const cells = s.split(',').map((c) => c.trim());
    if (cells.length !== header.length) throw new Error(`${no}행: 열이 ${cells.length}개입니다(${header.length}개 필요)`);
    if (cells.every((c) => !c)) throw new Error(`${no}행: 모든 칸이 비어 있습니다`);
    cells.forEach((c, i) => {
      if (Buffer.byteLength(c) >= 1024) throw new Error(`${no}행 ${header[i]} 열: 칸이 1,024바이트를 넘습니다`);
    });
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
  // 공백을 정리한 내용으로 다시 써서 올린다(서버가 읽는 용어와 glossary가 쓰는 용어를 일치시키기 위해)
  const csv = [header.join(','), ...terms.map((t) => header.map((h) => t[h]).join(','))].join('\n') + '\n';
  return { terms, csv };
}

// ---------- Adaptive 예문: 저장소 루트 examples.csv(glossary와 같은 10개 언어 헤더, 최대 5행)를 서버 시작 때 읽는다 ----------
// 같은 검사 규칙을 쓰므로 칸 안에 ASCII 쉼표·따옴표를 쓸 수 없다
let examples = [], examplesError = null;
try {
  examples = parseGlossaryCsv(fs.readFileSync(path.join(__dirname, 'examples.csv'))).terms;
  if (examples.length > 5) throw new Error(`예문은 최대 5행입니다(${examples.length}행)`); // 인라인 예문 상한 5쌍
} catch (e) {
  examples = [];
  examplesError = e.code === 'ENOENT' ? 'examples.csv가 없습니다' : `examples.csv: ${e.message}`;
}

// ---------- Google 클라이언트 ----------
const sttClient = new speech.v2.SpeechClient({ apiEndpoint: 'us-speech.googleapis.com' });
const translate = new TranslationServiceClient();
const bucket = new Storage().bucket(BUCKET);

const ts = (t) => t && new Date(Number(t.seconds) * 1000 + Math.floor((t.nanos || 0) / 1e6)).toISOString();

// glossary가 지금 가리키는 CSV를 읽어 용어 목록을 만든다. glossary가 없으면 null
async function loadGlossary() {
  let g;
  try { [g] = await translate.getGlossary({ name: GLOSSARY }); }
  catch (e) { if (e.code === 5) return null; throw e; }
  const uri = g.inputConfig.gcsSource.inputUri;
  const [buf] = await bucket.file(uri.replace(`gs://${BUCKET}/`, '')).download();
  return { glossary: g, uri, terms: parseGlossaryCsv(buf).terms };
}

// ponytail: 교체 중 플래그·직전 오류는 이 인스턴스 메모리에만 있다. 여러 인스턴스면 버킷이나 DB에 둔다
const gl = { updating: false, error: null };

// ---------- HTTP ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/glossary', async (req, res) => {
  if (gl.updating) return res.json({ state: 'updating' });
  try {
    const cur = await loadGlossary();
    if (!cur) return res.json({ state: 'none' });
    res.json({ state: gl.error ? 'failed' : 'ready', ...(gl.error && { error: gl.error }), ...summary(cur) });
  } catch (e) {
    res.status(502).json({ state: 'failed', error: `용어집을 읽지 못했습니다: ${e.message}` });
  }
});
const summary = (cur) => ({ terms: cur.terms.length, entryCount: cur.glossary.entryCount, updatedAt: ts(cur.glossary.endTime) });

app.post('/glossary', express.raw({ type: 'text/csv', limit: '1mb' }), async (req, res) => {
  if (gl.updating) return res.status(409).json({ error: '이미 교체 중입니다' });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Content-Type: text/csv 로 보내야 합니다' });
  let parsed;
  try { parsed = parseGlossaryCsv(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

  gl.updating = true;
  try {
    let prevUri;
    try { [{ inputConfig: { gcsSource: { inputUri: prevUri } } }] = await translate.getGlossary({ name: GLOSSARY }); }
    catch (e) { throw new Error(e.code === 5 ? `용어집(${GLOSSARY_ID})이 아직 없습니다. 최초 생성(SETUP.md)을 먼저 하세요` : e.message); }
    const name = `glossary-${new Date().toISOString().replace(/[-:.]/g, '')}.csv`;
    await bucket.file(name).save(parsed.csv, { contentType: 'text/csv; charset=utf-8' });
    try {
      await patchInput(`gs://${BUCKET}/${name}`);
    } catch (e) {
      // 실패해도 inputUri는 새 값으로 남으므로(관문 A 확인) 직전 URI로 되돌린다
      let msg = `용어집 교체 실패: ${e.message}`;
      try { await patchInput(prevUri); msg += ' (이전 용어집으로 되돌렸습니다)'; }
      catch (e2) { msg += ` / 되돌리기도 실패: ${e2.message}`; }
      throw new Error(msg);
    }
    gl.error = null;
    res.json({ state: 'ready', ...summary(await loadGlossary()) });
  } catch (e) {
    gl.error = e.message;
    res.status(502).json({ state: 'failed', error: e.message });
  } finally {
    gl.updating = false;
  }
});

async function patchInput(inputUri) {
  const [op] = await translate.updateGlossary({
    glossary: { name: GLOSSARY, inputConfig: { gcsSource: { inputUri } } },
    updateMask: { paths: ['input_config'] }, // camelCase(inputConfig)는 gRPC에서 거부된다
  });
  await op.promise();
}

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.status === 413 ? '파일이 1MB를 넘습니다' : err.message });
});

// ---------- Adaptive 예문 데이터셋: 언어쌍마다 1개(ex-<원문>-<대상>), examples.csv의 두 열로 만든다 ----------
// 인라인 예문에는 glossary를 붙일 수 없어('Persistent dataset is null') 용어집을 켠 Adaptive는 데이터셋을 쓴다.
// ponytail: 한번 만든 데이터셋은 examples.csv가 바뀌어도 갱신하지 않는다. 바꾸려면 데이터셋을 지우고(deleteAdaptiveMtDataset) 서버를 다시 띄우면
// 다음 시작 때 새로 만든다(준비 상태를 메모리에 두므로 서버를 그대로 두면 지운 데이터셋을 계속 준비됨으로 본다)
const PARENT = `projects/${PROJECT}/locations/${LOCATION}`;
const dsName = (source, lang) => `${PARENT}/adaptiveMtDatasets/` + `ex-${source}-${lang}`.toLowerCase(); // zh-CN → ex-zh-cn-ko
const datasets = new Map(); // 'ko-en' -> { state: 'preparing' | 'ready' | 'failed', promise, ms, error } (모든 세션이 같이 쓴다)
function ensureDataset(source, lang) {
  const key = `${source}-${lang}`;
  let d = datasets.get(key);
  if (d && d.state !== 'failed') return d; // 실패했으면 다시 시도한다
  d = { state: 'preparing' };
  const t0 = Date.now();
  d.promise = (async () => {
    const pairs = examples.filter((e) => e[source] && e[lang]);
    if (pairs.length < 5) throw new Error(examplesError || `examples.csv에 ${source}·${lang} 예문이 ${pairs.length}쌍입니다(데이터셋에는 5쌍 필요)`);
    const name = dsName(source, lang);
    let ds = null;
    try { [ds] = await translate.getAdaptiveMtDataset({ name }); } catch (e) { if (e.code !== 5) throw e; }
    if (!ds) [ds] = await translate.createAdaptiveMtDataset({ parent: PARENT,
      adaptiveMtDataset: { name, displayName: name.split('/').pop().replaceAll('-', '_'), sourceLanguageCode: source, targetLanguageCode: lang } });
    if (!ds.exampleCount) await translate.importAdaptiveMtFile({ parent: name, fileInputSource: { mimeType: 'text/tab-separated-values',
      content: Buffer.from(pairs.map((e) => `${e[source]}\t${e[lang]}`).join('\n') + '\n'), displayName: 'examples.tsv' } });
  })().then(() => { d.state = 'ready'; d.ms = Date.now() - t0; console.log('adaptive dataset ready', key, d.ms + 'ms'); },
    (e) => { d.state = 'failed'; d.error = e.message; throw e; });
  d.promise.catch(() => {}); // 실패는 구독한 세션이 알린다
  datasets.set(key, d);
  return d;
}

// glossary 강제 적용(TLLM, Adaptive)은 mimeType이 text/plain이어도 결과에 HTML 엔티티를 섞어 보낸다. 한 번만 되돌린다
const ENT = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&#x27;': "'" };
const unesc = (s) => s.replace(/&(?:quot|amp|lt|gt|#39|#x27);/g, (m) => ENT[m]);

// 번역 모델별 호출. 돌려주는 값: out = 화면에 보일 번역, plain = glossary 적용 전 번역(강조 계산용, 문맥형이면 빈 문자열)
async function machineTranslate(mt, text, source, lang, useGlossary, contextual) {
  const parent = PARENT;
  const glossaryConfig = { glossary: GLOSSARY, ignoreCase: true, ...(contextual && { contextualTranslationEnabled: true }) };
  if (mt === 'adaptive' && useGlossary) {
    const d = datasets.get(`${source}-${lang}`);
    if (d?.state !== 'ready') throw Object.assign(new Error(d?.state === 'failed' ? `예문 데이터셋 준비 실패: ${d.error}` : '예문 데이터셋 준비 중…'), { pending: d?.state !== 'failed' });
    // 강제 적용이면 translations도 오지만 이미 조사 앞 공백이 들어간 형태다. 문맥형이면 translations는 빈 배열
    const [r] = await translate.adaptiveMtTranslate({ parent, dataset: dsName(source, lang), content: [text], mimeType: 'text/plain', glossaryConfig });
    return { out: unesc(r.glossaryTranslations[0].translatedText), plain: unesc(r.translations[0]?.translatedText || '') };
  }
  if (mt === 'adaptive') {
    // 용어집 끔: 인라인 예문(최대 5쌍). 데이터셋 방식보다 빠르다(약 0.5초 대 2초)
    const pairs = examples.filter((e) => e[source] && e[lang]).map((e) => ({ sourceSentence: e[source], targetSentence: e[lang] }));
    if (!pairs.length) throw new Error(examplesError || `examples.csv에 ${source}·${lang} 열 예문이 없습니다`);
    const [r] = await translate.adaptiveMtTranslate({
      parent, content: [text], mimeType: 'text/plain',
      referenceSentenceConfig: { referenceSentencePairLists: [{ referenceSentencePairs: pairs }], sourceLanguageCode: source, targetLanguageCode: lang },
    });
    const out = unesc(r.translations[0].translatedText);
    return { out, plain: out };
  }
  const [r] = await translate.translateText({
    parent, contents: [text], sourceLanguageCode: source, targetLanguageCode: lang, mimeType: 'text/plain',
    model: `${parent}/models/general/${mt === 'llm' ? 'translation-llm' : 'nmt'}`,
    // TLLM 문맥형이면 translations는 빈 문자열로 온다
    ...(useGlossary && { glossaryConfig }),
  });
  const plain = unesc(r.translations[0]?.translatedText || '');
  return { out: useGlossary ? unesc(r.glossaryTranslations[0].translatedText) : plain, plain };
}

// ---------- WebSocket 세션: 오디오 → STT → 발화마다 번역(중간 + 확정) ----------
function session(ws) {
  const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  let cfg = null, stream = null, openedAt = 0, rotateTimer = null, nextId = 1, terms = [];
  // 발화 번호: 스트림마다 진행 중 발화에 번호를 하나 붙이고(첫 interim이나 final 때), final이 오면 닫는다.
  // 스트림 교체 때 이전 스트림의 final과 새 스트림의 interim이 겹쳐도 번호가 섞이지 않는다
  const done = new Set(); // ponytail: 확정된 발화 번호를 세션 끝까지 쌓는다(1시간에 수천 개 수준이라 둠)
  const queues = {}; // 언어별 중간 번역 대기열 { busy, next, last, at, timer }
  const stats = { finalCalls: 0, finalChars: 0, interimCalls: 0, interimChars: 0 };

  function openStream() {
    const c = cfg, words = terms; // 정지 뒤에 도착하는 final도 이 스트림을 연 설정으로 처리한다
    const s = sttClient._streamingRecognize(); // v2에서는 helper(streamingRecognize)가 맞지 않아 원 메서드에 객체를 직접 쓴다
    let utt = null;
    const config = {
      explicitDecodingConfig: { encoding: 'LINEAR16', sampleRateHertz: 16000, audioChannelCount: 1 },
      languageCodes: [LANGS[c.source]],
      model: c.model,
    };
    const phrases = c.hints ? words.map((t) => t[c.source]).filter((v) => v && v.length <= 100).slice(0, 1000) : [];
    if (phrases.length) config.adaptation = { phraseSets: [{ inlinePhraseSet: { phrases: phrases.map((value) => ({ value, boost: PHRASE_BOOST })) } }] };
    s.on('data', (r) => {
      if (r.speechEventType === 'SPEECH_ACTIVITY_BEGIN') send({ type: 'vad', speaking: true });
      if (r.speechEventType === 'SPEECH_ACTIVITY_END') send({ type: 'vad', speaking: false });
      const results = r.results || [];
      const join = (xs) => xs.map((x) => x.alternatives?.[0]?.transcript || '').join('').replace(/\s+/g, ' ').trim(); // 결과 조각은 앞 공백을 포함해 온다
      const fin = join(results.filter((x) => x.isFinal));
      const interim = join(results.filter((x) => !x.isFinal));
      if (fin) {
        const id = utt ?? nextId++;
        utt = null;
        onFinal(id, fin, c, words);
      }
      if (interim && s === stream) { // 교체돼 입력을 닫은 스트림의 interim은 버린다
        utt ??= nextId++;
        send({ type: 'interim', id: utt, text: interim });
        if (interimOn()) for (const lang of c.targets) queueInterim(lang, utt, interim, c, words);
      }
    });
    s.on('error', (e) => {
      if (s === stream) stream = null; // 다음 오디오 조각이 오면 다시 연다(아래 throttle)
      if (e.code !== 1) send({ type: 'error', message: `음성 인식 오류: ${e.message}` }); // 1 = 우리가 취소한 경우
    });
    s.write({ recognizer: RECOGNIZER, streamingConfig: { config, streamingFeatures: { interimResults: true, enableVoiceActivityEvents: true } } });
    openedAt = Date.now();
    clearTimeout(rotateTimer);
    rotateTimer = setTimeout(() => {
      // 새 스트림으로 바꾸고, 이전 스트림은 입력만 닫아 남은 final을 받는다. 경계의 단어는 잘릴 수 있다(프로토타입 허용)
      const old = stream;
      stream = openStream();
      old?.end();
      console.log('stt stream rotated');
    }, ROTATE_MS);
    return s;
  }

  function onFinal(id, text, c, words) {
    done.add(id);
    for (const q of Object.values(queues)) if (q.next?.id === id) q.next = null; // 대기 중인 이 발화의 중간 번역은 버린다
    send({ type: 'final', id, text });
    const now = cfg || c; // 진행 중 settings로 바뀐 값을 따른다
    for (const lang of c.targets) translateOne({ id, text, source: c.source, lang, useGlossary: now.glossary, words, interim: false, mt: now.mt, contextual: contextualOf(now) });
  }

  // 언어별로 동시에 1개, 최소 간격 INTERIM_GAP_MS. 기다리는 동안 온 interim은 가장 최신 것만 남긴다
  function queueInterim(lang, id, text, c, words) {
    const q = (queues[lang] ??= { busy: false, next: null, last: '', at: 0, timer: null });
    q.next = { id, text, source: c.source, words };
    pump(lang);
  }
  async function pump(lang) {
    const q = queues[lang];
    if (q.busy || q.timer || !q.next) return;
    const wait = q.at + INTERIM_GAP_MS - Date.now();
    if (wait > 0) { q.timer = setTimeout(() => { q.timer = null; pump(lang); }, wait); return; }
    const job = q.next;
    q.next = null;
    if (done.has(job.id) || job.text === q.last || !interimOn()) return pump(lang);
    q.busy = true; q.at = Date.now(); q.last = job.text;
    await translateOne({ ...job, lang, useGlossary: cfg.glossary, interim: true, mt: cfg.mt, contextual: contextualOf(cfg) });
    q.busy = false;
    pump(lang);
  }

  async function translateOne({ id, text, source, lang, useGlossary, words, interim, mt, contextual }) {
    const t0 = Date.now();
    stats[interim ? 'interimCalls' : 'finalCalls']++;
    stats[interim ? 'interimChars' : 'finalChars'] += text.length;
    try {
      const { out, plain } = await machineTranslate(mt, text, source, lang, useGlossary, contextual);
      if (interim && done.has(id)) return; // 늦게 온 중간 번역이 확정 번역을 덮지 않게 버린다
      // glossary 적용 번역에는 있고 적용 전 번역에는 없는 대상 언어 용어 = glossary로 바뀐 용어.
      // 문맥형은 적용 전 번역이 빈 문자열이라, 그때는 결과에 든 대상 언어 용어를 모두 강조한다.
      // Adaptive 강제 적용의 적용 전 번역은 공백이 들어간 형태지만 용어 포함 여부만 보므로 그대로 비교한다
      const has = (s, w) => s.toLowerCase().includes(w.toLowerCase());
      const changed = useGlossary ? [...new Set(words.map((t) => t[lang]).filter((w) => w && has(out, w) && !has(plain, w)))] : [];
      send({ type: 'translation', id, lang, mt, text: out, ms: Date.now() - t0, terms: changed, ...(contextual && { contextual: true }), ...(interim && { interim: true }) });
    } catch (e) {
      // 중간 번역 실패는 다음 interim이나 final이 대신한다. pending = 데이터셋 준비 중(오류가 아님)
      if (!interim) send({ type: 'error', id, lang, message: e.message, ...(e.pending && { pending: true }) });
    }
  }

  // Adaptive + 용어집(데이터셋)은 호출이 약 2초라 중간 번역을 쓰지 않는다(체크박스 값은 그대로 둔다)
  const interimOn = () => cfg?.interim && !(cfg.mt === 'adaptive' && cfg.glossary);
  const contextualOf = (c) => c.glossary && c.glossaryMode === 'contextual' && c.mt !== 'nmt';
  // Adaptive + 용어집이면 대상 언어마다 데이터셋을 준비하고 상태를 알린다. 준비 중인 칸의 확정 번역은 '준비 중'으로 나오고 준비 후 다음 문장부터 번역된다
  function prepareDatasets(c) {
    if (c.mt !== 'adaptive' || !c.glossary) return;
    for (const lang of c.targets) {
      const d = ensureDataset(c.source, lang);
      if (d.state === 'preparing') send({ type: 'dataset', lang, state: 'preparing' });
      d.promise.then(() => send({ type: 'dataset', lang, state: 'ready', ms: d.ms }), (e) => send({ type: 'dataset', lang, state: 'failed', error: e.message }));
    }
  }

  function close() {
    clearTimeout(rotateTimer);
    for (const q of Object.values(queues)) { clearTimeout(q.timer); q.timer = null; q.next = null; }
    stream?.end();
    stream = null; cfg = null;
  }

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (!cfg) return;
      if (!stream && Date.now() - openedAt > 3000) stream = openStream(); // 오류로 끊긴 뒤 재시도(초당 폭주 방지)
      stream?.write({ audio: data });
      return;
    }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'start') {
      close();
      const targets = Array.isArray(m.targets) ? m.targets.filter((l) => LANGS[l] && l !== m.source) : [];
      if (!LANGS[m.source] || !targets.length) return send({ type: 'error', message: '언어 설정이 잘못되었습니다' });
      if (gl.updating) return send({ type: 'error', message: '용어집 교체 중에는 시작할 수 없습니다' });
      const model = STT_MODELS.includes(m.model) ? m.model : STT_MODELS[0];
      const hints = !NO_HINTS[model]?.includes(m.source);
      const mt = MT_MODELS.includes(m.mt) ? m.mt : MT_MODELS[0];
      const glossaryMode = GLOSSARY_MODES.includes(m.glossaryMode) ? m.glossaryMode : GLOSSARY_MODES[0];
      const c = { source: m.source, targets, glossary: !!m.glossary, interim: m.interim !== false, model, hints, mt, glossaryMode };
      try { terms = (await loadGlossary())?.terms || []; }
      catch (e) { terms = []; send({ type: 'error', message: `용어집을 읽지 못해 구문 힌트·용어 강조 없이 시작합니다: ${e.message}` }); }
      cfg = c;
      stream = openStream();
      send({ type: 'started', model, mt, phrases: hints ? terms.filter((t) => t[c.source]).length : 0 });
      prepareDatasets(c);
    } else if (m.type === 'settings' && cfg) {
      // 다음 발화(번역 호출)부터 적용
      cfg = { ...cfg, ...('glossary' in m && { glossary: !!m.glossary }), ...('interim' in m && { interim: !!m.interim }),
        ...(MT_MODELS.includes(m.mt) && { mt: m.mt }), ...(GLOSSARY_MODES.includes(m.glossaryMode) && { glossaryMode: m.glossaryMode }) };
      prepareDatasets(cfg);
    } else if (m.type === 'stop') {
      close();
    }
  });
  ws.on('close', () => {
    close();
    if (stats.finalCalls) console.log('session stats', JSON.stringify(stats));
  });
}

if (require.main === module) {
  config.requireProject();
  const server = http.createServer(app);
  new WebSocketServer({ server }).on('connection', session);
  const port = process.env.PORT || 8080;
  server.listen(port, '0.0.0.0', () => console.log(`http://localhost:${port}`));
}

module.exports = { parseGlossaryCsv };
