# Python 고객사를 위한 AIEval Adapter Sidecar 설치 가이드

## 1. 목적과 권장 구조

현재 `aieval-sdk-0.0.1.tgz`는 Node.js용 SDK다. Python 서비스에 `pip install`하는 패키지가 아니므로, Node.js Adapter를 별도 프로세스 또는 컨테이너로 실행하고 Python AI의 내부 HTTP API를 호출한다.

```text
외부 AIEval Backend
        ↑↓ HTTPS (outbound)
┌──────── 고객사 실행 환경 ────────┐
│  Node.js AIEval Adapter          │
│           ↑↓ 내부 HTTP           │
│  Python AI Service               │
└──────────────────────────────────┘
```

이 문서에서 Sidecar는 Python AI와 함께 배포되지만 실행 프로세스는 분리된 Node.js Adapter를 의미한다.

- Kubernetes: 동일 Pod 안의 두 Container로 실행
- Docker Compose: 동일 Compose Network의 두 Service로 실행
- VM 또는 개발 PC: 서로 다른 두 로컬 Process로 실행

Python AI 서비스는 AIEval Backend에 직접 연결하지 않는다. Adapter가 AIEval Job을 polling하고, 질문을 Python API 형식으로 바꿔 호출한 뒤 답변을 제출한다.

## 2. 준비물

AIEval 담당자로부터 다음 값을 전달받는다.

| 항목 | 예시 | 설명 |
|---|---|---|
| SDK 파일 | `aieval-sdk-0.0.1.tgz` | Node.js Adapter SDK |
| SHA-256 | 담당자가 전달한 해시 | 파일 무결성 확인 |
| Backend URL | `https://aieval.example.com/api/v1` | `/api/v1` 포함 |
| SDK Key | `aieval_...` | Adapter 인증정보 |
| Application ID | UUID | 대시보드와 평가 실행에서 사용 |

로컬 설치에 필요한 도구:

- Node.js 20 이상
- npm 9 이상 권장
- Python 3.11 이상 권장
- 고객 환경에 맞는 Python 웹 프레임워크
- 컨테이너 배포 시 Docker 또는 Kubernetes

버전을 확인한다.

```bash
node --version
npm --version
python3 --version
```

SDK Key와 Application ID는 다르다. Adapter의 `AIEVAL_SDK_KEY`에는 반드시 `aieval_...` 형식의 값을 사용한다.

## 3. SDK 무결성 확인

SDK 파일이 있는 디렉터리에서 실행한다.

macOS:

```bash
shasum -a 256 aieval-sdk-0.0.1.tgz
```

Linux:

```bash
sha256sum aieval-sdk-0.0.1.tgz
```

결과가 AIEval 담당자가 제공한 SHA-256 값과 일치해야 한다. 일치하지 않으면 설치하지 않는다.

패키지 내부 파일도 확인할 수 있다.

```bash
tar -tzf aieval-sdk-0.0.1.tgz
```

정상 패키지에는 `package/package.json`과 `package/dist/` 아래의 JavaScript 및 TypeScript 선언 파일이 들어 있다.

## 4. 예제 디렉터리 만들기

기존 Python 프로젝트 아래에 다음 구조로 추가하는 것을 권장한다.

```text
customer-python-ai/
├── app/
│   └── main.py
├── requirements.txt
├── Dockerfile
├── evaluation-adapter/
│   ├── src/
│   │   └── adapter.mjs
│   ├── vendor/
│   │   └── aieval-sdk-0.0.1.tgz
│   ├── .env
│   ├── .env.example
│   ├── .gitignore
│   ├── package.json
│   ├── package-lock.json
│   └── Dockerfile
├── compose.yaml
└── kubernetes/
    └── deployment.yaml
```

Adapter 디렉터리를 생성하고 SDK 파일을 복사한다.

```bash
cd /path/to/customer-python-ai
mkdir -p evaluation-adapter/src evaluation-adapter/vendor
cp /path/to/aieval-sdk-0.0.1.tgz \
  evaluation-adapter/vendor/aieval-sdk-0.0.1.tgz
cd evaluation-adapter
```

## 5. Node.js Adapter 설치

### 5.1 `package.json` 생성

`evaluation-adapter/package.json`:

```json
{
  "name": "customer-python-ai-evaluation-adapter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --env-file=.env src/adapter.mjs",
    "start:container": "node src/adapter.mjs",
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

### 5.2 `.tgz` 설치

`evaluation-adapter` 디렉터리에서 실행한다.

```bash
npm install
```

또는 패키지 경로를 직접 지정할 수 있다.

```bash
npm install ./vendor/aieval-sdk-0.0.1.tgz
```

설치를 확인한다.

```bash
npm list @aieval/sdk
```

정상 출력 예:

```text
customer-python-ai-evaluation-adapter@0.1.0
└── @aieval/sdk@0.0.1
```

생성된 `package-lock.json`은 저장소에 커밋한다. `.tgz` 원본을 Git에 포함할지는 고객사의 바이너리 보관 정책을 따른다. 포함하지 않는 경우 빌드 전에 사내 Artifact 저장소에서 동일한 파일을 `vendor` 경로에 배치해야 한다.

### 5.3 `.gitignore`

`evaluation-adapter/.gitignore`:

```gitignore
node_modules/
.env
*.log
```

## 6. Python AI 내부 API 준비

Adapter가 호출할 Python API가 이미 있다면 이 단계의 예제 대신 기존 API를 사용한다. 외부 공개 주소가 아닌 Adapter에서 접근 가능한 내부 주소면 충분하다.

FastAPI 예제의 `requirements.txt`:

```text
fastapi
uvicorn[standard]
```

설치:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

`app/main.py`:

```python
import os
import secrets
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI()
internal_api_token = os.environ.get(
    "INTERNAL_API_TOKEN",
    "local-development-token",
)


class ChatRequest(BaseModel):
    message: str
    sessionId: str
    variables: dict[str, Any] = Field(default_factory=dict)


class ChatResponse(BaseModel):
    answer: str
    model: str
    traceId: str | None = None


async def run_customer_ai(
    prompt: str,
    session_id: str,
    variables: dict[str, Any],
) -> str:
    # 고객사의 실제 Agent/RAG 실행 코드로 교체한다.
    return f"테스트 응답: {prompt}"


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    x_internal_token: str | None = Header(default=None),
) -> ChatResponse:
    if (
        x_internal_token is None
        or not secrets.compare_digest(x_internal_token, internal_api_token)
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")

    answer = await run_customer_ai(
        prompt=request.message,
        session_id=request.sessionId,
        variables=request.variables,
    )

    return ChatResponse(
        answer=answer,
        model="customer-python-agent-v1",
        traceId=request.sessionId,
    )
```

위 예제의 `run_customer_ai()`는 고객사의 실제 AI 실행 함수로 구현해야 한다. 이미 Python AI API가 있다면 요청 필드와 응답 필드만 확인한다.

개발 환경에서 실행한다.

```bash
INTERNAL_API_TOKEN=local-development-token \
  uvicorn app.main:app --host 127.0.0.1 --port 8000
```

직접 호출해 확인한다.

```bash
curl -X POST http://127.0.0.1:8000/api/chat \
  -H 'Content-Type: application/json' \
  -H 'X-Internal-Token: local-development-token' \
  --data '{
    "message": "환불 기간을 알려주세요.",
    "sessionId": "manual-test",
    "variables": {}
  }'
```

정상 응답 예:

```json
{
  "answer": "상품 수령 후 7일 이내에 환불할 수 있습니다.",
  "model": "customer-python-agent-v1",
  "traceId": "manual-test"
}
```

## 7. Adapter 환경변수 설정

`evaluation-adapter/.env.example`:

```env
# AIEval Backend
AIEVAL_BASE_URL=https://aieval.example.com/api/v1
AIEVAL_SDK_KEY=aieval_replace_me
AIEVAL_POLL_INTERVAL_MS=1000

# Python AI
CUSTOMER_AI_URL=http://127.0.0.1:8000/api/chat
CUSTOMER_AI_TOKEN=replace_me
```

개발용 `.env`를 만든다.

```bash
cp .env.example .env
```

`evaluation-adapter/.env`:

```env
AIEVAL_BASE_URL=https://aieval.example.com/api/v1
AIEVAL_SDK_KEY=aieval_발급받은_SDK_Key
AIEVAL_POLL_INTERVAL_MS=1000

CUSTOMER_AI_URL=http://127.0.0.1:8000/api/chat
CUSTOMER_AI_TOKEN=local-development-token
```

`.env`는 Git에 커밋하지 않는다. 운영에서는 Kubernetes Secret, AWS Secrets Manager, Vault 등 고객사의 Secret 관리 체계를 사용한다.

## 8. Adapter 코드 작성

`evaluation-adapter/src/adapter.mjs`:

```js
import { createEvaluationAdapter } from '@aieval/sdk';

const requiredEnvironmentVariables = [
  'AIEVAL_BASE_URL',
  'AIEVAL_SDK_KEY',
  'CUSTOMER_AI_URL',
  'CUSTOMER_AI_TOKEN',
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
        'X-Internal-Token': process.env.CUSTOMER_AI_TOKEN,
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
        `Python AI 호출 실패: HTTP ${response.status} ${responseBody}`,
      );
    }

    const payload = await response.json();

    if (
      typeof payload.answer !== 'string' ||
      payload.answer.trim().length === 0
    ) {
      throw new Error(
        'Python AI 응답에 비어 있지 않은 answer가 필요합니다.',
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

고객 Python API의 형식이 예제와 다르면 다음 세 곳만 실제 사양에 맞게 변경한다.

1. `headers`: Python 내부 API 인증 방식
2. `body`: Python API 요청 구조
3. `output: payload.answer`: 응답에서 최종 답변을 꺼내는 경로

SDK가 담당하는 Job polling, claim, lease, timeout, 완료 및 실패 제출 로직은 수정하지 않는다.

## 9. 로컬에서 두 프로세스 실행

첫 번째 터미널에서 Python AI를 실행한다.

```bash
cd /path/to/customer-python-ai
source .venv/bin/activate
INTERNAL_API_TOKEN=local-development-token \
  uvicorn app.main:app --host 127.0.0.1 --port 8000
```

두 번째 터미널에서 Adapter를 실행한다.

```bash
cd /path/to/customer-python-ai/evaluation-adapter
npm run check
npm start
```

정상 로그:

```text
AIEval Adapter가 평가 Job을 기다립니다.
```

로컬 프로세스는 같은 호스트의 네트워크를 사용하므로 `CUSTOMER_AI_URL=http://127.0.0.1:8000/api/chat`을 사용할 수 있다.

## 10. Docker Compose로 구성

Docker Compose의 각 Service는 별도 Container이므로 Adapter에서 `127.0.0.1`을 사용하면 Python Container에 연결되지 않는다. Compose Service 이름을 DNS 주소로 사용한다.

### 10.1 Python Dockerfile

프로젝트 루트의 `Dockerfile`:

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### 10.2 Adapter Dockerfile

`evaluation-adapter/Dockerfile`:

```dockerfile
FROM node:20-bookworm-slim

WORKDIR /adapter

COPY package.json package-lock.json ./
COPY vendor ./vendor

RUN npm ci --omit=dev

COPY src ./src

USER node

CMD ["npm", "run", "start:container"]
```

`npm ci` 전에 `vendor/aieval-sdk-0.0.1.tgz`가 반드시 Build Context에 있어야 한다.

### 10.3 `compose.yaml`

프로젝트 루트의 `compose.yaml`:

```yaml
services:
  python-ai:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      INTERNAL_API_TOKEN: ${CUSTOMER_AI_TOKEN}
    expose:
      - "8000"
    healthcheck:
      test:
        [
          "CMD",
          "python",
          "-c",
          "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')",
        ]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 10s
    restart: unless-stopped

  aieval-adapter:
    build:
      context: ./evaluation-adapter
      dockerfile: Dockerfile
    environment:
      AIEVAL_BASE_URL: ${AIEVAL_BASE_URL}
      AIEVAL_SDK_KEY: ${AIEVAL_SDK_KEY}
      AIEVAL_POLL_INTERVAL_MS: "1000"
      CUSTOMER_AI_URL: http://python-ai:8000/api/chat
      CUSTOMER_AI_TOKEN: ${CUSTOMER_AI_TOKEN}
    depends_on:
      python-ai:
        condition: service_healthy
    restart: unless-stopped
```

Compose에 전달할 프로젝트 루트 `.env`:

```env
AIEVAL_BASE_URL=https://aieval.example.com/api/v1
AIEVAL_SDK_KEY=aieval_발급받은_SDK_Key
CUSTOMER_AI_TOKEN=내부_API_토큰
```

이 `.env`도 Git에 커밋하지 않는다.

빌드하고 실행한다.

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f aieval-adapter
```

종료:

```bash
docker compose down
```

Compose 구성에서 Python API는 host port로 공개하지 않고 `expose`만 사용한다. Adapter는 `http://python-ai:8000`으로 내부 접근한다.

## 11. Kubernetes 동일 Pod Sidecar 구성

Kubernetes에서는 Python Container와 Adapter Container를 동일 Pod에 둔다. 동일 Pod의 Container는 네트워크 namespace를 공유하므로 Adapter가 Python API를 `127.0.0.1`로 호출할 수 있다.

### 11.1 Container Image 준비

앞의 두 Dockerfile을 사용해 고객사 Registry에 Image를 준비한다.

```text
registry.example.com/customer/python-ai:1.0.0
registry.example.com/customer/aieval-adapter:0.1.0
```

운영 배포에서는 `latest` 대신 변경 불가능한 버전 태그 또는 image digest를 사용한다.

### 11.2 Secret 준비

다음 이름과 Key를 가진 Secret을 고객사의 Secret 배포 절차로 미리 생성한다.

```text
Secret 이름: customer-ai-evaluation-secrets

Key:
- aieval-sdk-key
- customer-ai-token
```

Secret 원문을 Kubernetes YAML, Git 저장소 또는 배포 로그에 넣지 않는다.

### 11.3 Deployment

`kubernetes/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: customer-python-ai
spec:
  replicas: 1
  selector:
    matchLabels:
      app: customer-python-ai
  template:
    metadata:
      labels:
        app: customer-python-ai
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: python-ai
          image: registry.example.com/customer/python-ai:1.0.0
          ports:
            - name: http
              containerPort: 8000
          env:
            - name: INTERNAL_API_TOKEN
              valueFrom:
                secretKeyRef:
                  name: customer-ai-evaluation-secrets
                  key: customer-ai-token
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 1Gi

        - name: aieval-adapter
          image: registry.example.com/customer/aieval-adapter:0.1.0
          env:
            - name: AIEVAL_BASE_URL
              value: https://aieval.example.com/api/v1
            - name: AIEVAL_POLL_INTERVAL_MS
              value: "1000"
            - name: AIEVAL_SDK_KEY
              valueFrom:
                secretKeyRef:
                  name: customer-ai-evaluation-secrets
                  key: aieval-sdk-key
            - name: CUSTOMER_AI_URL
              value: http://127.0.0.1:8000/api/chat
            - name: CUSTOMER_AI_TOKEN
              valueFrom:
                secretKeyRef:
                  name: customer-ai-evaluation-secrets
                  key: customer-ai-token
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
```

적용하고 상태를 확인한다.

```bash
kubectl apply -f kubernetes/deployment.yaml
kubectl rollout status deployment/customer-python-ai
kubectl get pods -l app=customer-python-ai
```

Container별 로그를 확인한다.

```bash
kubectl logs deployment/customer-python-ai \
  -c python-ai
```

```bash
kubectl logs deployment/customer-python-ai \
  -c aieval-adapter
```

Adapter SDK는 현재 별도의 HTTP health endpoint를 제공하지 않는다. 따라서 Adapter Container에는 부정확한 HTTP probe를 임의로 추가하지 않고, 프로세스 종료 시 Kubernetes가 Container를 재시작하도록 둔다. 운영 모니터링은 Container restart 횟수, 오류 로그, Job 처리 지연을 기준으로 구성한다.

### 11.4 Kubernetes에서 주의할 점

- 동일 Pod이므로 Python API 주소는 `http://127.0.0.1:8000`이다.
- Python 서버는 동일 Pod 접근을 위해 `0.0.0.0:8000`에서 listen해야 한다.
- Python Container가 준비되기 전에 Adapter가 시작될 수 있지만, SDK polling은 계속 실행되고 이후 Job에서 다시 호출할 수 있다.
- Python AI와 Adapter는 동일 Pod 단위로 함께 확장된다.
- 여러 Replica가 같은 SDK Key로 polling하면 각 Adapter가 서로 다른 Job을 claim할 수 있다. Python AI가 동시 요청을 처리할 수 있는지 먼저 확인한다.
- Adapter에서 AIEval Backend로 나가는 HTTPS egress를 NetworkPolicy와 방화벽에서 허용한다.
- 사내 Proxy가 필요하다면 고객 표준에 따라 `HTTPS_PROXY`, `NO_PROXY`와 CA 인증서를 Container에 설정한다.
- TLS 인증서 검증을 비활성화하지 않는다.

## 12. AIEval 연결 테스트

배포 후 다음 순서로 확인한다.

1. Python `/health`가 정상인지 확인한다.
2. Adapter 로그에 환경변수 또는 네트워크 오류가 없는지 확인한다.
3. AIEval 대시보드의 `평가 어댑터` 화면에서 SDK Key를 발급한 Application을 선택한다.
4. 단건 테스트 질문을 등록한다.
5. Job 상태 변화를 확인한다.

정상 상태 변화:

```text
PENDING → CLAIMED → RUNNING → COMPLETED
```

결과의 `output`이 Python AI가 생성한 실제 답변인지 확인한다.

테스트 체크리스트:

- Adapter에서 AIEval Backend로 HTTPS 연결이 된다.
- SDK 인증 오류가 없다.
- Adapter에서 Python API를 호출할 수 있다.
- Python API가 제한 시간 내 응답한다.
- 반환된 `output`은 공백이 아닌 문자열이다.
- 평가 Case마다 `context.jobId` 기반의 독립 세션을 사용한다.
- 로그와 metadata에 SDK Key, 내부 Token 또는 개인정보가 없다.

## 13. 운영 보안 및 안정성

### Secret

- `AIEVAL_SDK_KEY`와 `CUSTOMER_AI_TOKEN`을 Image에 포함하지 않는다.
- 환경별로 별도 SDK Key를 사용한다.
- 로그에 요청 Header 또는 전체 환경변수를 출력하지 않는다.
- Key 유출이 의심되면 AIEval 담당자에게 폐기 및 재발급을 요청한다.

### 네트워크

- Adapter에서 AIEval Backend 방향의 HTTPS outbound만 허용한다.
- Python API는 내부 네트워크 또는 동일 Pod에서만 접근하게 한다.
- Kubernetes 동일 Pod에서는 외부 노출용 Service가 없어도 Adapter가 Python API를 호출할 수 있다.

### Timeout

SDK는 Job의 `timeoutMs`에 맞춰 `context.signal`을 중단한다. `fetch()`에 반드시 `signal: context.signal`을 전달해야 한다. 고객 AI 내부의 모델, DB, 검색 시스템에도 이보다 짧은 자체 timeout을 두는 것을 권장한다.

### 종료

Adapter는 `SIGTERM`과 `SIGINT`를 받으면 추가 Job polling을 중단한다. 실행 중인 Pod를 종료할 때는 `terminationGracePeriodSeconds`를 Job timeout보다 충분히 길게 설정하는 방안을 검토한다.

### 확장

동일 SDK Key를 사용하는 Adapter Replica가 여러 개여도 Backend의 claim 처리로 하나의 Job은 한 Worker에만 배정된다. 다만 Replica 수를 늘리기 전에 다음을 확인한다.

- Python AI의 동시 처리 용량
- LLM Provider rate limit
- DB와 Vector DB connection pool
- 고객 API의 session 격리
- 평가 Backend가 허용하는 polling 부하

## 14. SDK 버전 업그레이드

새 `.tgz` 파일과 SHA-256을 전달받는다.

1. 체크섬을 검증한다.
2. `evaluation-adapter/vendor`에 새 파일을 넣는다.
3. 새 파일을 설치한다.
4. `package.json`과 `package-lock.json` 변경을 확인한다.
5. Adapter Image를 새 태그로 빌드한다.
6. 개발 환경에서 단건 Job을 실행한다.
7. 운영에 순차 배포한다.

```bash
cd evaluation-adapter
npm install ./vendor/aieval-sdk-새버전.tgz
npm list @aieval/sdk
npm run check
```

이전 `.tgz`, 이전 Image 태그와 이전 배포 Manifest를 보존하면 문제가 발생했을 때 이전 버전으로 되돌릴 수 있다.

## 15. 문제 해결

### `.tgz`를 `pip install`할 수 없음

정상이다. 이 파일은 Node.js npm 패키지다. `evaluation-adapter`에 npm으로 설치하고 Python 서비스는 내부 HTTP API로 연결한다.

### `Cannot find package '@aieval/sdk'`

```bash
cd evaluation-adapter
npm install
npm list @aieval/sdk
```

`vendor/aieval-sdk-0.0.1.tgz`가 실제로 존재하는지도 확인한다.

### AIEval 요청이 `401 Unauthorized`

- `AIEVAL_SDK_KEY`가 `aieval_...` 형식인지 확인한다.
- Application ID를 SDK Key 자리에 넣지 않았는지 확인한다.
- Key 값에 불필요한 공백이나 줄바꿈이 없는지 확인한다.

### AIEval 요청이 `404 Not Found`

- `AIEVAL_BASE_URL`에 `/api/v1`이 포함되었는지 확인한다.
- 대시보드 주소가 아닌 Backend API 주소인지 확인한다.

### Python API 연결이 `ECONNREFUSED`

환경에 따라 URL을 확인한다.

| 환경 | Python API 주소 |
|---|---|
| 같은 VM의 로컬 Process | `http://127.0.0.1:8000` |
| Docker Compose | `http://python-ai:8000` |
| Kubernetes 동일 Pod | `http://127.0.0.1:8000` |
| Kubernetes 다른 Pod | 해당 Kubernetes Service DNS |

Python 서버가 올바른 주소에서 listen 중인지도 확인한다. Container에서는 일반적으로 `--host 0.0.0.0`이 필요하다.

### `Adapter handler must return a non-empty output string`

Python 응답의 `answer`가 비어 있거나 Adapter의 응답 경로가 잘못되었다. 실제 Python JSON 응답과 `payload.answer`를 비교한다.

### Job이 계속 `PENDING`

- Adapter Container 또는 Process가 실행 중인지 확인한다.
- Adapter 로그에서 인증 및 네트워크 오류를 확인한다.
- Job을 만든 Application과 SDK Key가 연결된 Application이 같은지 확인한다.

### Job이 `FAILED`

- Python API 오류 로그를 확인한다.
- Job timeout 내에 답변을 반환했는지 확인한다.
- Python 응답이 유효한 JSON인지 확인한다.
- `answer`가 공백이 아닌 문자열인지 확인한다.

## 16. 장애 문의 시 준비할 정보

```text
- SDK 버전:
- 발생 일시 및 시간대:
- 배포 방식: 로컬 / Docker Compose / Kubernetes
- Node.js 및 Python 버전:
- Application ID:
- Job ID:
- Adapter 오류 메시지:
- Python API HTTP 상태:
- 재현 절차:
- 최근 설정 또는 배포 변경사항:
```

SDK Key, 고객 AI Token, 개인정보 및 민감한 고객 응답 원문은 전달하지 않는다.
