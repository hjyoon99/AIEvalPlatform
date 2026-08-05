# 고객 AI Adapter 연동 가이드

## 1. 이 가이드의 목표

고객사의 기존 AI 서비스에 AIEvalPlatform을 연결하여 다음 전체 흐름을 실행한다.

```text
평가 담당자가 EvalRun 생성
→ Backend가 질문별 SdkJob 생성
→ 고객사 Adapter가 SdkJob 수신
→ Adapter가 기존 고객 AI API 호출
→ 생성 답변을 Backend에 제출
→ JudgeJob 자동 생성
→ Judge가 답변 평가
→ 대시보드에서 점수와 판정 근거 확인
```

Adapter는 고객 AI 자체가 아니다. 평가 플랫폼의 표준 TestCase를 고객 AI API payload로 바꾸고, 고객 AI 응답을 평가 플랫폼의 표준 output으로 되돌리는 별도 프로세스다.

## 2. 현재 MVP에서 가능한 범위

대시보드의 `⇄ 평가 어댑터` 화면에서 다음 작업을 할 수 있다.

- 프로젝트 생성
- AI Application/Adapter 등록
- `aieval_...` 형식 SDK Key 발급
- 등록된 Application 선택
- 단건 SdkJob 생성
- Adapter 연결과 답변 반환 상태 확인

현재 대시보드의 Adapter 화면에서 만드는 단건 Job은 **연결 테스트용**이다. 자동 Judge 평가까지 이어지는 `ADAPTER` EvalRun 생성 화면은 아직 연결되지 않았으므로 전체 평가 실행은 Backend API를 사용한다.

```text
대시보드 단건 Job
→ Adapter 연결 확인

POST /api/v1/eval-runs (executionMode=ADAPTER)
→ SdkJob → JudgeJob → EvalResult 전체 평가
```

## 3. 사전 준비

### 3.1 평가 플랫폼 실행

AIEvalPlatform 저장소 루트에서:

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
```

다음 서비스가 `healthy`인지 확인한다.

```text
postgres
mock-agent-engine
backend
dashboard
```

접속 주소:

```text
Dashboard: http://localhost:5173
Backend:   http://localhost:3000/api/v1
```

### 3.2 고객 AI API 확인

Adapter를 만들기 전에 고객 AI를 직접 호출할 수 있어야 한다.

예:

```bash
curl -X POST http://localhost:9000/api/chat \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer customer-token' \
  --data '{
    "message": "환불 기간을 알려주세요.",
    "sessionId": "eval-test-session"
  }'
```

가정하는 고객 응답 예:

```json
{
  "answer": "상품 수령 후 7일 이내에 환불할 수 있습니다.",
  "model": "customer-agent-v3",
  "traceId": "trace-123",
  "retrievedDocuments": [
    {
      "id": "refund-policy",
      "title": "환불 정책"
    }
  ]
}
```

고객 AI API의 실제 요청 및 응답 구조가 이 예와 달라도 된다. 그 차이를 Adapter의 `invoke()`에서 매핑한다.

## 4. 대시보드에서 Adapter 등록

### 4.1 프로젝트 생성

1. 브라우저에서 `http://localhost:5173`에 접속한다.
2. 오른쪽 위 `프로젝트 관리`를 누른다.
3. 이름, 도메인, 설명을 입력하고 `새 프로젝트 추가`를 누른다.
4. 예를 들어 다음과 같이 등록한다.

```text
이름: 고객지원 AI
도메인: customer-support
설명: 환불 및 주문 상담 서비스
```

### 4.2 Application 등록과 SDK Key 발급

1. 왼쪽 메뉴에서 `⇄` 아이콘을 선택한다.
2. `평가 어댑터` 화면의 프로젝트를 선택한다.
3. 다음 값을 입력한다.

```text
이름: customer-support-adapter
환경: development
```

4. `등록 및 SDK Key 발급`을 누른다.
5. 화면에 표시된 SDK Key를 즉시 안전한 곳에 복사한다.

등록 결과에는 서로 다른 두 값이 있다.

```text
Application ID
예: 830c5c3d-e40f-469f-bd83-3d1abd5e7f2a
→ ADAPTER EvalRun의 applicationId에 사용

SDK Key
예: aieval_xxxxxxxxxxxxxxxxx
→ Adapter의 AIEVAL_SDK_KEY에 사용
```

UUID 형식 Application ID를 SDK Key로 사용하면 인증에 실패한다. SDK Key 원문은 발급 직후 한 번만 표시된다.

## 5. 고객사 프로젝트에 Adapter 디렉터리 만들기

기존 고객 AI 프로젝트에 다음과 같이 별도 디렉터리를 추가하는 방식을 권장한다.

```text
customer-ai-service/
├── src/                         # 기존 고객 AI 코드
├── package.json                 # 기존 고객 AI 설정
└── evaluation-adapter/          # 새로 추가
    ├── src/
    │   └── adapter.mjs          # 고객별 invoke() 구현
    ├── package.json
    ├── .env                     # 실제 값, Git 커밋 금지
    ├── .env.example             # 변수 이름만 커밋
    ├── .gitignore
    └── Dockerfile               # 컨테이너 실행 시 선택
```

Adapter를 기존 AI 서버 프로세스에 합치지 않고 독립 디렉터리와 독립 프로세스로 두는 이유는 다음과 같다.

- 평가를 중지해도 운영 AI에 영향을 주지 않는다.
- SDK 장애와 운영 AI 장애를 분리한다.
- 평가 전용 인증정보를 운영 코드와 분리한다.
- 고객별 변경 범위를 `evaluation-adapter`에 제한한다.

## 6. SDK 준비

### 6.1 현재 MVP: 로컬 SDK 패키지 만들기

현재 `@aieval/sdk`는 공개 npm Registry에 배포되지 않은 로컬 패키지다. AIEvalPlatform 저장소에서 먼저 패키지를 빌드한다.

```bash
cd "/path/to/AI Agent/packages/sdk"
npm install
npm run build
npm pack
```

다음과 같은 파일이 생성된다.

```text
aieval-sdk-0.0.1.tgz
```

고객사 Adapter 디렉터리에서 설치한다.

```bash
cd /path/to/customer-ai-service/evaluation-adapter
npm install "/path/to/AI Agent/packages/sdk/aieval-sdk-0.0.1.tgz"
```

SDK를 사내 npm Registry에 배포하게 되면 다음 형태로 단순화할 수 있다.

```bash
npm install @aieval/sdk
```

## 7. 고객사 Adapter 파일 작성

### 7.1 `package.json`

경로:

```text
customer-ai-service/evaluation-adapter/package.json
```

내용:

```json
{
  "name": "customer-ai-evaluation-adapter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --env-file=.env src/adapter.mjs"
  },
  "engines": {
    "node": ">=20"
  }
}
```

앞 단계의 `npm install`을 실행하면 `dependencies`에 `@aieval/sdk`가 자동 추가된다.

### 7.2 `.gitignore`

경로:

```text
customer-ai-service/evaluation-adapter/.gitignore
```

내용:

```gitignore
node_modules/
.env
*.log
```

### 7.3 `.env.example`

경로:

```text
customer-ai-service/evaluation-adapter/.env.example
```

내용:

```env
# 평가 Backend
AIEVAL_BASE_URL=http://localhost:3000/api/v1
AIEVAL_SDK_KEY=aieval_replace_me

# 고객 AI
CUSTOMER_AI_URL=http://localhost:9000/api/chat
CUSTOMER_AI_TOKEN=replace_me

# Adapter polling
AIEVAL_POLL_INTERVAL_MS=1000
```

### 7.4 `.env`

`.env.example`을 `.env`로 복사한 뒤 실제 값을 넣는다.

```env
AIEVAL_BASE_URL=http://localhost:3000/api/v1
AIEVAL_SDK_KEY=aieval_대시보드에서_발급받은_키

CUSTOMER_AI_URL=http://localhost:9000/api/chat
CUSTOMER_AI_TOKEN=고객_AI_내부_API_토큰

AIEVAL_POLL_INTERVAL_MS=1000
```

`.env`에는 인증정보가 있으므로 Git에 커밋하지 않는다.

### 7.5 `src/adapter.mjs`

경로:

```text
customer-ai-service/evaluation-adapter/src/adapter.mjs
```

기본 HTTP Adapter 예:

```js
import { createEvaluationAdapter } from '@aieval/sdk';

const requiredEnvironmentVariables = [
  'AIEVAL_BASE_URL',
  'AIEVAL_SDK_KEY',
  'CUSTOMER_AI_URL',
];

for (const name of requiredEnvironmentVariables) {
  if (!process.env[name]) {
    throw new Error(`${name} 환경변수가 필요합니다.`);
  }
}

const adapter = createEvaluationAdapter({
  baseUrl: process.env.AIEVAL_BASE_URL,
  sdkKey: process.env.AIEVAL_SDK_KEY,
  pollIntervalMs: Number(process.env.AIEVAL_POLL_INTERVAL_MS ?? 1000),

  async invoke(testCase, context) {
    const startedAt = Date.now();

    const response = await fetch(process.env.CUSTOMER_AI_URL, {
      method: 'POST',
      signal: context.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.CUSTOMER_AI_TOKEN
          ? {
              Authorization: `Bearer ${process.env.CUSTOMER_AI_TOKEN}`,
            }
          : {}),
      },
      body: JSON.stringify({
        message: testCase.prompt,
        sessionId: `aieval-${context.jobId}`,
        variables: testCase.variables ?? {},
      }),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(
        `고객 AI 호출 실패: HTTP ${response.status} ${responseBody}`,
      );
    }

    const payload = await response.json();

    if (typeof payload.answer !== 'string' || payload.answer.length === 0) {
      throw new Error('고객 AI 응답에 비어 있지 않은 answer가 필요합니다.');
    }

    return {
      output: payload.answer,
      metadata: {
        model: payload.model,
        modelVersion: payload.modelVersion,
        latencyMs: Date.now() - startedAt,
        traceId: payload.traceId,
        tokenUsage: payload.tokenUsage,
        retrievedDocuments: payload.retrievedDocuments,
        toolCalls: payload.toolCalls,
      },
    };
  },

  onError(error) {
    console.error('[AIEval Adapter]', error);
  },
});

console.log('AIEval Adapter가 SdkJob을 기다립니다.');
await adapter.start();
```

고객사가 반드시 수정할 부분은 다음 세 곳이다.

1. `body: JSON.stringify(...)`: 고객 AI 요청 payload
2. `headers`: 고객사 내부 인증 방식
3. `output: payload.answer`: 고객 응답에서 최종 답변을 꺼내는 경로

SDK가 담당하는 부분은 수정하지 않는다.

```text
Job polling
Job claim
lease
timeout signal
start/complete/fail API
재시도 가능한 실행 상태
```

## 8. 고객 API 유형별 `invoke()` 예

### 8.1 단순 Chat API

고객 요청:

```json
{
  "message": "질문"
}
```

고객 응답:

```json
{
  "answer": "최종 답변"
}
```

매핑:

```js
body: JSON.stringify({
  message: testCase.prompt,
}),
```

```js
return {
  output: payload.answer,
};
```

### 8.2 RAG API

고객 요청:

```json
{
  "query": "질문",
  "filters": {
    "department": "support"
  }
}
```

고객 응답:

```json
{
  "result": {
    "answer": "최종 답변",
    "sources": []
  }
}
```

매핑:

```js
body: JSON.stringify({
  query: testCase.prompt,
  filters: testCase.variables?.filters ?? {},
}),
```

```js
return {
  output: payload.result.answer,
  metadata: {
    retrievedDocuments: payload.result.sources,
  },
};
```

### 8.3 세션 기반 대화 API

평가 Case끼리는 서로 영향을 주지 않게 Case 또는 Job별 새 세션을 사용하는 것을 권장한다.

```js
body: JSON.stringify({
  message: testCase.prompt,
  sessionId: `evaluation-${context.jobId}`,
}),
```

멀티턴 평가가 필요하다면 `testCase.variables`에 이전 대화나 고정된 세션 시나리오를 넣고 고객 API 사양에 맞춰 전달한다. 현재 MVP는 완전한 멀티턴 세션 오케스트레이션을 제공하지 않는다.

### 8.4 도구 호출 Agent API

최종 답변과 함께 도구 호출 정보를 metadata에 저장할 수 있다.

```js
return {
  output: payload.finalAnswer,
  metadata: {
    toolCalls: payload.trace?.toolCalls,
    traceId: payload.traceId,
  },
};
```

현재 Judge는 주로 최종 답변을 평가한다. 도구 선택과 인자 정확성을 별도 채점하는 기능은 후속 확장 대상이다.

## 9. Adapter 실행

고객사 Adapter 디렉터리에서:

```bash
npm start
```

정상 출력:

```text
AIEval Adapter가 SdkJob을 기다립니다.
```

Adapter는 평가 Backend로 outbound polling 요청을 보낸다. Job이 없을 때 기다리는 것은 정상 동작이다.

## 10. 대시보드에서 단건 연결 테스트

1. 대시보드의 `⇄ 평가 어댑터` 화면으로 이동한다.
2. 등록한 Application을 선택한다.
3. 테스트 질문을 입력한다.
4. 필요한 경우 Variables에 JSON 객체를 입력한다.

예:

```json
{
  "orderId": "eval-order-001",
  "filters": {
    "department": "support"
  }
}
```

5. 테스트 Job을 생성한다.
6. Adapter 터미널에서 `받은 TestCase` 또는 고객사가 추가한 로그를 확인한다.
7. 대시보드의 Job 상태가 다음과 같이 바뀌는지 확인한다.

```text
PENDING
→ CLAIMED/RUNNING
→ COMPLETED
```

이 단계는 Backend ↔ Adapter ↔ 고객 AI 연결을 검증한다. Judge 결과까지 확인하려면 다음 ADAPTER EvalRun을 실행한다.

## 11. 전체 ADAPTER 평가 실행

현재는 API 요청을 사용한다. `PROJECT_ID`와 `APPLICATION_ID`를 대시보드에서 등록한 실제 값으로 바꾼다.

```bash
curl -X POST http://localhost:3000/api/v1/eval-runs \
  -H 'Content-Type: application/json' \
  --data '{
    "name": "고객지원 AI Adapter 평가",
    "projectId": "PROJECT_ID",
    "applicationId": "APPLICATION_ID",
    "executionMode": "ADAPTER",
    "judgeModel": "mock-judge",
    "timeoutMs": 30000,
    "maxAttempts": 3,
    "dataset": [
      {
        "id": "refund-001",
        "prompt": "상품을 받은 지 5일 됐는데 환불할 수 있나요?",
        "variables": {
          "customerGrade": "normal"
        },
        "expectedOutput": "정책 조건을 충족하면 수령 후 7일 이내에 환불할 수 있습니다."
      },
      {
        "id": "cancel-001",
        "prompt": "주문을 취소해주세요.",
        "variables": {
          "orderId": "eval-order-001"
        },
        "expectedBehavior": [
          "주문 상태를 확인한다",
          "취소 가능 여부를 안내한다"
        ],
        "failConditions": [
          "확인 없이 취소 완료를 알린다"
        ]
      }
    ]
  }'
```

자동 실행 흐름:

```text
EvalRun 1개
→ EvalRunCase 2개
→ SdkJob 2개
→ Adapter가 고객 AI 두 번 호출
→ JudgeJob 2개
→ EvalResult 2개
```

## 12. 결과 확인

### 12.1 대시보드

1. 왼쪽 첫 번째 `⌁ 평가 실행` 메뉴로 이동한다.
2. `최근 실행`에서 실행 이름을 선택한다.
3. 아래 `RESULT EXPLORER`로 이동한다.
4. 각 Case에서 다음 정보를 확인한다.

```text
질문
고객 AI 답변
기준 답변
종합 품질 점수
정확성
관련성
완전성
근거 충실성
안전성
Verifier 결과
Supervisor 판정과 확신도
재시도 횟수
```

Mock Judge는 실제 의미 평가가 아니라 규칙 기반 점수를 반환한다. 현재 일반 질문의 Mock 점수 예시는 다음과 같다.

```text
종합 점수      92
정확성         94%
관련성         90%
완전성         86%
근거 충실성    93%
안전성        100%
확신도         95%
```

### 12.2 API

EvalRun 생성 응답의 `id`를 사용한다.

```bash
curl -s http://localhost:3000/api/v1/eval-runs/RUN_ID | jq
```

## 13. Adapter를 Docker로 실행하는 경우

고객사 프로젝트의 `evaluation-adapter/Dockerfile` 예:

```dockerfile
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src ./src

CMD ["node", "src/adapter.mjs"]
```

Docker에서는 `.env`를 이미지에 복사하지 않고 실행 환경에서 주입한다.

```bash
docker build -t customer-ai-evaluation-adapter .
docker run --rm \
  --env-file .env \
  customer-ai-evaluation-adapter
```

Adapter가 컨테이너이고 평가 Backend가 호스트에서 실행 중이면:

```env
AIEVAL_BASE_URL=http://host.docker.internal:3000/api/v1
```

고객 AI도 호스트에서 실행 중이면:

```env
CUSTOMER_AI_URL=http://host.docker.internal:9000/api/chat
```

Adapter가 AIEvalPlatform과 같은 Compose 네트워크에서 실행되면:

```env
AIEVAL_BASE_URL=http://backend:3000/api/v1
```

## 14. 문제 해결

### `SDK Worker 오류: 401` 또는 `403`

- `AIEVAL_SDK_KEY`가 `aieval_...` 형식인지 확인한다.
- Application ID를 SDK Key 자리에 넣지 않았는지 확인한다.
- 해당 Application이 비활성화되지 않았는지 확인한다.

### Adapter가 아무 로그 없이 대기

처리할 SdkJob이 없으면 정상이다. 대시보드에서 단건 Job을 만들거나 `executionMode: ADAPTER` EvalRun을 생성한다.

### 고객 AI를 호출할 수 없음

- Adapter 실행 위치에서 `CUSTOMER_AI_URL`을 `curl`로 직접 호출한다.
- 컨테이너 안에서 `localhost`는 컨테이너 자신이라는 점을 확인한다.
- 사내 DNS, 인증서, Proxy, 방화벽과 인증 헤더를 확인한다.

### Job이 계속 실패하거나 재시도

```bash
docker compose logs -f backend
```

Adapter 프로세스 로그와 고객 AI 서버 로그도 함께 확인한다. 고객 AI 오류 응답에 개인정보나 인증정보가 포함될 수 있으므로 오류 전문을 운영 로그에 남기는 정책은 고객사 보안 기준에 맞게 조정한다.

### 수정한 Adapter 코드가 반영되지 않음

로컬 Node 프로세스면 재시작한다.

```bash
npm start
```

Docker 이미지면 다시 빌드한다.

```bash
docker compose build customer-adapter
docker compose up -d customer-adapter
```

## 15. 운영 전 체크리스트

- Adapter가 평가 Backend와 고객 AI 두 주소에 접근할 수 있다.
- SDK Key와 고객 AI 토큰이 Git 및 이미지에 포함되지 않았다.
- 평가 Case마다 독립 세션을 사용하거나 세션 초기화 정책이 있다.
- 고객 AI timeout이 EvalRun의 `timeoutMs`보다 짧거나 같은 수준으로 관리된다.
- 답변 필드가 항상 문자열로 정규화된다.
- RAG 문서와 도구 호출 metadata에 개인정보가 포함되는지 검토했다.
- 운영 데이터가 아닌 안전한 평가 계정과 테스트 주문을 사용한다.
- Adapter와 고객 AI 로그에서 질문·답변 보존 정책을 확인했다.
- 실제 Judge 도입 전 사람 평가 데이터로 Judge 일치도를 검증한다.
