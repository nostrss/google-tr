// 관문 A 점검: node scripts/check-translate.mjs create | get | translate [projectRef] | patch <gs-uri> [mask] | patch-race <gs-uri>
//   create: 저장소 루트 glossary.csv를 검사해 버킷의 glossary.csv로 올리고 glossary를 처음 만든다(이미 있으면 실패)
import config from '../config.js'; // .env를 Google 클라이언트보다 먼저 읽는다
import { TranslationServiceClient } from '@google-cloud/translate';
import { Storage } from '@google-cloud/storage';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

config.requireProject();
const P = config.PROJECT, NUM = config.PROJECT_NUMBER, LOC = 'us-central1'; // NUM이 없으면 번호 경로 시험을 건너뛴다
const client = new TranslationServiceClient();
const parent = `projects/${P}/locations/${LOC}`;
const gname = (ref = P) => `projects/${ref}/locations/${LOC}/glossaries/${config.GLOSSARY_ID}`;
const LANGS = ['en', 'zh-CN', 'es', 'hi', 'pt', 'ru', 'ja', 'ko', 'fr', 'de'];
const [cmd, a1, a2] = process.argv.slice(2);
const t0 = () => { const s = Date.now(); return () => Date.now() - s; };

async function get() {
  const [g] = await client.getGlossary({ name: gname() });
  console.log(JSON.stringify({ name: g.name, entryCount: g.entryCount, inputUri: g.inputConfig?.gcsSource?.inputUri,
    languageCodes: g.languageCodesSet?.languageCodes, submitTime: ts(g.submitTime), endTime: ts(g.endTime) }));
  return g;
}
const ts = (t) => t && new Date(Number(t.seconds) * 1000 + (t.nanos || 0) / 1e6).toISOString();

async function tr(text, src, tgt, glossary, { ref = P, model = true, glossRef = P } = {}) {
  const el = t0();
  const req = { parent: `projects/${ref}/locations/${LOC}`, contents: [text], sourceLanguageCode: src, targetLanguageCode: tgt, mimeType: 'text/plain' };
  if (model) req.model = `projects/${ref}/locations/${LOC}/models/general/nmt`;
  if (glossary) req.glossaryConfig = { glossary: gname(glossRef), ignoreCase: true };
  try {
    const [r] = await client.translateText(req);
    console.log(JSON.stringify({ src, tgt, glossary, text, ms: el(),
      translations: r.translations.map((x) => x.translatedText),
      glossaryTranslations: r.glossaryTranslations.map((x) => x.translatedText) }));
  } catch (e) { console.log(JSON.stringify({ src, tgt, glossary, text, ms: el(), error: e.message })); }
}

if (cmd === 'create') {
  const el = t0();
  // 이미 있으면 버킷의 glossary.csv(현재 inputUri일 수 있음)를 덮어쓰기 전에 멈춘다
  const exists = await client.getGlossary({ name: gname() }).then(() => true, (e) => { if (e.code === 5) return false; throw e; });
  if (exists) { console.log(`이미 있습니다: ${gname()} (용어 변경은 화면의 용어집 업로드로)`); process.exit(1); }
  // 서버의 업로드와 같은 검사·정리를 거친 CSV를 올린다
  const { parseGlossaryCsv } = createRequire(import.meta.url)('../server.js');
  const { csv, terms } = parseGlossaryCsv(readFileSync(new URL('../glossary.csv', import.meta.url)));
  await new Storage().bucket(config.BUCKET).file('glossary.csv').save(csv, { contentType: 'text/csv; charset=utf-8' });
  console.log('uploaded', `gs://${config.BUCKET}/glossary.csv`, 'terms', terms.length);
  const [op] = await client.createGlossary({ parent, glossary: { name: gname(),
    languageCodesSet: { languageCodes: LANGS }, inputConfig: { gcsSource: { inputUri: `gs://${config.BUCKET}/glossary.csv` } } } });
  console.log('op', op.name);
  const [g] = await op.promise();
  console.log('done ms', el(), 'entryCount', g.entryCount);
  await get();
} else if (cmd === 'get') {
  await get();
} else if (cmd === 'translate') {
  // 경로 형식 점검
  await tr('Poteto is the creator of pstack.', 'en', 'ko', true, { glossRef: P });
  if (NUM) await tr('Poteto is the creator of pstack.', 'en', 'ko', true, { ref: NUM, glossRef: NUM });
  await tr('Poteto is the creator of pstack.', 'en', 'ko', false, { model: false });
  // 본 비교
  const cases = [
    ['Poteto is the creator of pstack.', 'en', 'ko'],
    ['poteto is the creator of pstack.', 'en', 'ko'],
    ['Potato is the creator of pstack.', 'en', 'ko'],
    ['The context window of this model is large.', 'en', 'ko'],
    ['Poteto는 pstack의 제작자입니다.', 'ko', 'en'],
    ['Poteto는 pstack의 제작자입니다.', 'ko', 'ja'],
    ['포테토는 pstack의 제작자입니다.', 'ko', 'en'],
    ['컨텍스트 윈도우를 늘렸습니다.', 'ko', 'en'],
    ['컨텍스트 윈도우 크기가 중요합니다.', 'ko', 'en'],
  ];
  for (const [t, s, d] of cases) { await tr(t, s, d, false); await tr(t, s, d, true); }
} else if (cmd === 'patch' || cmd === 'patch-race') {
  const el = t0();
  await get();
  const [op] = await client.updateGlossary({ glossary: { name: gname(), inputConfig: { gcsSource: { inputUri: a1 } } },
    updateMask: { paths: [a2 || 'input_config'] } });
  console.log('op', op.name, 'returned ms', el());
  if (cmd === 'patch-race') {
    // 진행 중 번역 3회
    for (let i = 0; i < 3; i++) { await get().catch((e) => console.log('get err', e.message)); await tr('Poteto is the creator of pstack.', 'en', 'ko', true); }
  }
  try { const [g] = await op.promise(); console.log('done ms', el(), 'entryCount', g.entryCount); }
  catch (e) { console.log('FAILED ms', el(), e.code, e.message); }
  await get();
  await tr('Poteto is the creator of pstack.', 'en', 'ko', true);
} else {
  console.log('usage: create | get | translate | patch <gs-uri> [mask] | patch-race <gs-uri>');
}
