// 실시간 다국어 자막 서버: 정적 파일 + WebSocket(STT → NMT) + 용어집 교체(HTTP)
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');
const speech = require('@google-cloud/speech');
const { TranslationServiceClient } = require('@google-cloud/translate');
const { Storage } = require('@google-cloud/storage');

const PROJECT = 'gtr-923548';
const LOCATION = 'us-central1';
const BUCKET = 'gtr-923548-glossary';
const GLOSSARY = `projects/${PROJECT}/locations/${LOCATION}/glossaries/conf-terms`;
const RECOGNIZER = `projects/${PROJECT}/locations/us/recognizers/_`;
// 화면에서 고르는 인식 모델(허용 목록). long은 interim이 단어 단위로 자주 오고, chirp_3는 약 5초에 한 번이다
const STT_MODELS = ['long', 'chirp_3'];
// long은 이 원문 언어에서 구문 힌트(adaptation)를 거부한다(2026-11-15 실행 확인. public/index.html에도 같은 목록이 있다)
const NO_HINTS = { long: ['zh-CN', 'hi', 'ru', 'ko'] };
const INTERIM_GAP_MS = 700; // 언어별 중간 번역 호출 사이 최소 간격
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
    catch (e) { throw new Error(e.code === 5 ? '용어집(conf-terms)이 아직 없습니다. 최초 생성(5.1절)을 먼저 하세요' : e.message); }
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
        if (cfg?.interim) for (const lang of c.targets) queueInterim(lang, utt, interim, c, words);
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
    const useGlossary = cfg ? cfg.glossary : c.glossary; // 진행 중 settings로 바뀐 값을 따른다
    for (const lang of c.targets) translateOne({ id, text, source: c.source, lang, useGlossary, words, interim: false });
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
    if (done.has(job.id) || job.text === q.last || !cfg?.interim) return pump(lang);
    q.busy = true; q.at = Date.now(); q.last = job.text;
    await translateOne({ ...job, lang, useGlossary: !!cfg?.glossary, interim: true });
    q.busy = false;
    pump(lang);
  }

  async function translateOne({ id, text, source, lang, useGlossary, words, interim }) {
    const t0 = Date.now();
    stats[interim ? 'interimCalls' : 'finalCalls']++;
    stats[interim ? 'interimChars' : 'finalChars'] += text.length;
    try {
      const [r] = await translate.translateText({
        parent: `projects/${PROJECT}/locations/${LOCATION}`,
        contents: [text], sourceLanguageCode: source, targetLanguageCode: lang, mimeType: 'text/plain',
        model: `projects/${PROJECT}/locations/${LOCATION}/models/general/nmt`,
        ...(useGlossary && { glossaryConfig: { glossary: GLOSSARY, ignoreCase: true } }),
      });
      if (interim && done.has(id)) return; // 늦게 온 중간 번역이 확정 번역을 덮지 않게 버린다
      const plain = r.translations[0].translatedText;
      const out = useGlossary ? r.glossaryTranslations[0].translatedText : plain;
      // glossary 적용 번역에는 있고 적용 전 번역에는 없는 대상 언어 용어 = glossary로 바뀐 용어
      const has = (s, w) => s.toLowerCase().includes(w.toLowerCase());
      const changed = useGlossary ? [...new Set(words.map((t) => t[lang]).filter((w) => w && has(out, w) && !has(plain, w)))] : [];
      send({ type: 'translation', id, lang, text: out, ms: Date.now() - t0, terms: changed, ...(interim && { interim: true }) });
    } catch (e) {
      if (!interim) send({ type: 'error', id, lang, message: e.message }); // 중간 번역 실패는 다음 interim이나 final이 대신한다
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
      const c = { source: m.source, targets, glossary: !!m.glossary, interim: m.interim !== false, model, hints };
      try { terms = (await loadGlossary())?.terms || []; }
      catch (e) { terms = []; send({ type: 'error', message: `용어집을 읽지 못해 구문 힌트·용어 강조 없이 시작합니다: ${e.message}` }); }
      cfg = c;
      stream = openStream();
      send({ type: 'started', model, phrases: hints ? terms.filter((t) => t[c.source]).length : 0 });
    } else if (m.type === 'settings' && cfg) {
      // 다음 발화(번역 호출)부터 적용
      cfg = { ...cfg, ...('glossary' in m && { glossary: !!m.glossary }), ...('interim' in m && { interim: !!m.interim }) };
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
  const server = http.createServer(app);
  new WebSocketServer({ server }).on('connection', session);
  const port = process.env.PORT || 8080;
  server.listen(port, '0.0.0.0', () => console.log(`http://localhost:${port}`));
}

module.exports = { parseGlossaryCsv };
