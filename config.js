// GCP 설정: 환경 변수, 없으면 저장소 루트 .env에서 읽는다(.env.example 참고).
// process.loadEnvFile은 이미 설정된 환경 변수를 덮어쓰지 않는다(셸·Cloud Run의 값이 .env보다 우선, Node v24 실행 확인).
// .env에 GOOGLE_APPLICATION_CREDENTIALS를 적어도 되도록 Google 클라이언트를 만들기 전에 이 파일을 먼저 불러야 한다.
// 리전(us-central1), STT 엔드포인트(us-speech.googleapis.com), recognizer `_`는 API 제약이라 코드 상수로 둔다.
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '.env')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT;

// GCP를 실제로 부르기 직전에 호출한다(scripts/check-csv.mjs처럼 server.js만 require하는 경우는 설정 없이 돈다)
function requireProject() {
  if (PROJECT) return;
  console.error('GOOGLE_CLOUD_PROJECT(프로젝트 ID)가 설정되지 않았습니다.\n'
    + '저장소 루트에서 `cp .env.example .env` 후 .env의 GOOGLE_CLOUD_PROJECT를 채우거나 환경 변수로 지정하세요(SETUP.md).');
  process.exit(1);
}

module.exports = {
  PROJECT,
  BUCKET: process.env.GLOSSARY_BUCKET || `${PROJECT}-glossary`,
  GLOSSARY_ID: process.env.GLOSSARY_ID || 'conf-terms',
  // 프로젝트 번호 형식 경로를 시험하는 점검 스크립트에서만 쓴다. 없으면 그 시험을 건너뛴다
  PROJECT_NUMBER: process.env.GOOGLE_CLOUD_PROJECT_NUMBER,
  requireProject,
};
