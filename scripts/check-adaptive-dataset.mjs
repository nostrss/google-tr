// Adaptive dataset + glossary 점검:
//   node scripts/check-adaptive-dataset.mjs create <src> <tgt> inline|gcs | import <src> <tgt> inline|gcs | list | files <src> <tgt>
//   | translate | extra | tllm | combos | pair | latency | burst [rounds] | rest
// 만드는 리소스: dataset check-<src>-<tgt>(이름 규칙에 걸리면 check_<src>_<tgt>), 버킷 객체 adaptive-check-<src>-<tgt>*.tsv
import config from '../config.js'; // .env를 Google 클라이언트보다 먼저 읽는다
import { TranslationServiceClient } from '@google-cloud/translate';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

config.requireProject();
const P = config.PROJECT, LOC = 'us-central1', parent = `projects/${P}/locations/${LOC}`;
const GLOSSARY = `${parent}/glossaries/${config.GLOSSARY_ID}`;
const BUCKET = `gs://${config.BUCKET}`;
const client = new TranslationServiceClient();
const [cmd, a1, a2, a3] = process.argv.slice(2);
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const dsId = (s, t) => `check-${s}-${t}`.replace('zh-CN', 'zh');
const dsName = (s, t) => `${parent}/adaptiveMtDatasets/${dsId(s, t)}`;
const run = async (label, f) => { try { const r = await f(); console.log(label, JSON.stringify(r)); return r; } catch (e) { console.log(label, 'ERROR', e.code, e.message); } };

// 예문: examples.csv 5행(en/ko/ja) + 직접 쓴 3행. 쉼표 없는 칸만 있으므로 단순 분할.
const [head, ...rows] = readFileSync(new URL('../examples.csv', import.meta.url), 'utf8').trim().split('\n').map((l) => l.split(','));
const col = (lang) => rows.map((r) => r[head.indexOf(lang)]);
const EXTRA = {
  en: ['We rewrote the parser twice before it felt right.', 'Most of our users run it from the terminal.', 'I think the hardest part was naming things.'],
  ko: ['파서는 마음에 들 때까지 두 번이나 다시 썼어요.', '사용자 대부분은 터미널에서 실행합니다.', '제일 어려웠던 건 이름 짓기였던 것 같아요.'],
  ja: ['パーサーは納得できるまで2回書き直しました。', 'ほとんどのユーザーはターミナルから実行しています。', '一番難しかったのは名前を付けることだったと思います。'],
};
const sents = (lang) => [...col(lang), ...EXTRA[lang]];
const tsv = (s, t, from = 0, to = 8) => sents(s).slice(from, to).map((x, i) => `${x}\t${sents(t)[from + i]}`).join('\n') + '\n';

async function importFile(s, t, how, from, to, suffix = '') {
  const content = tsv(s, t, from, to), display = `adaptive-check-${s}-${t}${suffix}.tsv`;
  let source;
  if (how === 'gcs') {
    execFileSync('gcloud', ['storage', 'cp', '-', `${BUCKET}/${display}`], { input: content, stdio: ['pipe', 'inherit', 'inherit'] });
    source = { gcsInputSource: { inputUri: `${BUCKET}/${display}` } };
  } else {
    source = { fileInputSource: { mimeType: 'text/tab-separated-values', content: Buffer.from(content), displayName: display } };
  }
  const t0 = Date.now();
  const [r] = await client.importAdaptiveMtFile({ parent: dsName(s, t), ...source });
  return { ms: Date.now() - t0, file: r.adaptiveMtFile?.name, entryCount: r.adaptiveMtFile?.entryCount };
}

async function translate(text, { s = 'en', t = 'ko', ds = dsName('en', 'ko'), glossary = false, ref = false } = {}) {
  const t0 = Date.now();
  const [r] = await client.adaptiveMtTranslate({
    parent, content: [text], mimeType: 'text/plain',
    ...(ds && { dataset: ds }),
    ...(ref && { referenceSentenceConfig: { referenceSentencePairLists: [{ referenceSentencePairs: sents(s).slice(0, 5).map((x, i) => ({ sourceSentence: x, targetSentence: sents(t)[i] })) }], sourceLanguageCode: s, targetLanguageCode: t } }),
    ...(glossary && { glossaryConfig: { glossary: GLOSSARY, ignoreCase: true, ...(glossary === 'ctx' && { contextualTranslationEnabled: true }) } }),
  });
  return { ms: Date.now() - t0, translations: (r.translations || []).map((x) => x.translatedText), glossaryTranslations: (r.glossaryTranslations || []).map((x) => x.translatedText), languageCode: r.languageCode };
}

const TEXTS = ['Poteto is the creator of pstack.', 'poteto is the creator of pstack.', 'The context window of this model is large.'];

if (cmd === 'create') {
  const t0 = Date.now();
  await run('create', async () => {
    const [d] = await client.createAdaptiveMtDataset({ parent, adaptiveMtDataset: { name: dsName(a1, a2), displayName: dsId(a1, a2).replaceAll('-', '_'), sourceLanguageCode: a1, targetLanguageCode: a2 } });
    return { ms: Date.now() - t0, name: d.name, exampleCount: d.exampleCount };
  });
  await run('import', () => importFile(a1, a2, a3 || 'inline', 0, 5));
  // 가져온 직후 바로 번역되는지
  if (a1 === 'en') await run('translate-right-after', () => translate(TEXTS[0], { s: a1, t: a2, ds: dsName(a1, a2) }));
  if (a1 === 'ko') await run('translate-right-after', () => translate('Poteto는 pstack의 제작자입니다.', { s: a1, t: a2, ds: dsName(a1, a2) }));
} else if (cmd === 'import') {
  // 같은 dataset에 추가 import: 누적인지 교체인지 exampleCount로 본다
  await run('import', () => importFile(a1, a2, a3 || 'inline', 5, 8, process.argv[6] ?? '-2')); // 6번째 인자 '' = 첫 파일과 같은 이름
  const [d] = await client.getAdaptiveMtDataset({ name: dsName(a1, a2) });
  console.log('dataset exampleCount', d.exampleCount);
} else if (cmd === 'list') {
  const [ds] = await client.listAdaptiveMtDatasets({ parent });
  for (const d of ds) console.log(JSON.stringify({ name: d.name, displayName: d.displayName, src: d.sourceLanguageCode, tgt: d.targetLanguageCode, exampleCount: d.exampleCount }));
} else if (cmd === 'delete') {
  // 시험용 check-* 데이터셋만 지운다(앱이 만든 ex-*는 건드리지 않음)
  const [ds] = await client.listAdaptiveMtDatasets({ parent });
  for (const d of ds.filter((x) => x.name.split('/').pop().startsWith('check-'))) {
    const t0 = Date.now();
    await run(`delete ${d.name.split('/').pop()}`, async () => { await client.deleteAdaptiveMtDataset({ name: d.name }); return { ms: Date.now() - t0 }; });
  }
} else if (cmd === 'files') {
  const [fs] = await client.listAdaptiveMtFiles({ parent: dsName(a1, a2) });
  for (const f of fs) console.log(JSON.stringify({ name: f.name, displayName: f.displayName, entryCount: f.entryCount }));
} else if (cmd === 'translate') {
  for (const text of TEXTS) {
    console.log(`\n# en->ko ${text}`);
    for (const g of [false, true, 'ctx']) await run(`dataset glossary=${g}`, () => translate(text, { glossary: g }));
  }
} else if (cmd === 'extra') {
  // contextual이 실제로 용어를 강제하는지: off 결과가 용어집 표기와 다른 문장 + 소문자 poteto 반복 + ko->en/ja
  for (const [text, s, t] of [['Matt Pocock and Lauren Tan work at SpaceX.', 'en', 'ko'], ['I met poteto and matt at spacex yesterday.', 'en', 'ko'], ['포테토와 매트는 컨텍스트 윈도우를 늘렸습니다.', 'ko', 'en'], ['Poteto는 pstack의 제작자입니다.', 'ko', 'en'], ['Poteto는 pstack의 제작자입니다.', 'ko', 'ja']]) {
    console.log(`\n# ${s}->${t} ${text}`);
    for (const g of [false, true, 'ctx']) await run(`glossary=${g}`, () => translate(text, { ds: dsName(s, t), glossary: g }));
  }
  console.log('\n# 소문자 poteto ctx 5회');
  for (let i = 0; i < 5; i++) await run('ctx', () => translate(TEXTS[1], { glossary: 'ctx' }));
} else if (cmd === 'tllm') {
  // 대안 비교용: 같은 문장을 TLLM contextual로 (translateText)
  for (const text of ['Matt Pocock and Lauren Tan work at SpaceX.', 'I met poteto and matt at spacex yesterday.', TEXTS[1]]) {
    const [r] = await client.translateText({ parent, contents: [text], sourceLanguageCode: 'en', targetLanguageCode: 'ko', mimeType: 'text/plain',
      model: `${parent}/models/general/translation-llm`, glossaryConfig: { glossary: GLOSSARY, ignoreCase: true, contextualTranslationEnabled: true } });
    console.log('tllm ctx', text, JSON.stringify(r.glossaryTranslations.map((x) => x.translatedText)));
  }
} else if (cmd === 'combos') {
  const x = TEXTS[0];
  await run('dataset+ref', () => translate(x, { ref: true }));
  await run('dataset+ref+glossary', () => translate(x, { ref: true, glossary: true }));
  await run('ref+glossary (no dataset, 재확인)', () => translate(x, { ds: null, ref: true, glossary: true }));
  if (config.PROJECT_NUMBER) await run('dataset(번호 경로)+glossary', () => translate(x, { ds: dsName('en', 'ko').replace(P, config.PROJECT_NUMBER), glossary: true }));
} else if (cmd === 'pair') {
  // 언어쌍 제약: en->ko dataset으로 다른 쌍 요청 (요청에는 언어 코드를 넣을 필드가 없다)
  await run('en-ko dataset, ko 원문', () => translate('Poteto는 pstack의 제작자입니다.', { s: 'ko', t: 'en' }));
  await run('en-ko dataset, ja 원문', () => translate('Potetoはpstackの作者です。', { s: 'ja', t: 'ko' }));
  await run('en-ko dataset, ref en->ja 함께', () => translate(TEXTS[0], { s: 'en', t: 'ja', ref: true }));
  await run('ko-ja dataset + glossary', () => translate('컨텍스트 윈도우 크기가 중요합니다.', { s: 'ko', t: 'ja', ds: dsName('ko', 'ja'), glossary: 'ctx' }));
} else if (cmd === 'latency') {
  for (const g of [true, 'ctx', false]) {
    const ms = [];
    for (let i = 0; i < 10; i++) ms.push((await translate(`Poteto is the creator of pstack. (${i})`, { glossary: g })).ms);
    console.log(`glossary=${g}`, 'median', median(ms), 'max', Math.max(...ms), JSON.stringify(ms));
  }
} else if (cmd === 'burst') {
  // 3개 병렬 × rounds, 대기 없음 (en->ko, ko->en, ko->ja dataset + glossary ctx)
  const rounds = Number(a1 || 10), all = [];
  let errs = 0;
  const t0 = Date.now();
  for (let i = 0; i < rounds; i++) {
    const res = await Promise.allSettled([
      translate(`Poteto is the creator of pstack. (${i})`, { glossary: 'ctx' }),
      translate(`Poteto는 pstack의 제작자입니다. (${i})`, { s: 'ko', t: 'en', ds: dsName('ko', 'en'), glossary: 'ctx' }),
      translate(`리뷰는 보통 하루 안에 끝냅니다. (${i})`, { s: 'ko', t: 'ja', ds: dsName('ko', 'ja'), glossary: 'ctx' }),
    ]);
    for (const r of res) if (r.status === 'fulfilled') all.push(r.value.ms); else { errs++; console.log('round', i, 'ERROR', r.reason.code, r.reason.message.slice(0, 160)); }
  }
  console.log(`burst: ${rounds * 3} calls in ${Date.now() - t0}ms, errors ${errs}, median ${median(all)}ms, max ${Math.max(...all)}ms`);
} else if (cmd === 'rest') {
  // REST 직접 호출로 snake_case 필드 이름 확인
  const token = await client.auth.getAccessToken();
  for (const gc of [{ glossary: GLOSSARY, ignoreCase: true }, { glossary: GLOSSARY, ignore_case: true, contextual_translation_enabled: true }]) {
    const r = await fetch(`https://translation.googleapis.com/v3/${parent}:adaptiveMtTranslate`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-goog-user-project': P },
      body: JSON.stringify({ dataset: dsName('en', 'ko'), content: [TEXTS[0]], mimeType: 'text/plain', glossaryConfig: gc }),
    });
    console.log('rest', JSON.stringify(gc), r.status, await r.text());
  }
} else {
  console.log('usage: create <src> <tgt> inline|gcs | import <src> <tgt> inline|gcs | list | delete | files <src> <tgt> | translate | extra | tllm | combos | pair | latency | burst [rounds] | rest');
}
