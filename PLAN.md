# 실시간 다국어 자막 프로토타입 기획서 (NMT 전용)

작성일: 2026-11-14. 번역 방식 3종(NMT / Translation LLM / Adaptive)을 다루던 이전 기획서는 `PLAN-3modes.md`에 그대로 보존했다. 이 문서는 범위를 **Google NMT 번역만**으로 줄인 것이다. 문서 확인 결과는 각 항목 옆에 출처 URL을 달았고, 문서로 확인하지 못한 내용은 **미확인**으로 표기했다.

2026-11-15: 웹 화면에서 용어집 CSV를 올려 교체하는 기능을 추가했다(5.2절).

2026-11-15(추가): 말하는 도중의 중간(interim) 번역과 화면의 인식 모델 선택(`long`/`chirp_3`, 기본 `long`)을 추가했다(2·3·4.1·4.2·10절).

2026-11-15(실행): 미확인 API 동작을 실제 호출로 확인했고(관문 A: 번역·glossary, 관문 B: STT), 로컬 본구현(7절 1~10단계)을 마쳤다. "확인됨(2026-11-15 실행)"으로 표시한 항목은 직접 호출해 본 결과다. 점검 스크립트는 `scripts/check-translate.mjs`(번역·glossary), `scripts/check-stt.mjs`(STT, WAV 파일), `scripts/check-ws.mjs`(서버 WebSocket 경로), `scripts/check-csv.mjs`(업로드 검사 규칙)다.

### 이 프로젝트의 값

본문의 자리표시자는 그대로 두고, 실제 값은 이 표 한 곳에만 둔다.

| 자리표시자 | 값 |
|---|---|
| `P`, `PROJECT_ID` | `gtr-923548` (표시 이름 google-tr, 결제 연결됨) |
| `PROJECT_NUMBER` | `650337581319` |
| `BUCKET` | `gtr-923548-glossary` (`us-central1`) |
| glossary 이름 | `conf-terms` (1개만 관리) |
| 활성화된 API | speech, translate, storage, run, cloudbuild |

---

## 1. 목표와 범위

**목표**: 발표자 한 명이 브라우저 한 화면에서 마이크로 말하면, 원문 자막과 3개 이상 언어의 번역 자막(NMT)이 실시간으로 함께 나온다. glossary 적용 여부를 바꿔 가며 용어 반영과 지연시간을 확인한다.

**하는 것**
- 마이크 입력 → STT 스트리밍(인식 모델 `long` 또는 `chirp_3`, 화면에서 선택) → 원문 자막(interim과 final). chirp_3의 interim은 오디오 약 5초마다 1번뿐이라(4.1절) chirp_3에서는 발화 중에 주로 "듣는 중…" 표시(VAD 이벤트)가 보인다
- 중간 번역: 말하는 도중의 interim 원문도 대상 언어별로 번역해 회색 줄로 보여 주고, final 번역이 오면 확정 줄로 바꾼다(켜기/끄기 가능, 4.2절)
- final 문장마다 대상 언어별로 NMT 번역을 병렬 호출 → 언어별 번역 자막
- glossary on/off, glossary로 바뀐 용어 강조, STT 구문 힌트(같은 용어 목록)
- 화면에서 용어집 CSV 업로드 → 서버가 검사하고 버킷에 올린 뒤 glossary `conf-terms`를 새 내용으로 교체, 완료를 화면에 표시(5.2절). 용어집은 1개만 관리한다(목록, 버전 관리, 편집 화면, 권한 구분 없음)
- 언어 10종(en, zh-CN, es, hi, pt, ru, ja, ko, fr, de) 중 원문 1개와 대상 3개 이상 선택
- Google Cloud Run에 손으로 소스 배포(`gcloud run deploy --source .`) 1회, 테스트가 끝나면 서비스 삭제(8절)

**안 하는 것**: Translation LLM, Adaptive Translation, 번역 방식 전환(11절 참고), 청중 배포(다중 화면), 로그인, 자막 저장, 확장성(다중 인스턴스, 로드밸런서), 배포 자동화(CI/CD), 커스텀 도메인, 화자 분리, 원문 언어 자동 감지, 모바일 대응. (interim 번역은 2026-11-15에 범위에 넣었다. 아래 '하는 것' 참고)

---

## 2. 화면 구성 (단일 HTML 페이지)

```
┌────────────────────────────────────────────────────────────┐
│ 원문 언어 [ko ▼]   대상 언어 [☑en ☑ja ☑zh-CN ☐es ...]       │
│ [☑ glossary 적용]           [시작] [정지]   상태: 연결됨      │
│ 용어집: 42개 · 11-15 14:02 갱신   [용어집 업로드…]             │
├────────────────────────────────────────────────────────────┤
│ 원문(ko)  확정 문장들...                                     │
│           회색 글씨 = interim(진행 중)                       │
├──────────────┬──────────────┬──────────────────────────────┤
│ en           │ ja           │ zh-CN                        │
│ 번역 [용어]… │ 번역 [용어]… │ 번역 [용어]…                 │
│ (ms)         │ (ms)         │ (ms)                         │
└──────────────┴──────────────┴──────────────────────────────┘
```

- 원문 언어: `<select>` 1개. 대상 언어: 체크박스 10개(원문 언어는 비활성화). 3개 미만이면 [시작] 비활성화.
- 인식 모델: `<select>` 1개(`long` 중간 결과 자주 / `chirp_3` 중간 결과 드묾), 기본 `long`. 정지 상태에서만 바꿀 수 있고 `start`에 실어 보낸다. `long`은 한국어·중국어 간체·힌디어·러시아어 원문에서 구문 힌트를 거부하므로(4.1절) 그 언어를 고르면 설정 아래에 "long 모델은 ○○ 원문에서 구문 힌트(용어집 원문 열)를 지원하지 않아 힌트 없이 인식합니다. 힌트가 필요하면 chirp_3를 고르세요."를 한 줄로 보여 준다.
- 중간 번역 체크박스: 기본 켬, 진행 중에도 바꿀 수 있다(다음 번역 호출부터). 번역 호출 수와 문자 수가 몇 배로 늘어나므로(10절) 끌 수 있게 둔다. 켜져 있으면 번역 칸에 진행 중 발화의 번역이 회색(원문 interim과 같은 표시)으로 나오고 갱신될 때마다 덮어쓰며, 확정 번역이 오면 일반 줄로 바뀐다.
- 원문 영역: 확정 문장 아래에 진행 중 줄을 하나 둔다. interim이 오면 그 텍스트를 회색으로, interim 없이 서버가 `vad`(발화 시작)를 보내면 "듣는 중…"을 회색으로 표시한다. final이 오거나 발화 끝 이벤트가 오면 지운다. 상태 표시도 발화 중에는 "듣는 중"이 된다. chirp_3는 짧은 발화에서 interim이 전혀 없으므로(4.1절) 이 표시가 "인식 중"을 알리는 주된 수단이다.
- glossary 체크박스는 진행 중에도 바꿀 수 있다. 바뀐 값은 다음 final 문장부터 적용한다. 각 번역 줄 끝에 걸린 시간(ms)을 작게 표시한다.
- glossary가 적용돼 바뀐 용어는 번역 칸에서 `<mark>`로 강조한다(방법은 4.2절).
- 원문 언어나 대상 언어를 바꾸려면 정지한 뒤 다시 시작한다. STT 스트림을 다시 열어야 하기 때문이다.
- 오류(예: 특정 언어 번역 실패)는 해당 언어 칸에 빨간 글씨로 한 줄 표시하고, 다른 칸은 계속 동작한다.
- 용어집 줄(설정 줄 바로 아래): 왼쪽에 상태, 오른쪽에 [용어집 업로드…] 버튼(`<input type="file" accept=".csv">`). 상태는 세 가지다.
  - 완료: `용어집: 42개 · 11-15 14:02 갱신`. 페이지를 열 때 `GET /glossary`로 채운다.
  - 생성 중: `용어집 교체 중… (몇 분 걸릴 수 있음)`. 업로드 버튼과 [시작]을 비활성화한다.
  - 실패: 빨간 글씨로 서버가 준 오류 한 줄(예: `3행: 열이 9개입니다(10개 필요)`). 업로드 버튼은 다시 활성화된다.
  - (glossary가 아직 없으면 `용어집 없음`을 표시하고, 업로드는 5.1절 최초 생성 뒤에만 된다.)
- 업로드는 **정지 상태에서만** 할 수 있다(진행 중에는 버튼 비활성화). 생성 중에는 [시작]도 막는다. 확인됨(2026-11-15 실행): 교체(PATCH) 중에도 번역은 오류 없이 **이전 용어**로 나오고, 완료 직후 몇 초 동안 이전 용어가 남을 수 있다. 다만 `getGlossary`의 `inputUri`는 PATCH를 보내는 즉시 새 파일로 바뀌므로, 교체 중에 시작하면 구문 힌트는 새 파일, 번역은 이전 용어가 된다. 이 어긋남을 피하고 단순하게 두려고 [시작] 막기는 유지한다(결정 2026-11-15). 완료 후 [시작]을 누르면 번역과 STT 구문 힌트 모두 새 용어를 쓴다.
- 다른 창에서 시작한 교체가 진행 중이면(`GET /glossary`가 `updating`) 5초마다 다시 확인해 상태 줄을 갱신한다.

---

## 3. 구성도와 데이터 흐름

```
[브라우저]
 getUserMedia → AudioContext({sampleRate:16000})가 16k로 변환 → AudioWorklet(Int16, 100ms=3,200바이트)
      │ WebSocket (바이너리 프레임 = 오디오, 텍스트 프레임 = JSON 제어)
      ▼
[Node.js 서버 1개 프로세스 (Express 정적 파일 + ws) — 로컬 또는 Cloud Run]
 ├─ @google-cloud/speech v2 SpeechClient (apiEndpoint: us-speech.googleapis.com)
 │    _streamingRecognize → recognizer projects/P/locations/us/recognizers/_ (모델: start의 model, long 또는 chirp_3)
 │    4분 30초마다 새 스트림으로 교체 (5분 상한 대비)
 │      VAD 이벤트 → 브라우저로 vad 메시지("듣는 중…")
 │      interim → 브라우저로 그대로 전달 + (중간 번역 켬) 언어별 번역, 언어당 동시 1개·최소 700ms 간격
 │      final   → 브라우저로 전달 + 번역 시작
 └─ @google-cloud/translate v3 TranslationServiceClient (location: us-central1)
      final 1건 × 대상 언어 N개 → Promise.allSettled 로 translateText(NMT) 병렬 호출
      → 언어별로 완료되는 대로 브라우저로 전송

[용어집 교체 경로 (5.2절)]
 브라우저 [용어집 업로드] → HTTP POST /glossary (본문 = CSV 파일 그대로)
   → 서버: 형식 검사 → @google-cloud/storage로 gs://BUCKET/glossary-<시각>.csv 저장
   → updateGlossary(inputConfig 교체, LRO) 완료까지 대기 → 응답으로 결과 전달
 세션 start 때: getGlossary → inputConfig의 CSV를 버킷에서 읽어 구문 힌트·강조용 용어 목록 생성
```

- 인증: 서버에서 ADC를 쓴다. 로컬에서는 `gcloud auth application-default login`, Cloud Run에서는 서비스에 지정한 서비스 계정이 자동으로 쓰인다(키 파일 없음, 8절). 브라우저에는 키가 없다.
- 오디오 프레임: 100ms × 16kHz × 2바이트 = 3,200바이트. 요청당 오디오 상한 25KB보다 충분히 작다. 출처: https://docs.cloud.google.com/speech-to-text/docs/quotas
- 16kHz 변환(구현에서 바뀜): worklet 안에서 직접 다운샘플하지 않고 `new AudioContext({sampleRate: 16000})`로 브라우저에 맡긴다. 코드가 짧고 브라우저가 필터링까지 한다. 마이크와 다른 샘플레이트의 컨텍스트 연결은 Chrome 기준이다(Firefox까지 필요하면 worklet에서 직접 다운샘플한다).

### WebSocket 메시지

브라우저 → 서버

| 형식 | 내용 |
|---|---|
| 텍스트 `{"type":"start","source":"ko","targets":["en","ja","zh-CN"],"glossary":true,"interim":true,"model":"long"}` | 세션 시작. 서버가 STT 스트림을 연다. `model`은 허용 목록(`long`, `chirp_3`) 밖이면 `long`, `interim`은 중간 번역 여부 |
| 바이너리 | LINEAR16 16kHz mono PCM 100ms 조각 |
| 텍스트 `{"type":"settings","glossary":false,"interim":true}` | glossary·중간 번역 설정 변경(다음 번역 호출부터) |
| 텍스트 `{"type":"stop"}` | STT 스트림 종료 |

서버 → 브라우저

| 형식 | 내용 |
|---|---|
| `{"type":"started","model":"long","phrases":9}` | STT 스트림을 열었다(구현에서 추가). 브라우저는 이 메시지를 받은 뒤부터 오디오를 보낸다. `phrases`는 구문 힌트 수(힌트를 못 쓰는 조합이면 0) |
| `{"type":"vad","speaking":true}` | 발화 시작/끝(`SPEECH_ACTIVITY_BEGIN`/`END`, 구현에서 추가). "듣는 중…" 표시용 |
| `{"type":"interim","id":13,"text":"..."}` | 진행 중 원문(덮어쓰기). `id`는 이 발화가 확정되면 받을 final 번호와 같다(중간 번역을 같은 줄에 붙이기 위해 추가) |
| `{"type":"final","id":12,"text":"..."}` | 확정 원문 |
| `{"type":"translation","id":12,"lang":"en","text":"...","ms":640,"terms":["Vertex AI"]}` | 번역 결과(언어별로 따로 도착). `terms`는 glossary로 바뀐 용어 목록(없으면 빈 배열). 중간 번역이면 `"interim":true`가 붙는다(확정 번역에는 없음) |
| `{"type":"error","id":12,"lang":"en","message":"..."}` | 언어별 오류. `id`나 `lang`이 없으면 세션 전체 오류 |

`id`는 발화(final 문장) 번호다. 번역이 늦게 도착해도 같은 줄에 붙일 수 있다. 서버는 STT 스트림마다 진행 중 발화에 번호를 하나 붙이고(첫 interim이나 final 때) final이 오면 닫는다. 그래서 4분 30초 교체 때 이전 스트림의 마지막 final과 새 스트림의 interim이 겹쳐도 번호가 섞이지 않는다(번호가 도착 순서와 다를 수는 있다). 교체돼 입력을 닫은 스트림의 interim은 버린다. `settings`로 glossary를 바꾸면 그 뒤에 나오는 final부터 반영한다. `stop` 뒤에도 이전 스트림이 남은 final을 내면 서버는 그것을 보내고 번역한다(브라우저는 정지 후 3초 동안 연결을 열어 두어 받는다).

용어집 교체는 WebSocket이 아니라 HTTP(`GET`/`POST /glossary`, 5.2절)로 한다. 업로드는 정지 상태에서만 하고 POST 응답이 곧 완료 알림이므로 WebSocket 메시지는 추가하지 않는다.

[정지]를 누르지 않았는데 연결이 끊기면(Cloud Run 요청 시간 상한 등) 브라우저가 다시 연결해 같은 `start`를 다시 보낸다. 메시지 형식은 바뀌지 않는다(8.2절).

---

## 4. 사용하는 Google API와 핵심 파라미터

### 4.1 Speech-to-Text v2 스트리밍

- 엔드포인트: `us-speech.googleapis.com`. 출처: https://docs.cloud.google.com/speech-to-text/docs/endpoints
- recognizer: `projects/PROJECT_ID/locations/us/recognizers/_`. 미리 만들지 않고 기본 recognizer `_`에 config를 인라인으로 넣는다. **확인됨(2026-11-15 실행)**: `us-speech.googleapis.com` + `_` + 인라인 config로 chirp_3 스트리밍이 된다. recognizer를 만들 필요가 없다.
- 모델은 화면에서 고른다(`start`의 `model`, 허용 목록 `long`·`chirp_3`, 기본 `long`). 이전의 `STT_MODEL` 환경 변수는 없앴다. 결정(2026-11-15): chirp_3는 interim이 약 5초에 한 번이라 중간 번역 효과가 거의 없어 기본을 `long`으로 한다.
- **`long` 모델 확인 (2026-11-15 실행)**
  - 10개 언어 코드(en-US, cmn-Hans-CN, es-ES, hi-IN, pt-BR, ru-RU, ja-JP, ko-KR, fr-FR, de-DE) 모두 `us`에서 설정이 받아들여진다(무음 스트림). cmn-Hans-CN은 중국어 합성 음성으로도 인식됐다(`上下文疮口很大我们明天会提交代码`, 한 글자 오인식·문장부호 없음, 같은 음성을 chirp_3는 `上下文窗口很大,我们明天会提交代码。`). 공식 지원 언어 표(https://docs.cloud.google.com/speech-to-text/v2/docs/speech-to-text-supported-languages)에는 cmn-Hans-CN의 `long` 행이 없다. 표와 실제가 다르다.
  - 구문 힌트(`adaptation`): en, es, pt, ja, fr, de는 받아들여진다. **ko-KR, cmn-Hans-CN, hi-IN, ru-RU는 `INVALID_ARGUMENT: Config contains unsupported fields`로 거부된다**(boost를 빼도 같음). 공식 표도 hi·ru·ko의 `long`은 Model adaptation이 No다. 그래서 서버는 이 조합에서 힌트를 넣지 않고(`NO_HINTS`, `started.phrases`=0) 화면이 이유를 한 줄로 보여 준다. 모델을 chirp_3로 자동으로 바꾸지는 않는다(언어 자체는 지원되므로).
  - VAD 이벤트(`enableVoiceActivityEvents`)는 10개 언어 모두 받아들여진다.
  - 영어 합성 음성에서 `long`은 힌트가 있어도 `potato is the creator of Stack`(소문자, 문장부호 없음)으로 받아 적었다. 그래서 영어 원문 + `long`에서는 glossary의 `Poteto`가 매칭되지 않는다. 한국어에서는 `long`이 `포테토는 피스텍의 제작자입니다`로 오히려 원문 표기에 가까웠다(chirp_3는 `포테이토는`).

| 항목 (합성 음성, 100ms 실시간 전송) | long | chirp_3 |
|---|---|---|
| interim 빈도 | 단어 단위. 쉼 있는 영어 3문장(10초) 64번, 연속 19.4초 241번, 한국어 2문장 37번 | 오디오 약 5초마다 1번. 5초 미만 발화는 0번 |
| 첫 interim | 오디오 전송 시작 후 약 1.2~2.0초 | 약 6초(5초 넘게 이어 말할 때만) |
| final 지연(발화 끝 → final) | 약 1.1~1.7초 | 약 1.9~2.5초 |
| final이 끊기는 단위 | 쉼 단위(0.4초 쉼은 합침, 약 1초 쉼에서 나뉨) | 같음 |
| 문장부호·대소문자 | 없음, 소문자(영어) | 있음 |
| 구문 힌트 | en/es/pt/ja/fr/de만. ko/cmn/hi/ru는 거부 | 10개 언어(확인은 en·ko·cmn) |
| VAD 이벤트 | 됨 | 됨 |
| 영어 "Poteto" 받아쓰기(힌트 있음) | potato | Poteto | 참고: `chirp_2`는 `us`에 없다(`INVALID_ARGUMENT: The model "chirp_2" does not exist in the location named "us"`).
- chirp_3는 `us`, `eu` 멀티 리전에서 GA다. StreamingRecognize와 speech adaptation(구문 힌트, 최대 1,000개)을 지원한다. 출처: https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3
- 첫 요청(`streamingConfig`):
  ```json
  {
    "recognizer": "projects/P/locations/us/recognizers/_",
    "streamingConfig": {
      "config": {
        "explicitDecodingConfig": {"encoding": "LINEAR16", "sampleRateHertz": 16000, "audioChannelCount": 1},
        "languageCodes": ["ko-KR"],
        "model": "chirp_3",
        "adaptation": {"phraseSets": [{"inlinePhraseSet": {"phrases": [{"value": "Vertex AI", "boost": 10}]}}]}
      },
      "streamingFeatures": {"interimResults": true}
    }
  }
  ```
  이후 요청에는 `{"audio": <bytes>}`만 보낸다. 구현에서는 `streamingFeatures`에 `"enableVoiceActivityEvents": true`도 넣는다("듣는 중…" 표시용).
  **확인됨(2026-11-15 실행)**: 위 필드 이름(`explicitDecodingConfig`, `languageCodes`, `model`, `adaptation.phraseSets[].inlinePhraseSet`, `streamingFeatures.interimResults`, `streamingFeatures.enableVoiceActivityEvents`)이 모두 받아들여진다. 잘못된 언어 코드는 `INVALID_ARGUMENT: Bad language code`로 거부되고, `cmn-Hans-CN`은 받아들여진다(음성 품질은 미확인).
- Node 호출 방법: `@google-cloud/speech`의 `client.streamingRecognize()` 헬퍼는 v1 형식이라(오디오를 `audioContent`로 감싸고 `recognizer`가 없다) v2에 맞지 않는다(라이브러리 코드를 읽고 판단). 구현은 `client._streamingRecognize()`가 돌려준 스트림에 첫 메시지 `{recognizer, streamingConfig}`, 이후 `{audio}` 객체를 직접 write한다(확인됨).
- **chirp_3 결과의 특성 (확인됨, 2026-11-15 실행, macOS `say` 합성 음성 기준)**
  - interim: 오디오 **약 5초마다 1번**만 온다(결과 끝 위치 5.36, 10.36, 15.36초). 5초보다 짧은 발화에서는 interim 없이 final만 온다. 같은 설정의 `long` 모델은 단어 단위로 자주 온다(14초 음성에 64번). 그래서 화면은 VAD 이벤트로 "듣는 중…"을 보여 준다(2절).
  - final은 **문장이 아니라 쉼(pause) 단위**다. 0.4초 쉼으로는 나뉘지 않고 약 1초 쉼에서 나뉜다(경계 기준이 0.5~1초 사이라는 것은 추정). 쉼 없이 19초를 말하면 4문장이 final 1개로 온다. 결정(2026-11-15): 강제로 끊지 않고 쉼 단위 그대로 번역한다. 쉼 없이 오래 말하면 번역도 그만큼 늦게 시작된다.
  - final 지연: 발화가 끝난 뒤 약 **1.7~2.3초**에 온다(결과 끝 위치가 발화 끝보다 약 1초 뒤에 찍히고, 그 뒤 0.5~1초 후 도착). 비교로 `long`은 약 1.2초. 입력을 닫으면 진행 중인 발화가 0.3~0.7초 만에 final로 나온다.
  - 결과 조각의 transcript는 앞에 공백이 붙어 온다(`" The context…"`). 서버는 조각을 이어 붙인 뒤 공백을 정리하고 trim한다.
- 구문 힌트에는 glossary CSV에서 **원문 언어 열**의 용어만 넣는다(`boost: 10`). 확인됨: chirp_3에서 phrase와 `boost`가 거부되지 않는다. 영어 합성 음성에서 힌트 없이는 `Potato is the creator of stack.`, 힌트가 있으면 `Poteto is the creator of stack.`로 바뀌었다(반복해도 같음). `pstack`은 힌트가 있어도 `stack`이었다. 한국어 합성 음성 "포테토는"은 힌트 유무와 관계없이 `포테이토는`으로 받아 적혔다. boost 값 자체의 효과(value만 둘 때와의 차이)는 **미확인**이다. 실제 목소리 결과도 **미확인**이다.
- 스트림은 최대 5분이고 오디오는 실시간에 가까운 속도로 보내야 한다. 출처: https://docs.cloud.google.com/speech-to-text/docs/quotas
  - 재연결 방식: 4분 30초가 되면 새 스트림을 열고, 이후 오디오는 새 스트림으로 보낸다. 이전 스트림은 입력을 끝낸 뒤 final이 나올 때까지 응답만 받고 닫는다. 경계에서 단어가 잘리는 것은 허용한다(프로토타입). 확인됨: 짧은 간격(3~4초)으로 반복 교체해도 오류 없이 이어진다. 입력을 닫은 스트림은 진행 중 발화를 즉시 final로 내므로 경계에서 문장이 쪼개지거나(`the` 한 단어가 final 하나) 단어가 사라진다(`…is very` 뒤의 `large.`). 교체 간격은 환경 변수 `STT_ROTATE_MS`로 줄여 점검할 수 있다(기본 270,000ms).
  - 스트림이 오류로 끊기면 세션 오류(`error`)를 보내고, 다음 오디오 조각이 올 때 새 스트림을 연다(직전 열기로부터 3초 이내면 열지 않는다).
- 언어 코드 매핑(STT ↔ 번역 및 glossary):

| 언어 | STT (chirp_3) | 번역 / glossary |
|---|---|---|
| 영어 | en-US | en |
| 중국어 간체 | cmn-Hans-CN | zh-CN |
| 스페인어 | es-ES | es |
| 힌디어 | hi-IN | hi |
| 포르투갈어 | pt-BR | pt |
| 러시아어 | ru-RU | ru |
| 일본어 | ja-JP | ja |
| 한국어 | ko-KR | ko |
| 프랑스어 | fr-FR | fr |
| 독일어 | de-DE | de |

출처: https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3 , https://docs.cloud.google.com/translate/docs/languages

### 4.2 Cloud Translation v3 NMT (`translateText`)

- 지역은 `us-central1`이다. glossary가 `us-central1`에만 있을 수 있으므로 번역 호출도 같은 지역으로 맞춘다. 출처: https://docs.cloud.google.com/translate/docs/advanced/glossary
- 언어 지원: 10개 언어 모두 NMT 공식 지원 언어이고, 목록 안에서 **어떤 언어에서 어떤 언어로든** 번역할 수 있다. 출처: https://docs.cloud.google.com/translate/docs/languages
- 대상 언어 1개당 호출 1회. final 1문장마다 N회를 병렬로 호출한다.

`POST https://translation.googleapis.com/v3/projects/P/locations/us-central1:translateText`
```json
{
  "contents": ["원문 문장"],
  "sourceLanguageCode": "ko",
  "targetLanguageCode": "en",
  "mimeType": "text/plain",
  "model": "projects/P/locations/us-central1/models/general/nmt",
  "glossaryConfig": {
    "glossary": "projects/PROJECT_NUMBER/locations/us-central1/glossaries/conf-terms",
    "ignoreCase": true
  }
}
```
- glossary가 꺼져 있으면 `glossaryConfig`를 빼고 보낸다.
- 응답의 `translations`는 glossary를 적용하기 **전** 번역이고, `glossaryTranslations`는 적용한 번역이다. glossary가 켜져 있으면 `glossaryTranslations[0].translatedText`를 표시한다.
- 모델 경로 `.../models/general/nmt`는 REST 레퍼런스에서 확인했다. `model`을 빼면 기본값이 NMT다("If not provided, the default Google model (NMT) will be used"). 확인됨(2026-11-15 실행): `model` 경로가 받아들여지고, 빼도 동작한다.
- glossary 경로에는 프로젝트 ID(`gtr-923548`)와 번호(`650337581319`) 모두 쓸 수 있다(확인됨). API가 돌려주는 `name`은 번호 형식이다. 구현은 프로젝트 ID를 쓴다.
- glossary 매칭은 기본적으로 대소문자를 구분한다. 발화 텍스트는 대소문자가 일정하지 않으므로 `ignoreCase: true`로 둔다. 확인됨: 원문 `poteto`가 `ignoreCase: true`면 `Poteto 는 …`로 매칭되고(출력은 용어집의 대상 표기를 따름), `false`면 매칭되지 않는다(`poteto는 …`).
- 확인됨: glossary를 켜면 `translations`(적용 전)와 `glossaryTranslations`(적용 후)가 함께 온다. 끄면 `glossaryTranslations`는 빈 배열이다.
- 번역 결과 예(en→ko, "Poteto is the creator of pstack."): off `포테토는 pstack의 창시자입니다.` / on `Poteto 는 pstack 의 창시자입니다.` 원문이 "Potato"면 on/off 모두 `포테이토는…`(용어집에 potato 행을 넣지 않기로 결정). 한국어 원문 `포테토는…`(ko→en)은 매칭되지 않아 `Potato is…`가 된다.
- **glossary 적용 시 품질 저하 (확인됨)**
  - 한국어 출력에서 바뀐 용어 뒤 조사 앞에 공백이 들어간다(`Poteto 는 pstack 의`). 용어가 아닌 `pstack`도 glossary 행이 있으면 같은 현상이 생긴다.
  - 조사가 빠지기도 한다(`이 모델의 컨텍스트 윈도우 넓습니다.`, "은" 누락).
  - 다른 언어에서는 뜻 일부가 사라진다(ko→de `컨텍스트 윈도우 크기`: off `Kontextfenstergröße`, on `Kontextfenster` / ko→es: off `Aumenté el tamaño de la ventana de contexto.`, on `Aumenté la ventana de contexto.`).
  - 결정(2026-11-15): 보정 로직을 넣지 않고 받은 번역을 그대로 표시한다.
- 한국어 원문의 조사 붙은 용어 매칭: ko→fr에서 `컨텍스트 윈도우를`, `컨텍스트 윈도우가`가 매칭됐다(off `fenêtre contextuelle` → on `fenêtre de contexte`). ko→en은 off일 때도 이미 `context window`라 판정할 수 없었다. 문장 몇 개로 본 결과다.
- **지연 (확인됨, 로컬에서 호출)**: glossary off 약 120~230ms, on 대부분 540~730ms(가끔 140~190ms). glossary를 켜면 약 400ms 늘어난다. 첫 호출은 1.2초.
- 출처: https://docs.cloud.google.com/translate/docs/advanced/glossary , https://docs.cloud.google.com/translate/docs/reference/rest/v3/projects.locations/translateText , https://docs.cloud.google.com/translate/docs/reference/rest/v3/TranslateTextGlossaryConfig

**중간(interim) 번역** (2026-11-15 추가)
- interim 원문이 오면 대상 언어별로 같은 `translateText`를 부른다. 현재 glossary 설정을 그대로 적용하고(on이면 `glossaryConfig` 포함), 용어 강조(`terms`)도 확정 번역과 같은 방법으로 계산한다.
- 호출 폭주 방지(언어별): 진행 중 호출은 1개만. 호출이 끝났을 때 그 사이 새 interim이 와 있으면 **가장 최신 것 하나만** 번역한다(중간 것은 버림). 호출 시작 사이 최소 간격 `INTERIM_GAP_MS` = 700ms(상수). 직전에 번역한 텍스트와 같으면 부르지 않는다. 실측 갱신 간격은 약 0.7~1.0초였다.
- 순서 꼬임 방지: 서버는 확정된 발화 번호를 기억하고, final이 오면 그 발화의 대기 중인 중간 번역을 버린다. 이미 보낸 호출의 결과가 final 뒤에 돌아오면 보내지 않는다. 언어별로 호출이 직렬이라 같은 발화의 중간 번역은 항상 새것이 나중에 도착한다. 브라우저도 확정 번역을 중간 번역으로 덮지 않는다(한 번 더 막음). 중간 번역 호출이 실패하면 오류를 표시하지 않는다(다음 interim이나 확정 번역이 대신한다).
- 실측(로컬, long, 영어 원문 → ko/ja/es, 합성 음성):
  - 쉼 있는 3문장(10초): 언어당 중간 번역 12번, 첫 중간 번역은 오디오 시작 후 약 1.4초, 확정 번역으로 모두 교체, 순서 위반 0.
  - 연속 19.4초 1문장: 언어당 중간 번역 26~29번, 첫 표시 약 0.75~1.8초, 간격 평균 약 0.7초. 순서 위반 0.
  - 중간 번역 1회 지연: glossary off 평균 165ms, on 평균 234ms(영어 원문). 한국어 원문에서는 glossary on일 때 470~610ms였다(ko4·ko2 클립).
  - 한국어 원문(ko→en/ja/es, 2문장): 언어당 6~7번, 첫 표시 약 1.8초.
  - 중간 번역을 끄면 interim 번역 0번, 확정 번역만(이전 동작과 같음).
- 중간 번역은 앞부분이 바뀌며 흔들린다(예: `감자` → `감자는 이렇게 말합니다.` → `potato는 컨텍스트 창이 크다고 말합니다.`). 한 단어 interim이 엉뚱하게 번역되기도 한다(`the` → `그만큼`).

**glossary로 바뀐 용어 강조**

글자 단위 diff는 쓰지 않는다. 서버가 `start` 때 버킷에서 읽어 둔 용어 목록(5.2절)이 있으므로 다음처럼 단순하게 처리한다.
1. glossary가 켜져 있을 때, 대상 언어 열의 용어 중 `glossaryTranslations` 텍스트에는 있고 `translations` 텍스트에는 없는 것을 고른다(대소문자 무시 부분 문자열 검색).
2. 그 목록을 `translation` 메시지의 `terms`로 보낸다.
3. 브라우저는 번역 텍스트에서 `terms`의 각 용어를 `<mark>`로 감싼다(텍스트는 `textContent`로 넣고 용어 위치만 나눠 감싼다. `innerHTML`에 번역 결과를 그대로 넣지 않는다).

한계: 모든 열이 같은 고유명사(예: "Vertex AI")는 glossary 없이도 같은 문자열로 번역되면 강조되지 않는다. 번역 전후가 실제로 달라진 용어만 강조하는 것이 목적이므로 이 동작을 그대로 둔다. 확인됨: en→ko "Poteto is the creator of pstack."에서 `terms`는 `["Poteto"]`이고 `pstack`은 양쪽에 다 있어 강조되지 않는다. ja는 off일 때도 `Potetoは…`라 강조되지 않는다.

---

## 5. 데이터 준비와 교체: glossary (equivalent term set 1개)

### 5.1 최초 준비 (수동, 1회)

glossary 교체(5.2절)는 이미 있는 `conf-terms`의 입력 파일을 바꾸는 방식이라, 처음 한 번은 손으로 만든다. 서버는 `start` 때 이 파일도 5.2절 규칙으로 파싱하므로 최초 파일도 5.2절 검사 규칙(따옴표·`pos`·`description` 열 없음 등)을 지켜야 한다. 이 절차는 화면 업로드가 안 될 때의 대체 수단으로도 남긴다.

1. `glossary.csv` 작성: 첫 행은 언어 코드 헤더이고, 이후 한 행이 용어 하나다. 비어 있는 칸도 허용된다.
   ```
   en,zh-CN,es,hi,pt,ru,ja,ko,fr,de
   Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI
   large language model,大语言模型,modelo de lenguaje grande,...,대규모 언어 모델,...
   ```
   - 형식은 CSV만 가능하고, 선택 열로 `pos`와 `description`을 둘 수 있다(화면 업로드는 이 열을 받지 않는다, 5.2절). 전체 크기 10,485,760바이트 이하이고, 1,024바이트를 넘는 용어는 무시된다. 한 glossary에 넣을 수 있는 언어 수 상한은 문서에 없지만, **10개 언어로 생성되는 것은 확인됨(2026-11-15 실행)**.
   - 번역하지 않을 고유명사(제품명)는 모든 열에 같은 값을 넣는다.
2. 업로드: `gcloud storage cp glossary.csv gs://BUCKET/glossary.csv`
3. 생성(장기 실행 작업):
   ```json
   POST https://translation.googleapis.com/v3/projects/P/locations/us-central1/glossaries
   {
     "name": "projects/P/locations/us-central1/glossaries/conf-terms",
     "languageCodesSet": {"languageCodes": ["en","zh-CN","es","hi","pt","ru","ja","ko","fr","de"]},
     "inputConfig": {"gcsSource": {"inputUri": "gs://BUCKET/glossary.csv"}}
   }
   ```
4. 상태 확인: 생성 operation이 `done`이 된 뒤 `GET .../glossaries/conf-terms`로 `entryCount`를 본다. 확인됨(2026-11-15 실행): 용어 9행으로 생성에 약 7.5초(서버 기록 3.5초) 걸렸고 `entryCount`는 9였다. `entryCount`는 용어 행 수와 같다(8행 파일로 바꾸면 8). 완료 판단은 operation의 `done`(Node는 `operation.promise()`)으로 한다. 이 절차는 `node scripts/check-translate.mjs create`로 실행했다.
5. 이후 수정은 화면 업로드(5.2절)로 한다. 화면이 안 되면 새 이름으로 객체를 올린 뒤(예: `gs://BUCKET/glossary-manual-2.csv`) PATCH한다(`node scripts/check-translate.mjs patch gs://BUCKET/glossary-manual-2.csv`). 삭제 후 재생성은 쓰지 않는다. 아래 REST 예의 `updateMask=inputConfig`는 시험하지 않았다(Node gRPC 클라이언트에서는 `input_config`만 받아들여진다, 5.2절).
   ```json
   PATCH https://translation.googleapis.com/v3/projects/P/locations/us-central1/glossaries/conf-terms?updateMask=inputConfig
   {"inputConfig": {"gcsSource": {"inputUri": "gs://BUCKET/glossary-manual-2.csv"}}}
   ```
   응답은 operation이다. `GET .../operations/OPERATION_ID`로 `done`을 확인한다(operation 조회 경로는 **미확인**, 응답의 `name`을 그대로 쓴다). 출처: https://docs.cloud.google.com/translate/docs/reference/rest/v3/projects.locations.glossaries/patch

출처: https://docs.cloud.google.com/translate/docs/advanced/glossary

### 5.2 화면에서 용어집 교체

**흐름**: 브라우저가 CSV 파일을 `POST /glossary`로 보낸다 → 서버가 형식을 검사한다(실패하면 GCP에 아무것도 보내지 않고 400) → 버킷에 새 이름으로 저장한다 → glossary `conf-terms`의 입력 파일을 PATCH로 바꾸고 LRO가 끝날 때까지 기다린다 → 결과를 POST 응답으로 돌려준다. 화면은 응답을 받으면 상태 줄을 바꾼다.

**전송 방식 (추가 패키지 없음)**
- 브라우저: `fetch('/glossary', {method: 'POST', headers: {'Content-Type': 'text/csv'}, body: file})`. `File`을 본문에 그대로 넣는다. `file.text()`로 읽어 보내면 브라우저가 UTF-8이 아닌 바이트를 U+FFFD로 바꿔 서버의 인코딩 검사가 소용없어지기 때문이다. 보내기 전에 `file.size`가 1MB를 넘으면 바로 오류를 표시한다.
- 서버: Express에 내장된 `express.raw({type: 'text/csv', limit: '1mb'})`로 본문을 Buffer로 받는다. 1MB를 넘으면 413이다.
- 상한 1MB는 문서 상한(모든 용어 합계 10,485,760 UTF-8 바이트)보다 훨씬 작게 잡은 값이다. 용어 1,000개 × 10개 언어로도 충분하다.

**서버 검사** (모두 통과해야 GCP를 호출한다. 실패하면 첫 오류 1건을 행 번호와 함께 돌려준다)

| 항목 | 규칙 |
|---|---|
| 인코딩 | `new TextDecoder('utf-8', {fatal: true})`로 디코딩한다. 실패하면 "UTF-8 파일이 아닙니다". 맨 앞 BOM(U+FEFF)은 제거한다(`TextDecoder`가 기본으로 지운다. 문서는 크기를 UTF-8 바이트로만 말하고 인코딩을 따로 명시하지 않는다. BOM 허용 여부는 **미확인**이라 서버가 지우고 올린다) |
| 빈 파일 | 헤더 외에 용어 행이 1개 이상이어야 한다. 빈 줄(맨 끝 줄바꿈 포함)은 건너뛴다. 줄바꿈은 `\r\n`과 `\n` 모두 허용 |
| 헤더 | 쉼표로 나눈 값이 `en,zh-CN,es,hi,pt,ru,ja,ko,fr,de` 10개와 정확히 같은 집합(순서 무관, 중복 불가). 문서가 허용하는 `pos`·`description` 열은 받지 않는다 |
| 따옴표 | `"`가 들어간 파일은 거부한다. 서버는 쉼표로만 나누는 단순 분할을 쓰므로 칸 안에 쉼표를 넣을 수 없다(CSV 파서 패키지를 넣지 않기 위한 제약) |
| 열 수 | 모든 행이 헤더와 같은 10칸. 칸 앞뒤 공백은 지운다. 한 행의 칸이 모두 비면 거부 |
| 행 수 | 용어 행 최대 1,000개(STT 구문 힌트 상한 1,000개와 맞춤) |
| 칸 크기 | 각 칸 1,024 UTF-8 바이트 미만. 문서상 그보다 긴 용어는 조용히 무시되므로 미리 거부한다 |

용어 수는 서버가 센 용어 행 수를 쓴다(`entryCount`가 행 수와 같은 것은 확인됐지만 응답에는 둘 다 넣는다).

오류 메시지의 행 번호는 파일의 줄 번호다(헤더가 1행, 빈 줄도 센다). 검사 규칙은 `server.js`의 `parseGlossaryCsv` 하나에 있고, `node scripts/check-csv.mjs [CSV 경로]`가 정상·오류 사례를 assert로 점검한다.

**교체 방식 비교와 선택**

| 방식 | 호출 | 실패 시 | 추가 구현 |
|---|---|---|---|
| A. 삭제 후 재생성 | delete(LRO) + create(LRO) | 그 사이와 실패 후 glossary가 없어 `glossaryConfig`를 넣은 번역이 실패한다. 같은 이름을 삭제 직후 다시 만들 수 있는지 문서에 없다(**미확인**) | 없음 |
| B. 새 이름으로 생성 후 가리키는 이름 교체 | create(LRO) + 이전 것 delete | 기존 glossary가 그대로 남는다(가장 안전) | 현재 이름을 어딘가에 저장해야 한다. Cloud Run은 디스크가 유지되지 않으므로 버킷에 포인터 객체를 두거나 `list` 후 최신을 고르는 코드, 이전 glossary 정리 코드가 필요하다 |
| **C. PATCH로 입력 파일 교체 (선택)** | `updateGlossary`(LRO) 1회 | 기존 용어는 남지만 `inputUri`가 실패한 파일을 가리킨 채 남는다(확인됨). 직전 URI로 다시 PATCH해 되돌린다 | 직전 URI를 읽어 두고 실패 시 다시 PATCH(호출 1~2회 추가) |

C를 고른다. 문서가 "replace all of its entries with a new glossary input file"을 지원하고(`PATCH`, `updateMask`는 `displayName`과 `inputConfig`만 지원, 입력 파일을 바꾸면 LRO로 비동기 처리), 호출이 한 번이며 이름이 바뀌지 않는다. 문서도 "rollback하려면 원래 glossary 파일을 써야 한다"고 한다.

**PATCH 동작 (확인됨, 2026-11-15 실행, 용어 8~9개 기준)**
- 소요 시간: 요청 응답 약 1.8초, 완료까지 클라이언트 기준 5.8~10초(서버 기록 submit→end 1.6~3.2초). 화면 업로드 전체(검사+버킷 저장+PATCH+조회)는 약 6초였다. 용어 1,000개일 때는 **미확인**.
- 진행 중 같은 glossary로 번역하면 오류 없이 이전 용어로 번역된다. `getGlossary`가 이미 새 `entryCount`를 보여 준 직후에도 한 번은 이전 용어였다(완료 직후 짧은 지연).
- `inputConfig.gcsSource.inputUri`는 PATCH를 보내는 **즉시**(완료 전) 새 값으로 바뀐다. `submitTime`·`endTime`은 **성공했을 때만** 갱신된다.
- 존재하지 않는 `inputUri`로 PATCH하면 LRO가 `NOT_FOUND. Job state: FAILED`(code 5)로 실패한다. 기존 용어는 남는다(60초 뒤에도 그대로 적용, `entryCount` 유지). 그러나 **`inputUri`는 없는 파일을 가리킨 채 남는다.** 이대로 두면 `start` 때 용어 목록 읽기(아래)가 실패한다.
- 그래서 서버는 PATCH 직전에 현재 `inputUri`를 읽어 두고, LRO가 실패하면 그 URI로 다시 PATCH해 되돌린다. 되돌리기도 실패하면 오류 메시지에 그 사실을 함께 적는다(결정 2026-11-15). 확인됨: 일부러 첫 PATCH를 없는 파일로 보내 실패시키면 `502 {"state":"failed","error":"용어집 교체 실패: Error: NOT_FOUND. Job state: FAILED. (이전 용어집으로 되돌렸습니다)"}`가 오고 `inputUri`가 직전 CSV로 돌아온다. 이때 되돌리기 PATCH가 성공하므로 `endTime`은 되돌린 시각으로 갱신된다. 출처: https://docs.cloud.google.com/translate/docs/advanced/glossary , https://docs.cloud.google.com/translate/docs/reference/rest/v3/projects.locations.glossaries/patch

**서버 처리 순서** (`POST /glossary`)
1. 이 인스턴스에서 교체가 진행 중이면 409 `{"error":"이미 교체 중입니다"}`.
2. 위 검사. 실패하면 400.
3. 검사한 내용을 `gs://BUCKET/glossary-<UTC 시각>.csv`로 저장한다(`Content-Type: text/csv; charset=utf-8`). 구현에서는 받은 텍스트를 그대로 올리지 않고, 칸 앞뒤 공백과 빈 줄을 정리해 `\n` 줄바꿈으로 다시 쓴 CSV를 올린다(서버가 세는 용어와 glossary가 쓰는 용어를 일치시키기 위해). 객체 이름 예: `glossary-20261114T160023503Z.csv`. 이 단계 전에 현재 glossary를 읽어 직전 `inputUri`를 기억한다(glossary가 없으면 502 "최초 생성(5.1절)을 먼저 하세요"). 매번 새 이름으로 올리고 덮어쓰지 않는다. 교체가 실패해도 이전 CSV가 남아 glossary와 버킷이 어긋나지 않고, 롤백에 쓸 수 있다. 이전 객체는 지우지 않는다(작아서 비용 무시).
4. `updateGlossary({glossary: {name: 'projects/P/locations/us-central1/glossaries/conf-terms', inputConfig: {gcsSource: {inputUri}}}, updateMask: {paths: ['input_config']}})` → 돌아온 operation을 `await operation.promise()`로 완료까지 기다린다. Node 클라이언트에 `updateGlossary`와 진행 확인용 `checkUpdateGlossaryProgress`가 있다. 확인됨: 마스크 경로는 `input_config`다. `inputConfig`는 `INVALID_ARGUMENT: The request's update mask must include display_name or input_config.`로 거부된다. 출처: https://docs.cloud.google.com/nodejs/docs/reference/translate/latest/translate/v3.translationserviceclient
5. 성공하면 `getGlossary`로 `entryCount`, `endTime`을 읽어 200으로 응답한다. 실패하면 직전 URI로 되돌린 뒤(위 "PATCH 동작") 502와 오류 메시지. 직전 실패 메시지는 메모리에 남겨 `GET /glossary`가 `state: "failed"`와 함께 돌려준다(다음 성공 때 지움).
- LRO가 끝날 때까지 HTTP 요청을 열어 둔다. Cloud Run 기본 설정(request-based billing)은 요청 처리 중에만 CPU를 할당하므로 응답을 먼저 보내고 뒤에서 기다리면 대기가 멈출 수 있다. 출처: https://docs.cloud.google.com/run/docs/configuring/billing-settings . 요청 시간 상한은 `--timeout=3600`(8.1절)이라 충분하다(용어 9개 기준 PATCH 완료까지 약 6~10초 확인됨, 1,000개는 미확인, 9절).
- 진행 중 표시는 인스턴스 메모리의 플래그 하나다. 서버 재시작이나 다른 인스턴스에서는 보이지 않는다(프로토타입 한계).

**HTTP 엔드포인트**

| 요청 | 응답 |
|---|---|
| `GET /glossary` | 200 `{"state":"ready","terms":42,"entryCount":42,"updatedAt":"2026-11-15T05:02:11Z"}`. `state`는 `ready`/`updating`/`failed`(직전 실패 시 `"error":"..."` 포함). glossary가 없으면 `{"state":"none"}` |
| `POST /glossary`, `Content-Type: text/csv`, 본문 = CSV 파일 | 200 위와 같은 형식(교체 완료) / 400 `{"error":"3행: 열이 9개입니다(10개 필요)"}` / 409 진행 중 / 413 1MB 초과 / 502 `{"state":"failed","error":"..."}` |

`updatedAt`은 glossary의 `endTime`(생성 완료 시각)이다. 확인됨: PATCH가 성공하면 `endTime`이 갱신된다. 그 밖의 응답: `Content-Type`이 `text/csv`가 아니면 400, glossary가 없을 때의 POST는 502. 출처(필드 정의): https://docs.cloud.google.com/translate/docs/reference/rest/v3/projects.locations.glossaries

**서버가 용어 목록을 읽는 곳**
- 로컬 `glossary.csv`를 읽지 않는다. Cloud Run은 인스턴스 디스크가 유지되지 않고, 교체 내용은 버킷에만 있기 때문이다.
- 세션 `start`를 받을 때마다 `getGlossary` → `inputConfig.gcsSource.inputUri`의 CSV를 버킷에서 읽고 위와 같은 규칙으로 파싱한다. 인스턴스가 여러 개이거나 재시작돼도 캐시가 낡지 않는다. 호출 2번이 `start`에 더해지는 정도다(`start`→`started` 약 0.5초). 주의: `inputUri`는 PATCH를 보내는 즉시 바뀌고 실패해도 남으므로(위 "PATCH 동작") "glossary가 실제로 쓰는 파일"과 항상 같지는 않다. 실패 시 되돌리기와 교체 중 [시작] 막기로 이 어긋남을 피한다. 되돌리기까지 실패하면 `start` 때 읽기가 실패할 수 있고, 그때는 아래처럼 힌트 없이 시작한다.
- 원문 언어 열로 STT 구문 힌트를 만들고(빈 칸 제외, 100자 이하, 최대 1,000개), 대상 언어 열은 용어 강조(4.2절)에 쓴다.
- 구문 힌트는 STT 스트림을 열 때만 들어간다. 업로드는 정지 상태에서만 하므로 다음 [시작]부터 새 용어가 적용된다. 번역은 같은 이름의 glossary를 부르므로 완료 직후부터 새 용어를 쓴다.
- 읽기에 실패하면 구문 힌트·용어 강조 없이 시작하고 세션 오류(`error`)로 한 줄 알린다. glossary가 아예 없으면(NOT_FOUND) 오류 없이 힌트 없이 시작한다.

**패키지**: `@google-cloud/storage` 1개만 추가한다(CSV 저장과 읽기). 전송은 `fetch`와 `express.raw`, 인코딩 검사는 `TextDecoder`, glossary 교체는 이미 쓰는 `@google-cloud/translate`로 한다. CSV 파서는 넣지 않는다(위 따옴표 제약).

**한계**: 배포 주소가 공개이고 접속 코드가 없으므로 주소를 아는 누구나 용어집을 바꿀 수 있다.

---

## 6. GCP 사전 설정 체크리스트

- [x] 프로젝트 선택(`gtr-923548`), 결제 연결
- [x] API 활성화: `speech.googleapis.com`, `translate.googleapis.com`, `storage.googleapis.com` (8절의 `run`, `cloudbuild`도 활성화됨)
- [ ] 인증: 로컬 개발에서는 `gcloud auth application-default login`과 `gcloud auth application-default set-quota-project P`. 로컬 실행 계정(사람)과 Cloud Run 서비스 계정(8절)에는 다음 역할이 필요하다. 로컬 계정이 프로젝트 Owner면 따로 줄 것은 없다.
  - `roles/speech.client` (Cloud Speech Client, "Grants access to the recognition APIs". `speech.recognizers.recognize` 권한 포함). 출처: https://docs.cloud.google.com/iam/docs/roles-permissions/speech
  - `roles/cloudtranslate.editor` (프로젝트 단위). 번역 호출과 glossary 사용(`cloudtranslate.glossaries.predict`)에 더해 화면 업로드의 교체에 필요한 `cloudtranslate.glossaries.update`, `get`, `create`, `delete`, LRO 조회(`cloudtranslate.operations.get`, `wait`)를 포함한다. 기존 `roles/cloudtranslate.user`에는 `get`·`list`·`predict`와 operations 조회만 있고 create/delete/update가 없어 editor로 바꾼다. 출처: https://docs.cloud.google.com/translate/docs/access-control
  - 버킷 단위 `roles/storage.objectCreator`(새 객체 쓰기, `storage.objects.create`)와 `roles/storage.objectViewer`(읽기, `storage.objects.get`·`list`). 업로드마다 새 이름으로 쓰고 덮어쓰지 않으므로 이 두 개로 충분하다(`objectCreator`는 덮어쓰기와 삭제를 못 한다). 덮어쓰는 방식이었다면 `roles/storage.objectUser`가 필요하다. 출처: https://docs.cloud.google.com/storage/docs/access-control/iam-roles
  - glossary 생성·갱신 때 버킷의 CSV를 읽는 주체: 문서는 "For creating glossaries, you also need permissions to read objects in the [bucket]"이라고만 하고 호출자인지 Translation 서비스 에이전트인지 밝히지 않는다(**미확인**). 호출자(위 계정들)에게 `objectViewer`를 주므로 호출자 기준이면 충분하다. 그래도 권한 오류로 실패하면 Translation 서비스 에이전트에 같은 버킷의 `objectViewer`를 준다(서비스 에이전트 주소도 **미확인**, 오류 메시지에 나오는 주체를 쓴다). 출처: https://docs.cloud.google.com/translate/docs/advanced/glossary , https://docs.cloud.google.com/translate/docs/access-control
- [x] GCS 버킷 `gs://gtr-923548-glossary` 생성(`us-central1`)
- [x] `glossary.csv` 업로드와 glossary `conf-terms` 최초 생성 후 상태 확인(5.1절, 2026-11-15 생성, `entryCount` 9)
- [x] recognizer: 기본 `_` 사용(별도 생성 없음). 동작 확인됨.
- [x] 로컬 인증: ADC(quota project `gtr-923548`), 프로젝트 Owner 계정으로 번역·STT·glossary 교체·버킷 읽기/쓰기 모두 동작 확인. 서비스 계정 권한(위 역할 목록)은 11단계 전까지 **미확인**.
- [ ] 마이크 권한: `http://localhost`에서 열면 HTTPS가 없어도 getUserMedia가 동작한다. Cloud Run 주소는 HTTPS다.

---

## 7. 구현 단계

각 단계는 한 번에 확인할 수 있는 크기로 나눴다. 파일은 `server.js` 하나와 `public/index.html` 하나(worklet은 인라인 Blob 또는 `public/worklet.js`)로 한다.

| # | 작업 | 확인 방법 |
|---|---|---|
| 1 | NMT 단건 점검 스크립트: glossary on/off로 ko→en, ko→ja 1문장씩 `translateText` 호출 | 4가지 조합 모두 응답이 온다. `general/nmt` 경로, glossary on일 때 `translations`와 `glossaryTranslations`가 함께 오는지 확정 |
| 2 | 서버에서 STT만: 16kHz WAV 파일을 100ms 단위로 실시간 속도로 흘려 `streamingRecognize` 호출 | 콘솔에 interim/final이 찍힌다. 기본 recognizer `_`, v2 필드 이름, chirp_3의 interim 여부를 여기서 확인 |
| 3 | 브라우저 마이크 → AudioWorklet → WebSocket → 서버 STT | 말하면 화면 원문 영역에 interim(회색)과 final이 나온다 |
| 4 | final → 대상 언어별 NMT 병렬 번역 → 화면 칸별 표시 | 3개 언어 칸에 번역이 나오고 ms가 표시된다 |
| 5 | glossary on/off 반영과 바뀐 용어 강조 | 진행 중 체크를 바꾸면 다음 문장부터 반영된다. glossary 용어가 든 문장에서 해당 용어가 강조된다 |
| 6 | STT 구문 힌트(glossary 원문 열) 추가. `start` 때 `getGlossary` → 버킷의 CSV를 읽어 용어 목록을 만든다(5.2절). `@google-cloud/storage` 추가 | 힌트 on/off로 용어 인식률 차이를 귀로 확인(같은 녹음 파일 재생). 로컬에 `glossary.csv`가 없어도 동작한다 |
| 7 | 4분 30초 스트림 교체 | 6분 이상 연속 발화해도 자막이 끊기지 않는다(교체 시점 로그) |
| 8 | 오류 표시: 언어별 실패, WebSocket 끊김 시 상태 표시 | 잘못된 glossary 이름으로 실행해 해당 칸에만 오류가 표시된다 |
| 9 | 용어집 업로드(5.2절): 화면의 업로드 버튼과 상태 줄, `GET`/`POST /glossary`, 서버 검사, 버킷 저장, `updateGlossary` LRO 대기 | ① 헤더가 틀린 CSV, 따옴표가 든 CSV, Shift-JIS 등 UTF-8이 아닌 CSV, 1MB 초과 파일을 각각 올리면 행 번호가 붙은 오류가 나오고 버킷에 새 객체가 생기지 않는다. ② `Poteto` 행(10개 열 모두 `Poteto`)이 든 CSV(`~/Desktop/glossary.csv`)를 올리면 "교체 중"을 거쳐 "완료"와 용어 수가 표시된다(걸린 시간 기록). ③ 원문 en, 대상 ko로 "Poteto is the creator of pstack." 을 말하면 glossary on에서 한국어 결과에 `Poteto`가 그대로 나오고 "감자"나 "포테토"가 나오지 않는다. off일 때의 결과도 기록해 비교한다. 음성 인식이 "potato"로 받아 적으면 glossary가 매칭되지 않으므로, 원문 자막의 표기도 함께 기록한다(`potato` → `Poteto` 행은 넣지 않기로 했다). ④ 교체 중 같은 이름으로 스크립트에서 `translateText`(glossary on)를 호출해 결과를 기록한다(9절) |
| 10 | WebSocket 자동 재연결(8.2절): [정지] 없이 끊기면 같은 설정으로 다시 연결하고 `start`를 다시 보낸다 | 로컬에서 발화 중 서버를 재시작하면 상태가 "재연결 중"을 거쳐 몇 초 안에 자막이 다시 나온다. 이전 줄은 화면에 남는다 |
| 11 (미진행) | Cloud Run 배포(8.1절) | HTTPS 주소에서 마이크 권한 → 원문 자막 → 3개 언어 번역이 나온다. `--timeout=3600`으로 다시 배포한 뒤 배포 주소에서 9단계의 ②를 한 번 더 해(POST가 LRO 끝까지 열려 있어 120초 배포에서는 끊길 수 있다) 서비스 계정 권한으로 교체가 되는지 본다. `--timeout=120`으로 한 번 배포해 2분마다 끊겨도 자동 재연결되는지 본 뒤 `--timeout=3600`으로 다시 배포한다. 끝나면 서비스를 삭제한다(8.3절) |

**진행 상황 (2026-11-15)**: 1~10단계를 구현했고, 이어서 중간 번역과 인식 모델 선택을 추가했다(`check-ws.mjs`에 `MODEL`, `INTERIM=0`, `GLOSSARY=0`, `OFF_AFTER` 환경 변수, 끝에 언어별 중간 번역 요약 출력). 파일은 `server.js`, `public/index.html`(worklet은 인라인 Blob), `package.json`, 점검 스크립트 `scripts/check-*.mjs`. 실행은 `npm start` 후 `http://localhost:8080`.
- 직접 확인한 것: 1·2단계(관문 A·B), 4·5단계는 WAV를 WebSocket으로 흘리는 `scripts/check-ws.mjs`로 확인(영어 원문 → ko/ja/zh-CN, 한국어 원문 → en/ja/es, `settings`로 glossary off, `terms` 포함), 6단계(`started.phrases`=9, 힌트 적용), 7단계는 `STT_ROTATE_MS=4000`으로 짧게 교체해 확인, 8단계는 언어별 오류·세션 오류 표시를 화면에서 메시지를 흉내 내 확인, 9단계는 curl과 화면(파일 선택 창 대신 스크립트로 파일 주입)으로 ①②④ 확인(③은 사람 목소리가 필요), 10단계는 브라우저 연결 중 서버를 재시작해 1초 간격 재시도 뒤 다시 `started`까지 오는 것을 확인.
- 3단계: 브라우저 마이크 → worklet → WebSocket → `started`까지, 그리고 레벨 미터에 소리가 잡히는 것까지 확인. 실제로 말해서 자막이 나오는 것은 **미확인**(사람이 말해야 함).
- 9단계 ③(사람이 말한 "Poteto"의 받아쓰기와 한국어 번역의 `Poteto`)은 **미확인**.

---

## 8. 간단한 배포 (Cloud Run)

가장 단순한 구성만 다룬다. 서비스 1개, 리전 1개, 수동 배포. CI/CD, 커스텀 도메인, 다중 인스턴스 확장, 로드밸런서는 넣지 않는다. 파일 구성은 `server.js`, `public/index.html`, `package.json`이고(용어집 CSV는 버킷에 있으므로 소스에 넣지 않는다) Dockerfile은 만들지 않는다.

### 8.1 배포 절차

1. API 활성화(6절의 API에 더해):
   ```
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com
   ```
   소스 배포는 Cloud Run Admin API와 Cloud Build API를 쓴다. 출처: https://docs.cloud.google.com/run/docs/deploying-source-code
   첫 배포 때 gcloud가 다른 API(예: Artifact Registry) 활성화나 저장소 생성을 물으면 승인한다(**미확인**: 문서에서 필요 여부를 확인하지 못했다).
2. 코드가 지켜야 할 조건
   - 서버는 `PORT` 환경 변수의 포트로, `0.0.0.0`에서 리슨한다(`127.0.0.1` 금지). 기본값은 8080이다. 예: `server.listen(process.env.PORT || 8080)`. 출처: https://docs.cloud.google.com/run/docs/container-contract
   - `package.json`에 `"scripts": {"start": "node server.js"}`를 둔다. Node.js 빌드팩은 `scripts.start`를 실행 명령으로 쓴다. Node 버전은 `engines.node`로 정하고, 없으면 최신 LTS를 쓴다. 출처: https://docs.cloud.google.com/docs/buildpacks/nodejs
   - 서버는 용어 목록을 버킷에서 읽는다(5.2절). 로컬 `glossary.csv`와 키 파일은 배포 소스에 넣지 않는다.
3. 서비스 계정 만들기와 권한. Cloud Run은 지정하지 않으면 Compute Engine 기본 서비스 계정(`PROJECT_NUMBER-compute@developer.gserviceaccount.com`)을 쓰고, 문서는 사용자 관리 서비스 계정을 권장한다. 이 서비스 전용 계정을 하나 만든다. 출처: https://docs.cloud.google.com/run/docs/securing/service-identity
   ```
   gcloud iam service-accounts create subtitle-run
   SA=subtitle-run@P.iam.gserviceaccount.com
   gcloud projects add-iam-policy-binding P --member=serviceAccount:$SA --role=roles/speech.client
   gcloud projects add-iam-policy-binding P --member=serviceAccount:$SA --role=roles/cloudtranslate.editor
   gcloud storage buckets add-iam-policy-binding gs://BUCKET --member=serviceAccount:$SA --role=roles/storage.objectCreator
   gcloud storage buckets add-iam-policy-binding gs://BUCKET --member=serviceAccount:$SA --role=roles/storage.objectViewer
   ```
   - `roles/speech.client`: 음성 인식(`speech.recognizers.recognize`). `roles/cloudtranslate.editor`: 번역 호출, glossary 사용(`predict`), 화면 업로드의 glossary 교체(`update`, LRO 조회). `user` 역할에는 `update`가 없어 editor를 준다. 버킷 두 역할: 업로드한 CSV 쓰기와 `start` 때 읽기(버킷 단위로만 준다). 출처: 6절의 IAM 문서, 버킷 명령은 https://docs.cloud.google.com/storage/docs/access-control/using-iam-permissions
   - 배포하는 사람 계정에는 `roles/run.sourceDeveloper`, `roles/serviceusage.serviceUsageConsumer`, 서비스 계정에 대한 `roles/iam.serviceAccountUser`가 필요하다. 빌드는 기본적으로 Compute Engine 기본 서비스 계정으로 돌고, 그 계정에 `roles/run.builder`가 필요하다. 출처: https://docs.cloud.google.com/run/docs/deploying-source-code , https://docs.cloud.google.com/run/docs/configuring/services/service-identity
4. 배포(프로젝트 루트에서):
   ```
   gcloud run deploy subtitle \
     --source . \
     --region=us-central1 \
     --timeout=3600 \
     --service-account=subtitle-run@P.iam.gserviceaccount.com \
     --allow-unauthenticated
   ```
   - `--region`: 번역·glossary와 같은 `us-central1`로 둔다. STT는 지금처럼 `us-speech.googleapis.com` 엔드포인트를 그대로 쓴다.
   - `--timeout`: 요청 시간 제한. 기본 300초(5분), 최대 3600초(60분)이다. WebSocket 연결에도 적용되므로 최대로 둔다(8.2절). 출처: https://docs.cloud.google.com/run/docs/configuring/request-timeout
   - `--allow-unauthenticated`: 브라우저가 로그인 없이 열 수 있게 공개한다. 조직 정책이 `allUsers` 부여를 막으면 실패하고, 그때는 `--no-invoker-iam-check`를 쓴다. 출처: https://docs.cloud.google.com/run/docs/authenticating/public
   - 최소 인스턴스, 최대 인스턴스, 세션 어피니티, 동시성은 설정하지 않는다(기본값). 세션 상태가 연결 하나에만 있고 재연결 때 `start`를 다시 보내므로 같은 인스턴스로 돌아갈 필요가 없다.
5. 배포 후 확인: 명령이 출력한 `https://...run.app` 주소를 Chrome으로 열고, 마이크 권한 허용 → 말하면 원문 자막 → 3개 언어 번역이 나오는지 본다. 실패하면 Cloud Run 로그(`gcloud run services logs read subtitle --region=us-central1`)에서 권한 오류(`PERMISSION_DENIED`)를 확인한다. 로그 명령은 **미확인**(문서로 확인하지 않음. 콘솔의 로그 탭으로 대신해도 된다).

### 8.2 WebSocket과 연결 시간 상한

- Cloud Run은 WebSocket을 추가 설정 없이 지원한다. WebSocket 연결도 요청 시간 제한을 받는다(기본 5분, 최대 60분). 서버가 시간 제한을 두지 않아도 이 시간이 지나면 끊긴다. 문서는 클라이언트가 시간 초과나 서버 끊김 시 다시 연결하도록 처리해야 한다고 한다. 출처: https://docs.cloud.google.com/run/docs/triggering/websockets
- 따라서 60분을 넘는 발표에서는 연결이 한 번 이상 끊긴다. STT의 4분 30초 스트림 교체(4.1절)는 서버 안의 일이고, 이 상한과는 별개다.
- **자동 재연결(구현 항목, 7절 10단계)**: 가장 단순한 방식으로 한다.
  1. 브라우저는 마지막으로 보낸 `start` 메시지를 기억한다.
  2. 사용자가 [정지]를 누르지 않았는데 `close` 이벤트가 오면 상태를 "재연결 중"으로 바꾸고 1초 뒤 새 WebSocket을 연다. 실패하면 1초 간격으로 다시 시도한다(횟수 제한 없음, 정지 버튼으로 멈춘다).
  3. 연결되면 같은 `start`를 다시 보내고, 마이크와 AudioWorklet은 그대로 둔 채 오디오 전송을 이어 간다. 서버는 새 STT 스트림을 연다.
  4. 서버의 `id`는 연결마다 1부터 다시 시작하므로, 브라우저는 줄을 구분할 때 연결 번호를 함께 쓴다(예: `2-1`). 이전 줄은 지우지 않는다.
  5. 끊긴 동안(약 1~2초)의 발화는 버린다(프로토타입).

### 8.3 테스트 후 삭제

- 배포 주소는 공개되어 주소를 아는 누구나 쓸 수 있고, 사용량만큼 음성 인식·번역 요금이 나온다. 주소를 아는 누구나 용어집도 바꿀 수 있다(5.2절). 테스트가 끝나면 서비스를 삭제한다.
- 삭제: `gcloud run services delete subtitle --region=us-central1`. 확인: `gcloud run services list`에 `subtitle`이 없으면 된다. 삭제는 되돌릴 수 없고, 소스 배포로 만들어진 컨테이너 이미지는 Artifact Registry에 남는다(필요하면 따로 지운다). 출처: https://docs.cloud.google.com/run/docs/managing/services

---

## 9. 검증 항목 (미확인 사항)

"확인됨"은 2026-11-15에 직접 호출해 본 결과다(합성 음성·로컬 실행 기준). 자세한 수치는 표시한 절에 있다.

| 항목 | 확인 방법 | 결과 |
|---|---|---|
| chirp_3 스트리밍에서 interim 결과가 나오는지, 나온다면 주기는 얼마인지(문서 예시는 `interim_results=False`) | 7절 2단계 | **확인됨**: 오디오 약 5초마다 1번, 5초 미만 발화는 0번(4.1절) |
| 기본 recognizer `_` + 인라인 config로 chirp_3 스트리밍이 되는지 | 7절 2단계 | **확인됨**: 된다 |
| chirp_3에서 phrase `boost`가 효과가 있는지 | 7절 6단계 | 거부되지 않고 힌트는 영어 "Poteto"에 효과가 있었다. boost 값 자체의 효과는 미확인 |
| final이 문장 단위로 나오는지, 너무 길거나 짧게 끊기는지(번역 품질과 지연에 영향) | 실제 발화 5분 | **확인됨(합성 음성)**: 쉼 단위(약 1초 쉼), 발화 끝 뒤 약 2초. 실제 발화 5분은 미확인 |
| 한국어 조사가 붙은 용어(예: "버텍스AI는", "대규모 언어 모델을")가 glossary에 매칭되는지 | 조사 붙은 문장 10개를 glossary on/off로 비교 | 일부 확인: ko→fr에서 "컨텍스트 윈도우를/가"가 매칭됐다(4.2절). 10문장 비교는 미진행 |
| equivalent term set 하나에 10개 언어를 넣을 수 있는지(문서에 언어 수 상한 없음) | glossary 생성 성공 여부 | **확인됨**: 된다 |
| PATCH(`inputConfig` 교체)에 걸리는 시간. 용어 수에 따라 달라지는지 | 7절 9단계 ②, 용어 10개와 1,000개로 각각 기록 | 용어 9개: 완료까지 약 6~10초, 화면 업로드 전체 약 6초. 1,000개는 미확인 |
| PATCH 진행 중 같은 glossary로 번역하면 이전 용어가 쓰이는지, 오류가 나는지 | 7절 9단계 ④ | **확인됨**: 오류 없이 이전 용어. 완료 직후 잠깐 이전 용어가 남는다. [시작] 막기는 유지하기로 결정(2절) |
| PATCH가 실패했을 때 기존 용어가 남는지, `getGlossary`의 `inputUri`가 무엇을 가리키는지 | 존재하지 않는 `inputUri`로 PATCH | **확인됨**: 용어는 남고 `inputUri`는 실패한 파일을 가리킨다. 서버가 직전 URI로 되돌린다(5.2절) |
| `updateMask` 경로 이름(`input_config`/`inputConfig`), PATCH 뒤 `endTime`이 갱신되는지, `entryCount`가 용어 행 수와 같은지 | 7절 9단계 ② 응답 비교 | **확인됨**: `input_config`(Node gRPC), 성공 시 `endTime` 갱신, `entryCount` = 행 수 |
| 같은 이름으로 삭제 직후 재생성이 되는지(대체 수단 A가 필요할 때만) | 스크립트로 delete → create 한 번 | 미확인(필요 없어 하지 않음) |
| glossary 생성·갱신 때 버킷을 읽는 주체(호출자인지 Translation 서비스 에이전트인지) | 7절 11단계에서 서비스 계정으로 교체가 성공하면 호출자 권한으로 충분한 것이다 | 미확인(Owner 계정으로만 실행) |
| glossary on일 때 응답에 `translations`와 `glossaryTranslations`가 함께 오는지(용어 강조의 전제) | 7절 1단계 | **확인됨**: 함께 온다 |
| NMT 지연시간(final 수신부터 번역 표시까지 p50/p95), glossary on/off 차이 | 화면의 ms 값을 문장 30개 기준으로 기록 | 대략치만 확인: off 약 120~230ms, on 약 540~730ms. 30문장 p50/p95는 미측정 |
| glossary 적용 시 번역 품질(새 항목) | on/off 비교 | **확인됨**: 한국어 조사 앞 공백·조사 누락, 다른 언어에서 뜻 일부 누락(4.2절). 보정하지 않기로 결정 |
| 스트림 교체 경계에서 단어가 누락되는지 | 7단계 로그와 녹음 대조 | **확인됨(짧은 간격으로 시험)**: 경계에서 문장이 쪼개지거나 단어가 사라진다 |
| 힌디어·러시아어 등 비라틴 문자 원문에서 STT 품질 | 해당 언어 화자 또는 녹음 | 미확인(en·ko 합성 음성만, cmn-Hans-CN은 설정 수락만) |
| 사람 목소리의 "Poteto" 받아쓰기, 한국어 번역에 `Poteto`가 나오는지(새 항목) | 7절 9단계 ③ | 미확인(합성 음성에서는 힌트가 있으면 `Poteto`, 번역은 `Poteto 는 …`) |
| `long` 모델의 10개 언어 수락, 구문 힌트·VAD 지원(새 항목) | 무음 스트림 + 합성 음성 | **확인됨**: 10개 언어 모두 수락, 힌트는 ko/cmn/hi/ru에서 거부, VAD는 모두 됨(4.1절). cmn-Hans-CN은 공식 표에 `long` 행이 없는데도 동작 |
| 중간 번역의 순서 꼬임·호출 수·체감 지연(새 항목) | `scripts/check-ws.mjs`(MODEL=long) | **확인됨(합성 음성)**: 순서 위반 0, 첫 표시 약 0.75~1.8초, 갱신 약 0.7~1.0초 간격, 문자 수 1.5~15배(4.2절, 10절). 사람 목소리 체감은 미확인 |
| Cloud Run에서 WebSocket이 `--timeout` 시간에 끊기고 자동 재연결이 되는지, 재연결 공백이 몇 초인지 | 7절 11단계(`--timeout=120` 임시 배포) | 로컬 서버 재시작으로는 재연결 확인됨. Cloud Run은 미확인 |
| Cloud Run에서의 번역 지연이 로컬과 비슷한지(서버가 `us-central1`로 옮겨 감) | 화면의 ms 값을 로컬 기록과 비교 | 미확인 |
| 탭을 닫은 뒤 인스턴스가 0으로 줄어드는지(유휴 시 과금 없음 확인). 문서상 유휴 인스턴스는 최대 15분까지 남을 수 있다 | Cloud Run 콘솔의 인스턴스 수 그래프를 20분 뒤 확인 | 미확인 |

---

## 10. 대략 비용 (1시간 발표 기준, 대략치)

가정: 영어 기준 약 150단어/분, 원문 약 54,000자/시간, 대상 언어 3개 → 번역 입력 약 162,000자/시간.

| 항목 | 단가 | 1시간 추정 |
|---|---|---|
| STT v2 (long 또는 chirp_3) | 분당 $0.016(0~50만 분 구간, 모델별 단가 차이는 미확인) | 약 $1 |
| NMT (Advanced), 중간 번역 끔 | 백만 자당 $20, 월 50만 자 무료(**미확인, 기억 기반**. 2026-11-14에 가격 페이지를 다시 열어 봤으나 본문이 스크립트로 렌더링돼 읽지 못함) | 약 $3.2 (무료 구간이면 $0) |
| NMT, 중간 번역 켬(추가분) | 같은 단가. 실측 문자 수 배수(아래) 적용 | 쉼 있는 발표 기준 약 $5~$8 추가(확정 번역의 1.5~2.4배), 쉼 없이 길게 말하면 훨씬 커진다 |
| glossary | 번역 문자 수 기준 과금 | 위 금액에 포함 |
| GCS | 무시할 수준 | ~$0 |
| Cloud Run | WebSocket이 열린 동안 인스턴스는 활성으로 보고 CPU가 할당되며 instance-based billing으로 과금된다. 무료 구간(request-based 기준): 월 vCPU 180,000초, 메모리 360,000GB초, 요청 200만 건. 초과분 단가는 **미확인**(검색 요약 기준 vCPU초당 약 $0.000018~$0.000024) | 1 vCPU로 1시간이면 3,600 vCPU초라 무료 구간 안이면 $0, 넘어도 약 $0.1 미만 |
| Cloud Build, Artifact Registry | 소스 배포 때 빌드와 이미지 저장. 단가 **미확인** | 배포 몇 번이면 소액으로 예상 |

**중간 번역의 번역 문자 수 (실측, 2026-11-15, 서버의 세션 통계)**: 중간 번역은 진행 중 발화 전체를 매번 다시 번역하므로 발화가 길수록 문자 수가 크게 는다(대략 발화 길이의 제곱).

| 음성(long, 대상 3개) | 확정 번역 문자 | 중간 번역 호출 / 문자 | 배수(중간/확정) |
|---|---|---|---|
| 영어 3문장, 문장 사이 1.5초 쉼(10초) | 336자(9회) | 36회 / 795자 | 약 2.4배 |
| 한국어 2문장, 쉼 있음(6초) | 84자(6회) | 18회 / 129자 | 약 1.5배 |
| 영어 2문장, 쉼 있음(6초) | 207자(6회) | 18회 / 342자 | 약 1.7배 |
| 영어 1문장, 쉼 없이 19.4초 | 1,044자(3회) | 84~87회 / 약 15,500자 | 약 15배 |

쉼을 두고 말하는 일반 발표면 전체 번역 문자 수가 끔 대비 약 2.5~3.5배, 쉼 없이 길게 이어 말하면 10배 이상이 될 수 있다(추정). 비용이 문제면 중간 번역을 끄거나 `INTERIM_GAP_MS`를 늘린다.

프로토타입 테스트(하루 1~2시간)는 위 표를 그대로 곱하면 하루 약 $2~$9다(NMT가 무료 구간이면 STT만 $1~$2). Cloud Run 비용은 이에 비해 무시할 수준이다. 연결이 없을 때는 기본 설정(request-based billing)에서 요청을 처리하거나 시작·종료하는 동안만 과금되므로, 유휴 상태로 두어도 Cloud Run 요금은 거의 없다. 다만 주소가 공개돼 있어 남이 쓰면 STT·번역 요금이 나오므로 테스트 후 삭제한다(8.3절).

단가 출처: https://cloud.google.com/speech-to-text/pricing , https://cloud.google.com/translate/pricing (페이지 본문을 직접 읽지 못해 검색 결과 요약 기준. 실행 전에 다시 확인할 것). Cloud Run: https://docs.cloud.google.com/run/docs/triggering/websockets (WebSocket 과금 방식), https://docs.cloud.google.com/run/docs/configuring/billing-settings (request-based billing), https://docs.cloud.google.com/free/docs/free-cloud-features (무료 구간), https://cloud.google.com/run/pricing (본문이 스크립트로 렌더링돼 직접 읽지 못함)

---

## 11. 이후 확장

- Translation LLM과 Adaptive Translation의 API 파라미터, contextual glossary, Adaptive용 예문(`examples.csv`), 관련 미확인 사항과 비용은 `PLAN-3modes.md`에 정리돼 있다.
- Translation LLM은 같은 `translateText`에서 `model` 경로만 `.../models/general/translation-llm`으로 바꾸면 붙일 수 있는 구조로 둔다. 지금은 이를 위한 추상화나 설정을 넣지 않는다.
