// 서버 경로 점검: [MT=nmt|llm|adaptive] [SWITCH_MT=llm] [GLOSSARY=0] [GLOSSARY_MODE=forced|contextual] [MODEL=long|chirp_3] [INTERIM=0] [OFF_AFTER=1(0=안 끔)] [SWITCH_GLOSSARY=1(전환 때 용어집 유지)] [SWITCH_GLOSSARY_MODE=contextual] node scripts/check-ws.mjs <wav> <source> <t1,t2,t3> [url]
// start(glossary on) → WAV를 100ms 조각으로 실시간 전송 → OFF_AFTER번째 final 뒤 settings(glossary off, SWITCH_MT가 있으면 번역 모델도 바꿈) → stop
// interim/중간 번역은 한 줄로 줄여 찍고, 끝에 언어별 요약(중간 번역 수, 첫 표시 시각, 간격, 순서 위반)과 확정 번역 목록(텍스트·강조 용어·ms)을 낸다
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const [wav, source, targets, url = 'ws://localhost:8080'] = process.argv.slice(2);
const glossaryMode = process.env.GLOSSARY_MODE || 'forced', mt = process.env.MT || 'nmt', switchMt = process.env.SWITCH_MT, model = process.env.MODEL || 'long', interim = process.env.INTERIM !== '0', offAfter = Number(process.env.OFF_AFTER ?? 1);
const b = readFileSync(wav);
let o = 12;
while (b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
const pcm = Buffer.concat([b.subarray(o + 8, o + 8 + b.readUInt32LE(o + 4)), Buffer.alloc(32000 * 3)]); // 뒤에 무음 3초

let t0 = Date.now();
const at = () => (Date.now() - t0) / 1000, fmt = () => at().toFixed(2).padStart(6);
const ws = new WebSocket(url);
let finals = 0;
const tr = {}; // lang -> { times: [], finalIds: Set, violations }
ws.on('open', () => ws.send(JSON.stringify({ type: 'start', source, targets: targets.split(','), glossary: process.env.GLOSSARY !== '0', interim, model, mt, glossaryMode })));
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'interim') console.log(`[${fmt()}s] interim #${m.id} ${JSON.stringify(m.text)}`);
  else if (m.type === 'translation' && m.interim) console.log(`[${fmt()}s]   ~${m.lang} #${m.id} ${JSON.stringify(m.text)} ${m.mt} ${m.ms}ms`);
  else if (m.type !== 'vad') console.log(`[${fmt()}s]`, JSON.stringify(m));
  if (m.type === 'translation') {
    const s = (tr[m.lang] ??= { times: [], ms: [], finalIds: new Set(), violations: 0, mts: {}, finals: [] });
    if (m.interim) { s.times.push(at()); s.ms.push(m.ms); if (s.finalIds.has(m.id)) s.violations++; }
    else { s.finalIds.add(m.id); s.finals.push(`#${m.id} ${JSON.stringify(m.text)} terms=${JSON.stringify(m.terms)} ${m.mt}${m.contextual ? '+ctx' : ''} ${m.ms}ms`); }
    s.mts[m.mt] = (s.mts[m.mt] || 0) + 1;
  }
  if (m.type === 'started') {
    t0 = Date.now(); // 시각은 오디오 전송 시작 기준
    let off = 0;
    const timer = setInterval(() => {
      if (off >= pcm.length) {
        clearInterval(timer);
        ws.send(JSON.stringify({ type: 'stop' }));
        console.log(`[${fmt()}s] -> stop`);
        setTimeout(() => ws.close(), 4000);
        return;
      }
      ws.send(pcm.subarray(off, off + 3200));
      off += 3200;
    }, 100);
  }
  if (m.type === 'final' && ++finals === offAfter) {
    const keep = process.env.SWITCH_GLOSSARY === '1';
    const switchMode = process.env.SWITCH_GLOSSARY_MODE;
    ws.send(JSON.stringify({ type: 'settings', glossary: keep, ...(switchMt && { mt: switchMt }), ...(switchMode && { glossaryMode: switchMode }) }));
    console.log(`[${fmt()}s] -> settings glossary:${keep}${switchMt ? ` mt:${switchMt}` : ''}${switchMode ? ` glossaryMode:${switchMode}` : ''} (다음 번역 호출부터)`);
  }
});
ws.on('close', () => {
  for (const [lang, s] of Object.entries(tr)) {
    const gaps = s.times.slice(1).map((t, i) => t - s.times[i]);
    const avg = gaps.length ? (gaps.reduce((a, x) => a + x, 0) / gaps.length).toFixed(2) : '-';
    const avgMs = s.ms.length ? Math.round(s.ms.reduce((a, x) => a + x, 0) / s.ms.length) : '-';
    for (const f of s.finals) console.log(`final ${lang} ${f}`);
    console.log(`summary ${lang}: interim translations ${s.times.length}, first at ${s.times[0]?.toFixed(2) ?? '-'}s, avg gap ${avg}s, interim avg ${avgMs}ms, final translations ${s.finalIds.size}, interim-after-final ${s.violations}, by model ${JSON.stringify(s.mts)}`);
  }
  console.log(`[${fmt()}s] closed`);
});
ws.on('error', (e) => console.log('ws error', e.message));
