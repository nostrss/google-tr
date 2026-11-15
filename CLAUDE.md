# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 무엇인가

브라우저 마이크 음성을 실시간으로 받아 원문 자막과 3개 이상 언어의 번역을 한 화면에 보여주는 프로토타입이다. Google Speech-to-Text v2(스트리밍)와 Cloud Translation v3(NMT / Translation LLM / Adaptive, glossary)를 쓴다. 문서와 주석, 화면 문구는 모두 한국어다.

- `GUIDE.md`: 화면 옵션 조합별로 어떤 API를 어떻게 호출하는지, 사용법, 알려진 한계. 동작을 바꾸면 함께 고친다.
- `PLAN.md`: 기획서이자 실제 호출로 확인한 사실의 기록(9절). 일부 절은 코드보다 오래됐다. 다르면 코드가 기준이다.
- `PLAN-3modes.md`, `mockup.html`: 초기 기획서와 화면 시안. 참고용이며 앱이 읽지 않는다.

## 명령

```bash
npm start                      # http://localhost:8080 (PORT로 변경). Chrome에서 연다
node scripts/check-csv.mjs     # 용어집 CSV 검사 로직 자체 점검. GCP를 호출하지 않는 유일한 점검
```

빌드, 린트, 테스트 프레임워크는 없다. 나머지 점검 스크립트는 실제 GCP를 호출하고 일부는 리소스를 만들거나 바꾼다. 사용법은 각 파일 첫 줄 주석에 있다.

```bash
# 서버를 띄운 상태에서 WAV(16kHz mono Int16)를 WebSocket으로 흘려 서버 경로 전체를 확인한다
MT=llm GLOSSARY_MODE=forced MODEL=long node scripts/check-ws.mjs <wav> en ko,ja,es [ws://localhost:8080]
STT_ROTATE_MS=4000 npm start   # 스트림 교체를 짧은 간격으로 시험할 때만
```

- `check-translate.mjs`(glossary 생성·PATCH), `check-mt.mjs`(TLLM·Adaptive 인라인), `check-adaptive-dataset.mjs`(dataset), `check-stt.mjs`(STT 단독)는 API 동작을 확정하려고 쓴 스크립트다. `create`, `patch`, `import`, `delete` 하위 명령은 실제 리소스를 바꾼다.
- 시험용 음성은 macOS `say`와 `afconvert`로 만든다. 저장소에는 음성 파일이 없다.
- 브라우저 마이크 경로는 자동으로 확인할 수 없다. 사람 목소리로는 아직 검증되지 않았다.

## 환경

- 인증은 ADC를 쓴다(`gcloud auth application-default login`, quota project 지정). 키 파일을 만들거나 저장소에 두지 않는다.
- GCP 값은 환경 변수나 저장소 루트 `.env`(`.env.example` 참고, 커밋하지 않음)로 정하고 `config.js`가 읽는다. 서버와 점검 스크립트 모두 이것을 쓴다: `GOOGLE_CLOUD_PROJECT`(필수, 현재 `gtr-923548`), `GLOSSARY_BUCKET`(기본 `<프로젝트>-glossary`), `GLOSSARY_ID`(기본 `conf-terms`). 리전 `us-central1`, STT `us-speech.googleapis.com`의 기본 recognizer `_`는 코드 상수다. 새 프로젝트 준비 절차는 `SETUP.md`.
- 서비스 계정 키를 쓸 때는 `GOOGLE_APPLICATION_CREDENTIALS`(표준 변수)를 `.env`나 환경 변수로 준다. 키 파일은 저장소에 두지 않는다.
- 앱이 만드는 GCP 리소스: 버킷의 `glossary-<시각>.csv`, Adaptive dataset `ex-<원문>-<대상>`.

## 구조

코드는 `server.js`(Express 정적 파일 + `ws` + HTTP `/glossary`)와 `public/index.html`(순수 HTML/JS, AudioWorklet 포함) 두 파일이다. 프레임워크, 빌드 단계, TypeScript, 추상화 계층을 일부러 두지 않았다. 의도적으로 단순화한 곳에는 `// ponytail:` 주석으로 한계와 개선 방향을 적는다.

### 데이터 흐름

브라우저가 16kHz PCM 100ms 조각을 WebSocket 바이너리 프레임으로 보내고, 제어는 JSON 텍스트 프레임(`start` / `settings` / `stop`)으로 보낸다. 서버의 `session()`이 연결마다 STT 스트림을 열고, interim과 final 원문마다 대상 언어별로 `machineTranslate()`를 호출해 `interim` / `final` / `translation` / `error` / `vad` / `dataset` / `started` 메시지로 돌려준다.

- `start`에서만 정해지는 것: 원문·대상 언어, 인식 모델. 바꾸려면 정지 후 다시 시작해야 한다(STT 스트림을 새로 연다).
- `settings`로 진행 중에 바뀌는 것: 용어집 적용, 용어집 적용 방식, 번역 모델, 중간 번역. 다음 번역 호출부터 반영된다.
- 허용 목록(`STT_MODELS`, `MT_MODELS`, `GLOSSARY_MODES`, `LANGS`)에 없는 값은 서버가 기본값으로 바꾼다. 언어 10종과 `long`의 구문 힌트 불가 언어(`NO_HINTS`)는 `server.js`와 `public/index.html` 양쪽에 같은 목록이 있다. 한쪽을 고치면 다른 쪽도 고친다.

### 번역 분기 (`machineTranslate`)

번역 모델과 용어집 설정에 따라 호출이 네 갈래로 나뉜다.

| 번역 모델 | 용어집 | 호출 |
|---|---|---|
| `nmt`, `llm` | 끔 / 켬 | `translateText` + `model` 경로(`general/nmt`, `general/translation-llm`), 켬이면 `glossaryConfig` |
| `adaptive` | 끔 | `adaptiveMtTranslate` + 인라인 예문(`referenceSentenceConfig`, `examples.csv`의 두 열) |
| `adaptive` | 켬 | `adaptiveMtTranslate` + `dataset`(`ex-*`) + `glossaryConfig`. 호출당 약 2초 |

이 분기가 생긴 이유는 API 제약이다. 고치기 전에 알아야 할 것:

- 인라인 예문과 `glossaryConfig`는 함께 쓸 수 없다(`Persistent dataset is null`). `dataset`과 `referenceSentenceConfig`도 함께 쓸 수 없다.
- 문맥형(`contextualTranslationEnabled`)은 NMT에서 400으로 거부된다. 그래서 NMT는 항상 강제 적용이다.
- 문맥형은 용어를 강제하지 않는다. 강제 적용은 용어를 지키지만 한국어에서 조사 앞 공백과 조사 누락이 생긴다. 번역 결과를 서버에서 보정하지 않기로 했다(HTML 엔티티 복원 `unesc`만 예외).
- 응답 형태가 경우마다 다르다. 강제 적용은 `translations`(적용 전)와 `glossaryTranslations`(적용 후)가 함께 오고, 문맥형은 `translations`가 비어 온다. 용어 강조(`translateOne`의 `changed`)는 이 차이에 의존한다.
- `updateGlossary`의 마스크 경로는 `input_config`만 된다. camelCase는 gRPC에서 거부된다.
- STT v2 스트리밍은 라이브러리 헬퍼가 v1 형식이라 `_streamingRecognize()`에 객체를 직접 쓴다. 첫 메시지에 `recognizer`와 `streamingConfig`를 넣는다.

### 중간 번역과 발화 번호

- 발화 번호(`id`)는 STT 스트림마다 진행 중 발화에 붙이고 final에서 닫는다. 4분 30초 스트림 교체(`ROTATE_MS`) 때 이전 스트림의 final과 새 스트림의 interim이 겹쳐도 섞이지 않게 하려는 것이다.
- 중간 번역은 언어별 대기열(`queues`)로 동시에 1개, 최소 간격 `INTERIM_GAP_MS`, 최신 텍스트만 번역한다. 확정된 발화(`done`)의 늦은 중간 번역은 버린다.
- `adaptive` + 용어집에서는 호출이 느려 중간 번역을 하지 않는다(`interimOn`). 화면의 체크박스 값은 보존한다.
- 브라우저는 재연결할 때 같은 `start`를 다시 보내고, 서버의 `id`가 1부터 다시 시작하므로 연결 번호를 붙여 줄을 구분한다.

### 용어집

- 용어 목록의 출처는 로컬 파일이 아니라 glossary가 가리키는 버킷의 CSV다(`loadGlossary`). `start` 때마다 읽어 STT 구문 힌트(원문 언어 열)와 용어 강조(대상 언어 열)에 쓴다. 저장소 루트의 `glossary.csv`는 보관용 사본이다.
- `POST /glossary`: `parseGlossaryCsv`로 검사 → 버킷에 새 이름으로 저장 → `updateGlossary`(LRO) 완료까지 요청을 열어 둔다. 실패해도 glossary의 `inputUri`는 새 값으로 남기 때문에 직전 URI로 다시 PATCH해 되돌린다.
- `parseGlossaryCsv`는 CSV 파서 없이 쉼표로만 나눈다. 따옴표와 칸 안의 쉼표를 받지 않는다. `examples.csv`도 같은 함수로 읽는다(최대 5행, dataset 방식은 언어쌍당 5쌍 필요).
- 교체 중 플래그(`gl`)와 dataset 준비 상태(`datasets`)는 프로세스 메모리에만 있다. `examples.csv`를 바꿔도 이미 만든 dataset은 갱신되지 않는다.

## 배포

Cloud Run 소스 배포를 `PLAN.md` 8절에 정리해 뒀지만 아직 하지 않았다. 배포하면 인증 없는 공개 주소가 되고 사용량만큼 과금되며 누구나 용어집을 바꿀 수 있다. 사용자 확인 없이 배포하거나 서비스 계정·IAM을 만들지 않는다.
