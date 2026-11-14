// 용어집 CSV 검사 자체 점검: node scripts/check-csv.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { parseGlossaryCsv } = createRequire(import.meta.url)('../server.js');

const H = 'en,zh-CN,es,hi,pt,ru,ja,ko,fr,de';
const row = (v) => Array(10).fill(v).join(',');
const ok = (s) => parseGlossaryCsv(Buffer.isBuffer(s) ? s : Buffer.from(s));
const bad = (s, re) => assert.throws(() => ok(s), re);

// 정상: (인자로 준 실제 CSV), BOM + CRLF + 빈 줄, 순서가 다른 헤더, 칸 앞뒤 공백, 일부 빈 칸
if (process.argv[2]) console.log(process.argv[2], '용어', ok(readFileSync(process.argv[2])).terms.length, '개');
const r = ok(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${H}\r\n\r\n ${row('A')} \r\n`)]));
assert.equal(r.terms.length, 1);
assert.equal(r.csv, `${H}\n${row('A')}\n`);
assert.equal(ok(`de,fr,ko,ja,ru,pt,hi,es,zh-CN,en\n${row('B')}\n`).terms[0].en, 'B');
assert.equal(ok(`${H}\nVertex AI,,,,,,,,,\n`).terms[0].ko, '');

// 오류: 행 번호가 붙는다
bad(Buffer.from([0x82, 0xa0, 0x0a]), /UTF-8 파일이 아닙니다/); // Shift-JIS 'あ'
bad('', /빈 파일/);
bad(`${H}\n\n`, /용어 행이 없습니다/);
bad(`en,zh-CN,es,hi,pt,ru,ja,ko,fr\n${row('A')}`, /1행: 헤더/);
bad(`en,en,es,hi,pt,ru,ja,ko,fr,de\n${row('A')}`, /1행: 헤더/);
bad(`${H},pos\n${row('A')},n`, /1행: 헤더/);
bad(`${H}\n${row('A')}\n"a,b",b,c,d,e,f,g,h,i,j`, /3행: 따옴표/);
bad(`${H}\n${row('A')}\nA,A,A,A,A,A,A,A,A`, /3행: 열이 9개입니다\(10개 필요\)/);
bad(`${H}\n${row('')}`, /2행: 모든 칸이 비어/);
bad(`${H}\n${row('a'.repeat(1024))}`, /2행 en 열: 칸이 1,024바이트/);
bad(`${H}\n${Array(1001).fill(row('A')).join('\n')}`, /1001개입니다\(최대 1,000개\)/);
console.log('check-csv: all assertions passed');
