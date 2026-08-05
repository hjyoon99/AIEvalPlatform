# AIEval SDK `.tgz` 고객사 설치 및 연동 가이드

## 1. 문서 목적

이 문서는 고객사가 전달받은 AIEval SDK 패키지(`aieval-sdk-0.0.1.tgz`)를 설치하고, 고객 AI 서비스와 연결하는 Adapter를 실행하기 위한 가이드다.

Adapter는 고객 AI 서비스를 변경하거나 대체하지 않는다. 평가 플랫폼에서 TestCase를 받아 고객 AI API를 호출하고, 그 답변을 다시 평가 플랫폼에 제출하는 별도 프로세스다.

```text
AIEval 평가 플랫폼
        ↓ TestCase 수신
고객사 Evaluation Adapter
        ↓ 고객 API 형식으로 변환
고객 AI 서비스
        ↓ 답변 반환
고객사 Evaluation Adapter
        ↓ 평가 결과 제출
AIEval 평가 플랫폼
```

Adapter는 고객사 환경에서 평가 플랫폼 방향으로 outbound 통신을 시작하므로, 고객 AI API를 외부에 공개할 필요가 없다.

### 고객 AI 서비스가 Python인 경우

현재 전달되는 `.tgz`는 Node.js용 SDK이므로 `pip install`할 수 없다. 고객 AI 서비스가 Python, Java 또는 다른 언어로 작성되어 있어도 Adapter만 Node.js 별도 프로세스로 실행하고 기존 고객 AI API를 호출하면 된다.

```text
AIEval 평가 플랫폼
        ↕ HTTPS
Node.js Evaluation Adapter (.tgz SDK 사용)
        ↕ 고객사 내부 HTTP
Python AI 서비스 (FastAPI, Flask, Django 등)
```

두 프로세스는 같은 서버, 같은 Pod의 sidecar 또는 별도 컨테이너로 실행할 수 있다. 고객 AI가 이미 HTTP API를 제공한다면 Python 코드는 변경하지 않고 Adapter의 요청 및 응답 매핑만 맞추면 된다.

현재 버전에는 Python 전용 SDK가 포함되어 있지 않다. Python 프로세스 안에 SDK를 직접 내장해야 하는 요구사항이 있다면 Python SDK를 별도로 제공해야 하며, Node.js용 `.tgz`를 Python에서 직접 불러오는 방식은 지원하지 않는다.

## 2. 전달받아야 하는 항목

AIEval 담당자로부터 다음 항목을 전달받는다.

| 항목 | 예시 | 용도 |
|---|---|---|
| SDK 패키지 | `aieval-sdk-0.0.1.tgz` | Adapter에 설치할 SDK |
| SHA-256 체크섬 | `...` | 전달 파일 무결성 확인 |
| 평가 Backend URL | `https://aieval.example.com/api/v1` | Adapter가 Job을 받을 주소 |
| SDK Key | `aieval_...` | Adapter 인증 |
| Application ID | UUID 형식 | 평가 실행 대상 지정 |

SDK Key와 Application ID는 서로 다른 값이다.

- `AIEVAL_SDK_KEY`에는 `aieval_...` 형식의 SDK Key를 사용한다.
- Application ID는 평가 실행을 생성할 때 사용하며 Adapter 환경변수에는 넣지 않는다.
- SDK Key는 비밀정보로 취급하고 메신저, 소스 코드, Git 저장소, 로그에 남기지 않는다.

## 3. 사전 요구사항

- Node.js 20 이상
- npm 9 이상 권장
- 고객 AI API에 접근할 수 있는 실행 환경
- 평가 Backend의 HTTPS 주소에 접근할 수 있는 네트워크

버전을 확인한다.

```bash
node --version
npm --version
```

방화벽 또는 프록시를 사용하는 경우 Adapter 실행 서버에서 평가 Backend의 `443/TCP`에 outbound 연결할 수 있어야 한다. 고객 AI API에 필요한 사내망 연결도 허용되어야 한다.

## 4. SDK 파일 확인

전달받은 파일이 있는 디렉터리에서 체크섬을 확인한다.

macOS:

```bash
shasum -a 256 aieval-sdk-0.0.1.tgz
```

Linux:

```bash
sha256sum aieval-sdk-0.0.1.tgz
```

출력값이 AIEval 담당자가 제공한 SHA-256 값과 일치해야 한다. 일치하지 않으면 설치하지 말고 파일을 다시 전달받는다.

패키지에 포함된 파일을 확인하려면 다음 명령을 사용할 수 있다.

```bash
tar -tzf ./aieval-sdk-0.0.1.tgz
```

## 5. Adapter 프로젝트 생성

고객 AI 서비스와 운영 장애를 분리할 수 있도록 Adapter를 별도 디렉터리와 별도 프로세스로 구성하는 것을 권장한다.

```bash
mkdir evaluation-adapter
cd evaluation-adapter
npm init -y
mkdir src
```

SDK 파일을 Adapter 디렉터리의 `vendor` 폴더에 보관하는 예시는 다음과 같다.

```text
evaluation-adapter/
├── src/
│   └── adapter.mjs
├── vendor/
│   └── aieval-sdk-0.0.1.tgz
├── .env
├── .env.example
├── .gitignore
├── package-lock.json
└── package.json
```

`vendor` 디렉터리를 만든 뒤 전달받은 `.tgz` 파일을 해당 위치에 복사한다.

```bash
mkdir vendor
cp /path/to/aieval-sdk-0.0.1.tgz ./vendor/
```

## 6. SDK 설치

Adapter 디렉터리에서 로컬 `.tgz` 패키지를 설치한다.

```bash
npm install ./vendor/aieval-sdk-0.0.1.tgz
```

설치 결과를 확인한다.

```bash
npm list @aieval/sdk
```

정상 예:

```text
customer-ai-evaluation-adapter@0.1.0
└── @aieval/sdk@0.0.1
```

SDK를 새 버전의 `.tgz`로 교체할 때도 새 파일을 `vendor`에 넣고 같은 방식으로 설치한다.

```bash
npm install ./vendor/aieval-sdk-새버전.tgz
```

설치 후 변경된 `package.json`과 `package-lock.json`은 고객사 저장소에 커밋한다. SDK 패키지 원본을 저장소에 포함할지는 고객사의 바이너리 및 보안 정책을 따른다. 원본을 포함하지 않는 경우 사내 Artifact 저장소에서 동일 파일을 받을 수 있어야 한다.

## 7. 프로젝트 설정

### 7.1 `package.json`

`package.json`을 다음과 같이 설정한다. `dependencies`의 SDK 경로는 `npm install` 실행 시 자동으로 추가된다.

```json
{
  "name": "customer-ai-evaluation-adapter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --env-file=.env src/adapter.mjs",
    "check": "node --check src/adapter.mjs"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@aieval/sdk": "file:vendor/aieval-sdk-0.0.1.tgz"
  }
}
```

### 7.2 `.gitignore`

```gitignore
node_modules/
.env
*.log
```

### 7.3 `.env.example`

```env
# AIEval 평가 Backend
AIEVAL_BASE_URL=https://aieval.example.com/api/v1
AIEVAL_SDK_KEY=aieval_replace_me
AIEVAL_POLL_INTERVAL_MS=1000

# 고객 AI API
CUSTOMER_AI_URL=https://customer-ai.internal.example.com/api/chat
CUSTOMER_AI_TOKEN=replace_me
```

### 7.4 `.env`

```bash
cp .env.example .env
```

`.env`에 실제 값을 입력한다.

```env
AIEVAL_BASE_URL=https://aieval.example.com/api/v1
AIEVAL_SDK_KEY=aieval_발급받은_SDK_Key
AIEVAL_POLL_INTERVAL_MS=1000

CUSTOMER_AI_URL=https://customer-ai.internal.example.com/api/chat
CUSTOMER_AI_TOKEN=고객_AI_API_토큰
```

주의 사항:

- `AIEVAL_BASE_URL`은 일반적으로 `/api/v1`까지 포함한다.
- URL 마지막의 `/`는 있어도 SDK가 제거하지만, 문서와 운영 설정에서는 없는 형태로 통일하는 것을 권장한다.
- `.env`는 Git에 커밋하지 않는다.
- 운영 환경에서는 `.env` 파일 대신 Secret Manager 또는 배포 시스템의 Secret 주입 기능 사용을 권장한다.

## 8. 고객 AI 연결 코드 작성

`src/adapter.mjs`를 생성한다.

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

const pollIntervalMs = Number(
  process.env.AIEVAL_POLL_INTERVAL_MS ?? 1000,
);

if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 100) {
  throw new Error('AIEVAL_POLL_INTERVAL_MS는 100 이상의 숫자여야 합니다.');
}

const adapter = createEvaluationAdapter({
  baseUrl: process.env.AIEVAL_BASE_URL,
  sdkKey: process.env.AIEVAL_SDK_KEY,
  pollIntervalMs,

  async invoke(testCase, context) {
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

    if (
      typeof payload.answer !== 'string' ||
      payload.answer.trim().length === 0
    ) {
      throw new Error(
        '고객 AI 응답에 비어 있지 않은 answer가 필요합니다.',
      );
    }

    return {
      output: payload.answer,
      metadata: {
        model: payload.model,
        modelVersion: payload.modelVersion,
        traceId: payload.traceId,
        tokenUsage: payload.tokenUsage,
        retrievedDocuments: payload.retrievedDocuments,
        toolCalls: payload.toolCalls,
      },
    };
  },

  onError(error) {
    console.error(
      '[AIEval Adapter]',
      error instanceof Error ? error.message : error,
    );
  },
});

const shutdown = (signal) => {
  console.log(`${signal} 수신: Adapter를 종료합니다.`);
  adapter.stop();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('AIEval Adapter가 평가 Job을 기다립니다.');
await adapter.start();
```

고객사 API 사양에 맞게 반드시 확인하거나 수정할 부분은 세 곳이다.

1. `headers`: 고객 AI의 인증 헤더
2. `body: JSON.stringify(...)`: 고객 AI의 요청 payload
3. `output: payload.answer`: 고객 AI 응답에서 최종 답변을 꺼내는 경로

`output`은 공백이 아닌 문자열이어야 한다. 모델명, 추적 ID, 토큰 사용량, 검색 문서, 도구 호출 내역 등은 선택적으로 `metadata`에 넣을 수 있다. 비밀번호, API Key, 개인정보, 원문 프롬프트 등 민감정보는 metadata에 넣지 않는다.

### Python 고객 AI 예시

고객 AI가 FastAPI로 다음 API를 제공한다고 가정한다.

```python
from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI()


class ChatRequest(BaseModel):
    message: str
    sessionId: str
    variables: dict = Field(default_factory=dict)


@app.post("/api/chat")
async def chat(request: ChatRequest):
    answer = await run_customer_ai(
        prompt=request.message,
        session_id=request.sessionId,
        variables=request.variables,
    )

    return {
        "answer": answer,
        "model": "customer-python-agent-v1",
    }
```

Python API를 예를 들어 `http://127.0.0.1:8000/api/chat`에서 실행하고 Adapter에 다음 값을 설정한다.

```env
CUSTOMER_AI_URL=http://127.0.0.1:8000/api/chat
```

앞의 `src/adapter.mjs` 예시는 이미 다음 형식으로 Python API를 호출하므로 요청 및 응답 구조가 같다면 추가 수정 없이 사용할 수 있다.

```json
{
  "message": "평가 질문",
  "sessionId": "aieval-Job-ID",
  "variables": {}
}
```

Python 서비스의 필드명이 다르면 Node.js Adapter의 `body`와 `payload.answer` 부분만 실제 API에 맞게 변경한다. 예를 들어 Python API가 `{"query": "..."}`를 받고 `{"result": "..."}`를 반환한다면 다음처럼 매핑한다.

```js
body: JSON.stringify({
  query: testCase.prompt,
}),
```

```js
return {
  output: payload.result,
};
```

### RAG API 매핑 예

고객 AI가 다음 형식을 사용한다고 가정한다.

```json
{
  "query": "질문",
  "filters": {
    "department": "support"
  }
}
```

응답:

```json
{
  "result": {
    "answer": "최종 답변",
    "sources": []
  }
}
```

`invoke()`의 요청과 반환 부분을 다음과 같이 바꾼다.

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

## 9. 실행 전 확인

JavaScript 문법을 확인한다.

```bash
npm run check
```

고객 AI API를 Adapter 실행 서버에서 직접 호출해 네트워크와 인증을 먼저 확인한다.

```bash
curl -X POST "https://customer-ai.internal.example.com/api/chat" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer 고객_AI_API_토큰" \
  --data '{"message":"연결 테스트입니다."}'
```

프록시나 사설 인증서를 사용하는 환경에서는 Node.js 프로세스에도 고객사의 표준 프록시 및 CA 인증서 설정을 적용한다. TLS 인증서 검증을 끄는 방식은 사용하지 않는다.

## 10. Adapter 실행

```bash
npm start
```

정상 시작 로그:

```text
AIEval Adapter가 평가 Job을 기다립니다.
```

Job이 없을 때 추가 로그 없이 대기하는 것은 정상이다. Adapter는 설정한 주기마다 평가 Backend에 Job을 요청한다.

## 11. 연결 테스트

1. Adapter 프로세스를 실행한 상태로 유지한다.
2. AIEval 대시보드의 `평가 어댑터` 화면으로 이동한다.
3. SDK Key를 발급한 Application을 선택한다.
4. 테스트 질문과 필요한 Variables를 입력한다.
5. 단건 Job을 생성한다.
6. Job 상태가 `PENDING → CLAIMED → RUNNING → COMPLETED`로 변경되는지 확인한다.
7. 완료 결과의 `output`이 고객 AI의 실제 답변인지 확인한다.

연결 테스트 체크리스트:

- Adapter에 인증 오류가 없다.
- 고객 AI에 테스트 요청이 도착한다.
- 고객 AI 응답이 비어 있지 않은 `output`으로 제출된다.
- Job이 제한 시간 내 `COMPLETED`가 된다.
- 로그와 metadata에 인증정보나 개인정보가 남지 않는다.

## 12. 운영 배포 권장사항

- Adapter를 고객 AI 서버와 별도의 프로세스 또는 컨테이너로 실행한다.
- 프로세스 종료 시 자동 재시작되도록 systemd, Kubernetes, ECS 등으로 관리한다.
- SDK Key와 고객 AI Token은 Secret으로 주입한다.
- Adapter 로그를 중앙 로그 시스템에 수집하되 민감정보는 마스킹한다.
- 한 Job의 제한 시간보다 고객 AI 클라이언트의 자체 timeout을 짧게 설정하는 것을 권장한다.
- 각 평가 Job은 `context.jobId` 기반의 독립 세션을 사용해 다른 평가 Case와 대화 상태가 섞이지 않게 한다.
- 배포 Artifact에는 `package-lock.json`을 포함하고 CI에서는 `npm ci`를 사용한다.

`.tgz` 파일이 `vendor`에 포함된 배포 환경:

```bash
npm ci
npm start
```

SDK 파일을 별도 Artifact 저장소에서 받는 환경은 `npm ci` 전에 `package-lock.json`이 참조하는 동일 경로에 동일한 `.tgz` 파일을 배치해야 한다.

## 13. 주요 오류와 해결 방법

### `Cannot find package '@aieval/sdk'`

SDK가 설치되지 않았거나 `.tgz` 경로가 잘못된 경우다.

```bash
npm install ./vendor/aieval-sdk-0.0.1.tgz
npm list @aieval/sdk
```

### `401 Unauthorized`

- `AIEVAL_SDK_KEY`에 Application ID가 아닌 `aieval_...` 형식의 Key를 넣었는지 확인한다.
- 값 앞뒤의 공백과 따옴표를 확인한다.
- Key를 발급한 Application이 활성 상태인지 AIEval 담당자에게 확인한다.

### `404 Not Found`

- `AIEVAL_BASE_URL`에 `/api/v1`이 포함되어 있는지 확인한다.
- 대시보드 URL이 아니라 Backend API URL을 사용했는지 확인한다.

### `fetch failed`, `ECONNREFUSED`, `ENOTFOUND`

- Adapter 서버에서 대상 URL의 DNS를 조회할 수 있는지 확인한다.
- 방화벽, 프록시, 포트, VPN 및 사내망 연결 상태를 확인한다.
- 고객 AI URL과 평가 Backend URL을 각각 `curl`로 점검한다.

### `AIEval protocol request failed`

평가 Backend가 SDK 요청을 거부한 경우다. 뒤에 표시되는 HTTP 상태와 메시지를 확인한다. 반복되면 발생 시간, HTTP 상태, Application ID, Job ID를 AIEval 담당자에게 전달한다. SDK Key 원문은 전달하지 않는다.

### `Adapter handler must return a non-empty output string`

`invoke()`가 반환한 `output`이 문자열이 아니거나 비어 있다. 고객 AI 응답 구조와 `payload.answer` 등의 경로를 확인한다.

### Job이 계속 `PENDING`

- Adapter 프로세스가 실행 중인지 확인한다.
- Job을 생성한 Application과 SDK Key가 연결된 Application이 같은지 확인한다.
- Adapter 로그의 인증 또는 네트워크 오류를 확인한다.

### Job이 `FAILED`

- 고객 AI가 제한 시간 안에 응답했는지 확인한다.
- 고객 AI의 HTTP 상태와 Adapter 오류 로그를 확인한다.
- 응답의 최종 답변이 비어 있지 않은 문자열인지 확인한다.

## 14. AIEval 담당자에게 전달할 장애 정보

문제 문의 시 다음 정보를 함께 전달하면 확인이 빠르다.

```text
- SDK 버전: @aieval/sdk 0.0.1
- 발생 일시 및 시간대:
- 실행 환경: Node.js 버전 / OS 또는 컨테이너:
- Application ID:
- Job ID:
- HTTP 상태 코드:
- 오류 메시지:
- 재현 절차:
- 최근 설정 또는 배포 변경사항:
```

SDK Key, 고객 AI Token, 개인정보 및 고객 AI의 민감한 응답 원문은 전달하지 않는다.
