// 관문 B 점검: node scripts/check-stt.mjs <wav> <lang> [hint|nohint] [reopenSec]
//   wav가 '-'면 오디오 없이 설정 수락 여부만 본다(무음 1초).
//   reopenSec를 주면 그 초마다 스트림을 닫고 새로 연다.
import { readFileSync } from 'node:fs';
import speech from '@google-cloud/speech';

const [wav, lang = 'en-US', hint = 'nohint', reopenSec] = process.argv.slice(2);
const client = new speech.v2.SpeechClient({ apiEndpoint: 'us-speech.googleapis.com' });
const recognizer = 'projects/gtr-923548/locations/us/recognizers/_';
const PHRASES = ['Poteto', 'pstack', 'context window', '컨텍스트 윈도우', 'PR', 'CLI'];

// WAV의 data 청크만 꺼낸다(16kHz mono Int16 전제)
let pcm = Buffer.alloc(32000);
if (wav !== '-') {
  const b = readFileSync(wav);
  let o = 12;
  while (b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
  pcm = b.subarray(o + 8, o + 8 + b.readUInt32LE(o + 4));
}
pcm = Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 4)]); // 뒤에 무음 4초

// 발화 구간(100ms 창 RMS) — final 지연 측정용
const segs = [];
for (let i = 0, on = null, quiet = 0; i < pcm.length; i += 3200) {
  let s = 0; const n = Math.min(1600, (pcm.length - i) >> 1);
  for (let k = 0; k < n; k++) s += pcm.readInt16LE(i + 2 * k) ** 2;
  const loud = Math.sqrt(s / n) > 300, t = i / 32000;
  if (loud) { if (on === null) on = t; quiet = 0; }
  else if (on !== null && ++quiet >= 4) { segs.push([on, +(t - 0.3).toFixed(1)]); on = null; }
}
console.log('speech segments (s):', JSON.stringify(segs));

const config = {
  explicitDecodingConfig: { encoding: 'LINEAR16', sampleRateHertz: 16000, audioChannelCount: 1 },
  languageCodes: [lang],
  model: process.env.MODEL || 'chirp_3', // MODEL은 원인 진단용 비교에만 쓴다
};
if (hint === 'hint') config.adaptation = { phraseSets: [{ inlinePhraseSet: { phrases: PHRASES.map((value) => ({ value, boost: 10 })) } }] };

const start = Date.now();
const at = () => ((Date.now() - start) / 1000).toFixed(2);
let n = 0;
function open() {
  const id = ++n;
  const s = client._streamingRecognize();
  s.on('data', (r) => {
    for (const x of r.results || []) console.log(`[${at()}s #${id}] ${x.isFinal ? 'FINAL  ' : 'interim'} ${JSON.stringify(x.alternatives?.[0]?.transcript)} stab=${x.stability?.toFixed?.(2)} end=${x.resultEndOffset?.seconds ?? 0}.${String((x.resultEndOffset?.nanos ?? 0) / 1e6 | 0).padStart(3, '0')}`);
    if (r.speechEventType && r.speechEventType !== 'SPEECH_EVENT_TYPE_UNSPECIFIED') console.log(`[${at()}s #${id}] event ${r.speechEventType}`);
  });
  s.on('error', (e) => console.log(`[${at()}s #${id}] ERROR ${e.code} ${e.message}`));
  s.on('end', () => console.log(`[${at()}s #${id}] stream end`));
  s.write({ recognizer, streamingConfig: { config, streamingFeatures: { interimResults: true, enableVoiceActivityEvents: !!process.env.VAD } } });
  return s;
}

let stream = open(), off = 0, last = Date.now();
const timer = setInterval(() => {
  if (off >= pcm.length) { clearInterval(timer); stream.end(); console.log(`[${at()}s] audio sent, input closed`); return; }
  if (reopenSec && Date.now() - last >= reopenSec * 1000) { stream.end(); stream = open(); last = Date.now(); console.log(`[${at()}s] reopened`); }
  stream.write({ audio: pcm.subarray(off, off + 3200) });
  off += 3200;
}, 100);
