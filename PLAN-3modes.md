# 실시간 다국어 자막 프로토타입 기획서

작성일: 2026-11-14. 문서 확인 결과는 각 항목 옆에 출처 URL을 달았다. 문서로 확인하지 못한 내용은 **미확인**으로 표기했다.

---

## 1. 목표와 범위

**목표**: 발표자 한 명이 브라우저 한 화면에서 마이크로 말하면, 원문 자막과 3개 이상 언어의 번역 자막이 실시간으로 함께 나온다. 번역 방식(NMT / Translation LLM / Adaptive)과 glossary 적용 여부를 바꿔 가며 품질과 지연시간을 비교한다.

**하는 것**
- 마이크 입력 → STT 스트리밍(chirp_3) → 원문 자막(interim과 final)
- final 문장마다 대상 언어별로 번역을 병렬 호출 → 언어별 번역 자막
- 번역 방식 3종 전환, glossary on/off, STT 구문 힌트(같은 용어 목록)
- 언어 10종(en, zh-CN, es, hi, pt, ru, ja, ko, fr, de) 중 원문 1개와 대상 3개 이상 선택

**안 하는 것**: 청중 배포(다중 화면), 로그인, 자막 저장, 확장성, 배포 자동화, 화자 분리, 원문 언어 자동 감지, interim 번역, 모바일 대응.

---

## 2. 화면 구성 (단일 HTML 페이지)

```
┌────────────────────────────────────────────────────────────┐
│ 원문 언어 [ko ▼]   대상 언어 [☑en ☑ja ☑zh-CN ☐es ...]       │
│ 번역 방식 (●NMT ○Translation LLM ○Adaptive)                 │
│ [☑ glossary 적용]           [시작] [정지]   상태: 연결됨      │
├────────────────────────────────────────────────────────────┤
│ 원문(ko)  확정 문장들...                                     │
│           회색 글씨 = interim(진행 중)                       │
├──────────────┬──────────────┬──────────────────────────────┤
│ en           │ ja           │ zh-CN                        │
│ 번역 문장... │ 번역 문장... │ 번역 문장...                 │
│ (방식·ms)    │ (방식·ms)    │ (방식·ms)                    │
└──────────────┴──────────────┴──────────────────────────────┘
```

- 원문 언어: `<select>` 1개. 대상 언어: 체크박스 10개(원문 언어는 비활성화). 3개 미만이면 [시작] 비활성화.
- 번역 방식과 glossary는 진행 중에도 바꿀 수 있다. 바뀐 값은 다음 final 문장부터 적용한다. 각 번역 줄 끝에 사용한 방식과 걸린 시간(ms)을 작게 표시해 비교할 수 있게 한다.
- 원문 언어나 대상 언어를 바꾸려면 정지한 뒤 다시 시작한다. STT 스트림을 다시 열어야 하기 때문이다.
- 오류(예: 특정 언어 번역 실패)는 해당 언어 칸에 빨간 글씨로 한 줄 표시하고, 다른 칸은 계속 동작한다.

---

## 3. 구성도와 데이터 흐름

```
[브라우저]
 getUserMedia → AudioWorklet(48k→16k 다운샘플, Int16, 100ms=3,200바이트)
      │ WebSocket (바이너리 프레임 = 오디오, 텍스트 프레임 = JSON 제어)
      ▼
[Node.js 서버 1개 프로세스 (Express 정적 파일 + ws)]
 ├─ @google-cloud/speech v2 SpeechClient (apiEndpoint: us-speech.googleapis.com)
 │    streamingRecognize → recognizer projects/P/locations/us/recognizers/_
 │    4분 30초마다 새 스트림으로 교체 (5분 상한 대비)
 │      interim → 브라우저로 그대로 전달
 │      final   → 브라우저로 전달 + 번역 시작
 └─ @google-cloud/translate v3 TranslationServiceClient (location: us-central1)
      final 1건 × 대상 언어 N개 → Promise.allSettled 로 병렬 호출
      (방식에 따라 translateText 또는 adaptiveMtTranslate)
      → 언어별로 완료되는 대로 브라우저로 전송
```

- 인증: 서버에서 ADC를 쓴다(`gcloud auth application-default login` 또는 서비스 계정 키). 브라우저에는 키가 없다.
- 오디오 프레임: 100ms × 16kHz × 2바이트 = 3,200바이트. 요청당 오디오 상한 25KB보다 충분히 작다. 출처: https://docs.cloud.google.com/speech-to-text/docs/quotas

### WebSocket 메시지

브라우저 → 서버

| 형식 | 내용 |
|---|---|
| 텍스트 `{"type":"start","source":"ko","targets":["en","ja","zh-CN"],"mode":"nmt","glossary":true}` | 세션 시작. 서버가 STT 스트림을 연다 |
| 바이너리 | LINEAR16 16kHz mono PCM 100ms 조각 |
| 텍스트 `{"type":"settings","mode":"llm","glossary":false}` | 번역 방식이나 glossary 설정 변경. `mode`: `nmt` / `llm` / `adaptive` |
| 텍스트 `{"type":"stop"}` | STT 스트림 종료 |

서버 → 브라우저

| 형식 | 내용 |
|---|---|
| `{"type":"interim","text":"..."}` | 진행 중 원문(덮어쓰기) |
| `{"type":"final","id":12,"text":"..."}` | 확정 원문 |
| `{"type":"translation","id":12,"lang":"en","text":"...","mode":"llm","ms":640}` | 번역 결과(언어별로 따로 도착) |
| `{"type":"error","id":12,"lang":"en","message":"..."}` | 언어별 오류. `id`나 `lang`이 없으면 세션 전체 오류 |

`id`는 final 문장 번호다. 번역이 늦게 도착해도 같은 줄에 붙일 수 있다.

---

## 4. 사용하는 Google API와 핵심 파라미터

### 4.1 Speech-to-Text v2 스트리밍

- 엔드포인트: `us-speech.googleapis.com`. 출처: https://docs.cloud.google.com/speech-to-text/docs/endpoints
- recognizer: `projects/PROJECT_ID/locations/us/recognizers/_`. 미리 만들지 않고 기본 recognizer `_`에 config를 인라인으로 넣는 방식을 제안한다. 만든 recognizer를 써도 되지만 언어를 바꿀 때마다 수정해야 해서 번거롭다. `_` 사용 가능 여부는 **1단계에서 확인**한다.
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
  이후 요청에는 `{"audio": <bytes>}`만 보낸다.
  `explicitDecodingConfig`와 `streamingFeatures.interimResults`의 필드 이름은 v2 API 지식에 의존한 것으로 **미확인**이다(이번에 v2 레퍼런스를 직접 보지 않았다). `us-speech.googleapis.com`은 엔드포인트 문서에 나와 있지만, 그 페이지는 v2를 명시하지 않는다. 둘 다 3단계에서 확인한다.
- 구문 힌트에는 glossary CSV에서 **원문 언어 열**의 용어만 넣는다. chirp_3에서 `boost`가 효과가 있는지는 **미확인**이다. adaptation 문서에 chirp 모델 언급이 없다(https://docs.cloud.google.com/speech-to-text/docs/adaptation-model). 효과가 없으면 boost를 빼고 value만 둔다.
- 스트림은 최대 5분이고 오디오는 실시간에 가까운 속도로 보내야 한다. 출처: https://docs.cloud.google.com/speech-to-text/docs/quotas
  - 재연결 방식: 4분 30초가 되면 새 스트림을 열고, 이후 오디오는 새 스트림으로 보낸다. 이전 스트림은 입력을 끝낸 뒤 final이 나올 때까지 응답만 받고 닫는다. 경계에서 단어가 잘리는 것은 허용한다(프로토타입).
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

### 4.2 Cloud Translation v3: 공통 사항

- 지역은 모두 `us-central1`이다. glossary가 `us-central1`에만 있을 수 있으므로 번역 호출도 같은 지역으로 맞춘다. 출처: https://docs.cloud.google.com/translate/docs/advanced/glossary
- 언어 지원: 10개 언어 모두 NMT와 Translation LLM의 공식 지원 언어다. NMT와 TLLM은 목록 안에서 **어떤 언어에서 어떤 언어로든** 번역할 수 있다. 문서에 "Languages supported by Translation LLM are also supported for Adaptive Translation"이라고 적혀 있다. 출처: https://docs.cloud.google.com/translate/docs/languages
- 대상 언어 1개당 호출 1회. final 1문장마다 N회를 병렬로 호출한다.
- glossary 공통 형태:
  ```json
  "glossaryConfig": {
    "glossary": "projects/PROJECT_NUMBER/locations/us-central1/glossaries/conf-terms",
    "ignoreCase": true,
    "contextual_translation_enabled": false
  }
  ```
  - glossary 가이드에는 이 필드가 snake_case로 적혀 있다. 그런데 REST 레퍼런스의 `TranslateTextGlossaryConfig`에는 `glossary`와 `ignoreCase`만 있고 contextual 필드가 없다(레퍼런스가 갱신되지 않은 것으로 추정). Node 클라이언트에서 `contextualTranslationEnabled`가 받아들여지는지는 **미확인**이다. 1단계에서 확인한다. 출처: https://docs.cloud.google.com/translate/docs/reference/rest/v3/TranslateTextGlossaryConfig
  - glossary 매칭은 기본적으로 대소문자를 구분한다. 발화 텍스트는 대소문자가 일정하지 않으므로 `ignoreCase: true`로 둔다.
  - 문서상 contextual glossary(품질 향상 기능)는 **Translation LLM만** 지원한다.
  - 출처: https://docs.cloud.google.com/translate/docs/advanced/glossary , https://docs.cloud.google.com/translate/release-notes (2024-11-04: Glossary가 TLLM과 Adaptive Translation 지원)

### 4.3 방식 (1) NMT

`POST https://translation.googleapis.com/v3/projects/P/locations/us-central1:translateText`
```json
{
  "contents": ["원문 문장"],
  "sourceLanguageCode": "ko",
  "targetLanguageCode": "en",
  "mimeType": "text/plain",
  "model": "projects/P/locations/us-central1/models/general/nmt",
  "glossaryConfig": { "glossary": "...", "ignoreCase": true }
}
```
- 응답의 `translations`는 glossary를 적용하기 **전** 번역이고, `glossaryTranslations`는 적용한 번역이다. glossary가 켜져 있으면 `glossaryTranslations[0].translatedText`를 표시한다.
- 모델 경로 `.../models/general/nmt`는 REST 레퍼런스에서 확인했다. `model`을 빼면 기본값이 NMT다("If not provided, the default Google model (NMT) will be used").
- 출처: https://docs.cloud.google.com/translate/docs/advanced/glossary , https://docs.cloud.google.com/translate/docs/reference/rest/v3/projects.locations/translateText

### 4.4 방식 (2) Translation LLM

위와 같은 `translateText`를 쓰고 `model`만 바꾼다.
```json
"model": "projects/P/locations/us-central1/models/general/translation-llm",
"glossaryConfig": { "glossary": "...", "ignoreCase": true, "contextual_translation_enabled": true }
```
- 모델 ID `general/translation-llm`. 출처: https://docs.cloud.google.com/translate/docs/translation-llm
- glossary가 켜져 있으면 contextual을 `true`로 둔다. 이때 응답에는 `glossaryTranslations`만 들어 있다(문서 기준).
- 지원 리전 목록은 문서에 없다(예시는 `us-central1`). `us-central1`에서 동작하는지 1단계에서 확인한다.
- 할당량: 프로젝트당 분당 900요청, 요청당 30,000자. 출처: https://docs.cloud.google.com/translate/quotas

### 4.5 방식 (3) Adaptive Translation

`POST https://translation.googleapis.com/v3/projects/P/locations/us-central1:adaptiveMtTranslate`

**데이터셋 없이 요청 안에 예문을 직접 넣는 방식을 쓴다**(문서에서 지원 확인).
```json
{
  "referenceSentenceConfig": {
    "referenceSentencePairLists": [{
      "referenceSentencePairs": [
        {"sourceSentence": "오늘은 Vertex AI의 새 기능을 소개합니다.", "targetSentence": "Today I'll introduce new features in Vertex AI."}
      ]
    }],
    "sourceLanguageCode": "ko",
    "targetLanguageCode": "en"
  },
  "content": ["원문 문장"],
  "mimeType": "text/plain",
  "glossaryConfig": { "glossary": "...", "ignoreCase": true, "contextual_translation_enabled": true }
}
```
- 인라인 예문은 **최대 5쌍**이고 모두 사용된다. 요청 1건에는 대상 언어 1개만 넣을 수 있다.
- 데이터셋 방식(`adaptiveMtDatasets` 생성 후 `importAdaptiveMtFile`)은 언어쌍마다 데이터셋이 따로 필요하고 TSV/TMX로 최소 5쌍을 넣어야 한다. 10개 언어의 임의 조합을 지원하려면 데이터셋이 최대 90개 필요하므로 **이번에는 쓰지 않는다**.
- 언어쌍: 10개 언어 모두 지원 목록에 있다. 다만 "TLLM처럼 임의 조합이 된다"는 것은 TLLM 문서의 any-to-any 문장과 "TLLM 지원 언어 = Adaptive 지원 언어" 문장을 합쳐서 추론한 것이다. Adaptive 문서에 언어쌍 제약이 명시돼 있지는 않다(**영어가 아닌 언어끼리의 조합, 예: ko→ja는 미확인**).
- 리전: 문서 예시는 `us-central1`뿐이고 전체 리전 목록은 없다(**미확인**).
- glossary: glossary 가이드에 `adaptiveMtTranslate` + `glossaryConfig` 예시가 있다. 다만 그 예시는 `dataset`을 쓰는 형태이고 preview로 표시돼 있다. **인라인 `referenceSentenceConfig`와 glossary를 함께 쓸 수 있는지는 미확인이다.** Adaptive에서 contextual이 효과가 있는지도 미확인이다.
- **가이드와 REST 레퍼런스가 다르다**: REST 레퍼런스의 요청 본문에는 `dataset`(Required), `content`, `referenceSentenceConfig`만 있고 `glossaryConfig`가 없다. 응답에도 `translations[].translatedText`와 `languageCode`만 있고 `glossaryTranslations`가 없다. 반면 가이드는 dataset 없이 인라인 예문만 쓰는 예시를 보여준다. 따라서 아래 두 가지를 1단계에서 확인한다(**미확인**).
  - dataset 없이 인라인 예문만으로 호출이 되는지
  - glossary를 켰을 때 결과가 어느 필드에 오는지. 우선 `glossaryTranslations`가 있으면 그것을, 없으면 `translations[0].translatedText`를 표시한다.
  - 출처: https://docs.cloud.google.com/translate/docs/reference/rest/v3/projects.locations/adaptiveMtTranslate
- **인라인 예문 + glossary 조합이 거부될 때의 대체 방법**(가장 단순한 것부터):
  1. Adaptive 모드에서는 glossary 체크박스를 비활성화하고 "Adaptive는 glossary 미적용"이라고 표시한다. 대신 예문에 용어를 넣어 반영한다.
  2. glossary가 꼭 필요하면 실제로 쓸 언어쌍(예: ko→en/ja/zh-CN)에 대해서만 dataset을 만든다. `examples.csv`의 열에서 TSV를 만들어 `importAdaptiveMtFile`로 넣는다. 최소 5쌍이 필요하다.
  3. dataset 없이 인라인 호출 자체가 거부되면 2번이 필수가 된다.
- **호출 빈도 제한이 문서끼리 다르다**: Adaptive 문서에는 "The API has a limit of one QPS per project", 할당량 문서에는 분당 900요청으로 적혀 있다. 대상 언어 3개를 병렬로 호출하면 초당 3건이 되므로 1 QPS가 실제 제한이면 429 오류가 난다. 대응: Adaptive 모드에서만 언어별 호출을 **순차 실행**하는 옵션(서버 상수 하나)을 두고, 2단계에서 실제 제한을 측정해 정한다.
- 출처: https://docs.cloud.google.com/translate/docs/advanced/adaptive-translation , https://docs.cloud.google.com/translate/docs/advanced/glossary , https://docs.cloud.google.com/translate/quotas , https://docs.cloud.google.com/translate/docs/languages

### 4.6 Adaptive가 지원하지 않는 조합 처리 (제안)

- 문서상 10개 언어는 모두 지원되므로 조합을 미리 비활성화하는 목록은 **만들지 않는다**.
- 실제 호출에서 특정 조합이 실패하면 오류를 해당 언어 칸에 그대로 표시한다(3절의 `error` 메시지). 다른 언어는 계속 동작한다.
- 검증(8절)에서 실패한 조합이 나오면 그때 서버에 `ADAPTIVE_UNSUPPORTED = ["ko>hi", ...]` 같은 상수 하나를 두고, 화면에서 Adaptive를 고를 때 해당 대상 언어 칸에 "Adaptive 미지원(NMT로 대체)"라고 표시한 뒤 그 칸만 NMT로 호출한다.

---

## 5. 데이터 준비

### 5.1 glossary (equivalent term set 1개)

1. `glossary.csv` 작성: 첫 행은 언어 코드 헤더이고, 이후 한 행이 용어 하나다. 비어 있는 칸도 허용된다.
   ```
   en,zh-CN,es,hi,pt,ru,ja,ko,fr,de
   Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI,Vertex AI
   large language model,大语言模型,modelo de lenguaje grande,...,대규모 언어 모델,...
   ```
   - 형식은 CSV만 가능하고, 선택 열로 `pos`와 `description`을 둘 수 있다. 전체 크기 10,485,760바이트 이하이고, 1,024바이트를 넘는 용어는 무시된다. 한 glossary에 넣을 수 있는 **언어 수 상한은 문서에 없다(미확인)**.
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
4. 수정할 때는 삭제한 뒤 다시 만든다(프로토타입이므로 이것으로 충분하다).
5. 서버는 시작할 때 로컬 `glossary.csv`를 읽어 STT 구문 힌트를 만든다(원문 언어 열, 빈 칸 제외, 100자 이하, 최대 1,000개).

출처: https://docs.cloud.google.com/translate/docs/advanced/glossary

### 5.2 Adaptive용 예문

- `examples.csv`를 만든다. glossary와 같은 10개 언어 열에, 행마다 같은 뜻의 문장을 언어별로 쓴다. **5행이면 충분하다**(인라인 상한이 5쌍).
- 서버는 원문 언어 열과 대상 언어 열을 골라 `referenceSentencePairs` 5쌍을 즉석에서 만든다. 이렇게 하면 어떤 언어 조합이든 파일 하나로 해결되고 데이터셋을 만들 필요가 없다.
- 각 쌍은 원문과 번역을 합쳐 512자 이하로 한다(데이터셋 기준 제한이므로 인라인에도 적용될 것으로 보고 지킨다).
- 예문은 발표 문체와 용어가 드러나게 쓴다. 예문에 glossary 용어를 포함하면 Adaptive만으로도 용어가 반영되는지 비교할 수 있다.

---

## 6. GCP 사전 설정 체크리스트

- [ ] 프로젝트 선택, 결제 연결
- [ ] API 활성화: `speech.googleapis.com`, `translate.googleapis.com`, `storage.googleapis.com`
- [ ] 인증(아래 역할 이름은 기억에 의존한 것으로 **미확인**. 권한 오류가 나면 IAM 문서에서 확인한다): 로컬 개발에서는 `gcloud auth application-default login`과 `gcloud auth application-default set-quota-project P`. 서비스 계정을 쓸 경우 다음 역할을 준다.
  - `roles/speech.client` (STT)
  - `roles/cloudtranslate.user` (번역 호출)
  - glossary를 만들 때 `roles/cloudtranslate.editor`(또는 일회성으로 Owner 계정 사용)
  - Translation 서비스 에이전트 또는 생성 주체가 버킷을 읽을 수 있어야 한다: `roles/storage.objectViewer`
- [ ] GCS 버킷 생성(`us-central1`), `glossary.csv` 업로드
- [ ] glossary `conf-terms` 생성 후 상태 확인(`GET .../glossaries/conf-terms`)
- [ ] recognizer: 기본 `_` 사용(별도 생성 없음). 실패하면 `us`에 chirp_3 recognizer 1개를 만들어 쓴다.
- [ ] 할당량 확인: Adaptive 분당 요청 수, TLLM 분당 요청 수(콘솔의 할당량 페이지)
- [ ] 마이크 권한: `http://localhost`에서 열면 HTTPS가 없어도 getUserMedia가 동작한다.

---

## 7. 구현 단계

각 단계는 한 번에 확인할 수 있는 크기로 나눴다. 파일은 `server.js` 하나와 `public/index.html` 하나(worklet은 인라인 Blob 또는 `public/worklet.js`)로 한다.

| # | 작업 | 확인 방법 |
|---|---|---|
| 1 | API 단건 점검 스크립트: NMT, TLLM, Adaptive(인라인 예문)를 각각 glossary on/off로 ko→en, ko→ja 1문장씩 호출 | 6가지 조합 모두 응답이 온다. `glossaryTranslations` 위치, contextual 필드 이름(camel/snake), `general/nmt` 경로를 확정 |
| 2 | Adaptive 연속 호출 테스트: 3개 언어를 병렬로 10회 호출 | 429 여부로 1 QPS 제한이 실제인지 판단하고, 병렬/순차를 결정 |
| 3 | 서버에서 STT만: 16kHz WAV 파일을 100ms 단위로 실시간 속도로 흘려 `streamingRecognize` 호출 | 콘솔에 interim/final이 찍힌다. chirp_3의 interim 여부를 여기서 확인 |
| 4 | 브라우저 마이크 → AudioWorklet → WebSocket → 서버 STT | 말하면 화면 원문 영역에 interim(회색)과 final이 나온다 |
| 5 | final → 대상 언어별 병렬 번역 → 화면 칸별 표시(NMT만) | 3개 언어 칸에 번역이 나오고 ms가 표시된다 |
| 6 | 번역 방식 3종 전환과 glossary on/off 반영 | 진행 중 전환 시 다음 문장부터 표시되는 방식명이 바뀐다 |
| 7 | STT 구문 힌트(glossary 원문 열) 추가 | 힌트 on/off로 용어 인식률 차이를 귀로 확인(같은 녹음 파일 재생) |
| 8 | 4분 30초 스트림 교체 | 6분 이상 연속 발화해도 자막이 끊기지 않는다(교체 시점 로그) |
| 9 | 오류 표시: 언어별 실패, WebSocket 끊김 시 상태 표시 | 잘못된 glossary 이름으로 실행해 해당 칸에만 오류가 표시된다 |

---

## 8. 검증 항목 (미확인 사항)

| 항목 | 확인 방법 |
|---|---|
| chirp_3 스트리밍에서 interim 결과가 나오는지, 나온다면 주기는 얼마인지(문서 예시는 `interim_results=False`) | 7절 3단계 |
| 기본 recognizer `_` + 인라인 config로 chirp_3 스트리밍이 되는지 | 7절 3단계 |
| chirp_3에서 phrase `boost`가 효과가 있는지 | 7절 7단계 |
| final이 문장 단위로 나오는지, 너무 길거나 짧게 끊기는지(번역 품질과 지연에 영향) | 실제 발화 5분 |
| 한국어 조사가 붙은 용어(예: "버텍스AI는", "대규모 언어 모델을")가 glossary에 매칭되는지. NMT는 문자열 일치 방식이라 실패할 가능성이 높고, TLLM contextual은 처리할 가능성이 있다 | 조사 붙은 문장 10개를 3방식 × glossary on/off로 비교 |
| equivalent term set 하나에 10개 언어를 넣을 수 있는지(문서에 언어 수 상한 없음) | glossary 생성 성공 여부 |
| Adaptive: 영어가 아닌 언어끼리의 조합(ko→ja, zh-CN→de 등)이 되는지 | 2단계에서 언어쌍 몇 개 호출 |
| Adaptive: 인라인 예문 + glossaryConfig 조합이 되는지, contextual이 효과가 있는지 | 1단계 |
| Adaptive: 1 QPS vs 분당 900, 어느 쪽이 실제 제한인지 | 2단계 |
| TLLM과 Adaptive를 `us-central1`에서 쓸 수 있는지 | 1단계 |
| 방식별 지연시간(final 수신부터 번역 표시까지 p50/p95) | 화면의 ms 값을 문장 30개 기준으로 기록 |
| 스트림 교체 경계에서 단어가 누락되는지 | 8단계 로그와 녹음 대조 |
| 힌디어·러시아어 등 비라틴 문자 원문에서 STT 품질 | 해당 언어 화자 또는 녹음 |

---

## 9. 대략 비용 (1시간 발표 기준, 대략치)

가정: 영어 기준 약 150단어/분, 원문 약 54,000자/시간, 대상 언어 3개 → 번역 입력 약 162,000자/시간.

| 항목 | 단가 | 1시간 추정 |
|---|---|---|
| STT v2 (chirp_3) | 분당 $0.016(0~50만 분 구간, chirp_3 별도 단가는 미확인) | 약 $1 |
| NMT (Advanced) | 백만 자당 $20, 월 50만 자 무료(**미확인, 기억 기반**) | 약 $3.2 (무료 구간이면 $0) |
| Translation LLM | 입력·출력 각각 백만 자당 $10 | 입력+출력 약 $3.2 |
| Adaptive | 입력·출력 각각 백만 자당 $25 | 약 $8 + 인라인 예문 문자 수(호출마다 예문 5쌍이 입력에 포함되는지 **미확인**. 포함되면 문장당 수백~1,000자가 추가되어 수 배로 늘어남) |
| glossary | 번역 문자 수 기준 과금 | 위 금액에 포함 |
| GCS | 무시할 수준 | ~$0 |

프로토타입 테스트(하루 1~2시간)는 대략 하루 $5~$20 범위로 본다. 단가 출처: https://cloud.google.com/speech-to-text/pricing , https://cloud.google.com/translate/pricing (페이지 본문을 직접 읽지 못해 검색 결과 요약 기준. 실행 전에 다시 확인할 것)
