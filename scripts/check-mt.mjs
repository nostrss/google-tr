// 관문 C 점검: node scripts/check-mt.mjs compare | pairs | latency | adaptive | burst [rounds]
// Translation LLM(translateText + model translation-llm)과 Adaptive Translation(adaptiveMtTranslate, 인라인 예문)
import config from '../config.js'; // .env를 Google 클라이언트보다 먼저 읽는다
import { TranslationServiceClient } from '@google-cloud/translate';

config.requireProject();
const P = config.PROJECT, LOC = 'us-central1', parent = `projects/${P}/locations/${LOC}`;
const GLOSSARY = `${parent}/glossaries/${config.GLOSSARY_ID}`;
const client = new TranslationServiceClient();
const [cmd, arg] = process.argv.slice(2);
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

// 시험용 예문 5쌍(개발자 인터뷰 문체, 직접 쓴 초안)
const EX = {
  ko: ['오늘은 Poteto와 함께 pstack을 만든 이야기를 나눠 보겠습니다.', '처음에는 CLI 도구 하나로 시작했어요.', '컨텍스트 윈도우가 커지면서 설계가 많이 바뀌었습니다.', 'PR 리뷰는 보통 하루 안에 끝내려고 합니다.', '사실 저도 그 부분은 아직 고민 중이에요.'],
  en: ["Today we're talking with Poteto about building pstack.", 'It started out as a single CLI tool.', 'As the context window grew, the design changed a lot.', 'We usually try to finish PR reviews within a day.', "Honestly, I'm still thinking about that part myself."],
  ja: ['今日はPotetoさんと一緒に、pstackを作った話をしていきます。', '最初はCLIツール一つから始めました。', 'コンテキストウィンドウが大きくなるにつれて、設計が大きく変わりました。', 'PRレビューは普段、一日以内に終わらせるようにしています。', '正直、その部分は私もまだ悩んでいるところです。'],
};
const pairs = (s, t) => EX[s].map((x, i) => ({ sourceSentence: x, targetSentence: EX[t][i] }));

async function tllm(text, s, t, mode) { // mode: off | on | ctx
  const t0 = Date.now();
  const [r] = await client.translateText({
    parent, contents: [text], sourceLanguageCode: s, targetLanguageCode: t, mimeType: 'text/plain',
    model: `${parent}/models/general/${mode === 'nmt-off' || mode === 'nmt-on' ? 'nmt' : 'translation-llm'}`,
    ...(mode !== 'off' && mode !== 'nmt-off' && { glossaryConfig: { glossary: GLOSSARY, ignoreCase: true, ...(mode === 'ctx' && { contextualTranslationEnabled: true }) } }),
  });
  return { ms: Date.now() - t0, translations: r.translations.map((x) => x.translatedText), glossaryTranslations: r.glossaryTranslations.map((x) => x.translatedText) };
}
async function adaptive(text, s, t, glossary) {
  const t0 = Date.now();
  const [r] = await client.adaptiveMtTranslate({
    parent, content: [text], mimeType: 'text/plain',
    referenceSentenceConfig: { referenceSentencePairLists: [{ referenceSentencePairs: pairs(s, t) }], sourceLanguageCode: s, targetLanguageCode: t },
    ...(glossary && { glossaryConfig: { glossary: GLOSSARY, ignoreCase: true, ...(glossary === 'ctx' && { contextualTranslationEnabled: true }) } }),
  });
  return { ms: Date.now() - t0, translations: (r.translations || []).map((x) => x.translatedText), glossaryTranslations: (r.glossaryTranslations || []).map((x) => x.translatedText), languageCode: r.languageCode };
}
const run = async (label, f) => { try { console.log(label, JSON.stringify(await f())); } catch (e) { console.log(label, 'ERROR', e.code, e.message); } };

const CASES = [
  ['Poteto is the creator of pstack.', 'en', 'ko'],
  ['The context window of this model is large.', 'en', 'ko'],
  ['Poteto는 pstack의 제작자입니다.', 'ko', 'en'],
  ['컨텍스트 윈도우를 늘렸습니다.', 'ko', 'en'],
  ['컨텍스트 윈도우 크기가 중요합니다.', 'ko', 'ja'],
];

if (cmd === 'compare') {
  for (const [text, s, t] of CASES) {
    console.log(`\n# ${s}->${t} ${text}`);
    for (const m of ['nmt-off', 'nmt-on', 'off', 'on', 'ctx']) await run(`tllm:${m}`, () => tllm(text, s, t, m));
  }
} else if (cmd === 'pairs') {
  for (const [s, t] of [['zh-CN', 'de'], ['hi', 'ru'], ['es', 'fr'], ['pt', 'ja'], ['ru', 'ko'], ['de', 'hi']])
    await run(`tllm ${s}->${t}`, () => tllm({ 'zh-CN': '上下文窗口很大。', hi: 'संदर्भ विंडो बड़ी है।', es: 'La ventana de contexto es grande.', pt: 'A janela de contexto é grande.', ru: 'Контекстное окно большое.', de: 'Das Kontextfenster ist groß.' }[s], s, t, 'off'));
} else if (cmd === 'latency') {
  for (const m of ['nmt-off', 'off', 'ctx']) {
    const ms = [];
    for (let i = 0; i < 10; i++) ms.push((await tllm(`Poteto is the creator of pstack. (${i})`, 'en', 'ko', m)).ms);
    console.log(m, 'median', median(ms), 'max', Math.max(...ms), JSON.stringify(ms));
  }
} else if (cmd === 'adaptive') {
  for (const [text, s, t] of [['Poteto is the creator of pstack.', 'en', 'ko'], ['컨텍스트 윈도우를 늘렸습니다.', 'ko', 'en'], ['컨텍스트 윈도우 크기가 중요합니다.', 'ko', 'ja'], ['The context window of this model is large.', 'en', 'ja']]) {
    console.log(`\n# ${s}->${t} ${text}`);
    for (const g of [false, true, 'ctx']) await run(`adaptive glossary=${g}`, () => adaptive(text, s, t, g));
  }
} else if (cmd === 'burst') {
  // 대상 3개 병렬 × rounds회, 라운드 사이 대기 없음
  const rounds = Number(arg || 5), all = [];
  let errs = 0;
  const t0 = Date.now();
  for (let i = 0; i < rounds; i++) {
    const res = await Promise.allSettled([['en', 'ko'], ['en', 'ja'], ['ko', 'ja']].map(([s, t]) => adaptive(`We usually try to finish reviews within a day. (${i})`.replace('We usually try to finish reviews within a day.', s === 'ko' ? '리뷰는 보통 하루 안에 끝냅니다.' : 'We usually try to finish reviews within a day.'), s, t, false)));
    for (const r of res) if (r.status === 'fulfilled') all.push(r.value.ms); else { errs++; console.log('round', i, 'ERROR', r.reason.code, r.reason.message.slice(0, 120)); }
  }
  console.log(`burst: ${rounds * 3} calls in ${Date.now() - t0}ms, errors ${errs}, median ${median(all)}ms, max ${Math.max(...all)}ms`);
} else {
  console.log('usage: compare | pairs | latency | adaptive | burst [rounds]');
}
