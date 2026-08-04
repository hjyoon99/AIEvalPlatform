# 자동 평가 사용 방법

> 문서 상태: SDK v1 로컬 실행 기준
> 관련 문서: [평가 실행 자동화 설계](./Evaluation-Run-Automation-Design.md), [SDK 실행 프로토콜](./SDK-Execution-Protocol.md)

## Docker Compose 빠른 Mock 테스트

PostgreSQL, Mock Judge, Backend, Dashboard를 한 번에 실행한다.

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
```

모든 서비스가 `healthy`이면 다음 주소를 사용할 수 있다.

```text
Dashboard:  http://localhost:5173
Backend:    http://localhost:3000/api/v1
Mock Judge: http://localhost:18000/health
PostgreSQL: localhost:5433
```

Backend 컨테이너가 시작될 때 Prisma migration과 Judge Worker가 자동 실행된다. `PROVIDED_OUTPUT` 평가는 이 상태에서 바로 실행할 수 있다.

ADAPTER 전체 흐름에서는 먼저 애플리케이션을 등록하여 SDK Key를 발급하고 `.env`에 입력한다.

```env
AIEVAL_SDK_KEY=aieval_발급받은_키
```

그다음 Mock Adapter를 추가 실행한다.

```bash
docker compose --profile adapter up -d --build mock-adapter
docker compose logs -f mock-adapter
```

종료:

```bash
docker compose down
```

아래 개별 실행 절차는 각 프로세스를 직접 디버깅하거나 실제 Ollama와 Python Agent Engine을 사용할 때 이용한다.

## 1. 지원하는 평가 방식

자동 평가는 두 가지 실행 방식을 지원한다.

| 실행 방식 | 사용 상황 | 답변 생성 |
| --- | --- | --- |
| `ADAPTER` | 고객 AI를 실제 호출해 새 답변을 평가 | 별도 평가 어댑터가 고객 AI 호출 |
| `PROVIDED_OUTPUT` | JSON 로그나 CSV에 이미 존재하는 답변을 평가 | 입력 데이터의 `output` 사용 |

두 방식 모두 답변이 준비된 후에는 같은 흐름을 사용한다.

```text
EvalRunCase
→ JudgeJob
→ Judge Worker
→ Agent Engine / Ollama
→ EvalResult
→ EvalRun 상태 집계
```

현재 대시보드는 자동 Run의 진행률과 결과를 표시하지만 `ADAPTER` 또는 `PROVIDED_OUTPUT` Run을 만드는 입력 화면은 아직 연결되지 않았다. 자동 Run 생성은 우선 Backend API를 사용한다.

## 2. 사전 준비

필요한 구성:

- Docker와 Docker Compose
- Node.js와 프로젝트 의존성
- Python 3
- Ollama 및 Judge 모델

프로젝트 의존성이 아직 설치되지 않았다면 저장소 루트에서 설치한다.

```bash
pnpm install
```

Backend의 `DATABASE_URL`은 기본 로컬 PostgreSQL을 가리키도록 설정한다.

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/eval_platform
```

## 3. 공통 서비스 실행

서비스는 서로 다른 터미널에서 실행한다.

### 3.0 Docker Compose로 Mock 환경 한 번에 실행

실제 Ollama 대신 Mock Judge를 사용할 경우 저장소 루트에서 다음 명령으로 PostgreSQL, Backend, Dashboard, Mock Agent Engine을 한 번에 실행할 수 있다.

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
```

모든 서비스가 `healthy`가 되면 Dashboard에 접속한다.

```text
http://localhost:5173
```

로그 확인:

```bash
docker compose logs -f
```

이 방식을 사용하면 3.1~3.6의 개별 실행은 필요하지 않다. 단, ADAPTER 평가의 Mock Adapter는 Application 등록과 SDK 키 발급 후 별도로 프로필을 활성화한다.

```bash
docker compose --profile adapter up -d --build mock-adapter
```

### 3.1 PostgreSQL

저장소 루트에서:

```bash
docker compose up -d postgres
docker compose ps
```

`eval_platform_db`가 `healthy`인지 확인한다.

### 3.2 Prisma 마이그레이션

```bash
cd apps/backend
./node_modules/.bin/prisma migrate deploy
./node_modules/.bin/prisma generate
```

상태 확인:

```bash
./node_modules/.bin/prisma migrate status
```

정상 상태:

```text
Database schema is up to date!
```

### 3.3 Ollama

모델 설치:

```bash
ollama pull qwen3.5:4b
```

서버 실행:

```bash
ollama serve
```

이미 Ollama가 실행 중이면 서버를 중복 실행하지 않아도 된다.

### 3.4 Agent Engine

```bash
cd apps/agent-engine
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

상태 확인:

```bash
curl http://localhost:8000/health
```

### 3.5 Backend와 Judge Worker

```bash
cd apps/backend
./node_modules/.bin/nest start --watch
```

Backend가 시작되면 같은 프로세스에서 Judge Worker도 자동으로 시작한다.

```text
Judge worker started.
```

기본 주소:

```text
http://localhost:3000/api/v1
```

### 3.6 Dashboard

```bash
cd apps/dashboard
./node_modules/.bin/vite
```

브라우저에서 다음 주소로 접속한다.

```text
http://localhost:5173
```

## 4. Ollama 없이 Mock Judge로 테스트

자동 실행 구조만 빠르게 확인할 때 사용한다.

저장소 루트에서 Mock Agent Engine을 실행한다.

```bash
node examples/mock-agent-engine.mjs
```

Backend를 Mock 주소에 연결한다.

```bash
cd apps/backend

AGENT_ENGINE_URL='http://127.0.0.1:18000' \
JUDGE_WORKER_POLL_INTERVAL_MS='500' \
./node_modules/.bin/nest start
```

Mock 판정 규칙:

| Prompt 내용 | 결과 |
| --- | --- |
| 일반 문자열 | `PASS`, 0.92 |
| `검토` 포함 | `RETRY`, `REVIEW_REQUIRED` |
| `실패` 포함 | 품질 `FAIL`, 0.2 |
| `시스템 오류` 포함 | HTTP 503, `JUDGE_FAILED` |

Mock은 개발 검증 전용이며 실제 답변 품질을 판정하지 않는다.

## 5. PROVIDED_OUTPUT 평가

이미 수집된 질문과 답변을 바로 평가한다. `SdkJob`과 평가 어댑터는 생성하지 않는다.

```bash
curl -X POST http://localhost:3000/api/v1/eval-runs \
  -H 'Content-Type: application/json' \
  --data '{
    "name": "기존 답변 품질 평가",
    "executionMode": "PROVIDED_OUTPUT",
    "judgeModel": "qwen3.5:4b",
    "dataset": [
      {
        "id": "case-001",
        "prompt": "환불 기간은 며칠인가요?",
        "output": "상품 수령 후 7일 이내에 환불할 수 있습니다.",
        "expectedOutput": "상품 수령 후 7일 이내에 환불할 수 있습니다."
      },
      {
        "id": "case-002",
        "prompt": "주문 취소를 도와주세요.",
        "output": "주문번호와 현재 주문 상태를 확인하겠습니다.",
        "expectedBehavior": [
          "주문 정보를 요청한다",
          "주문 상태를 확인한다"
        ],
        "failConditions": [
          "확인 없이 취소 완료를 알린다"
        ]
      }
    ]
  }'
```

자동 생성:

```text
EvalRun 1개
EvalRunCase 2개
JudgeJob 2개
SdkJob 0개
```

`expectedOutput`이 있는 첫 번째 Case는 `REFERENCE_BASED`, 기준 답변이 없는 두 번째 Case는 `RUBRIC_ONLY`로 평가한다.

응답의 `id`가 Run ID다.

```json
{
  "id": "RUN_ID",
  "status": "QUEUED",
  "totalCases": 2
}
```

## 6. ADAPTER 평가

고객 AI 또는 Mock Adapter가 질문별 답변을 생성한 후 Judge가 평가한다.

```text
EvalRun 생성
→ Case별 SdkJob 생성
→ Adapter가 고객 AI 호출
→ 답변 제출
→ JudgeJob 생성
→ EvalResult
```

### 6.1 프로젝트 생성

대시보드에서 프로젝트를 만들거나 API를 호출한다.

```bash
curl -X POST http://localhost:3000/api/v1/projects \
  -H 'Content-Type: application/json' \
  --data '{
    "name": "고객지원 AI 평가",
    "domain": "customer-support",
    "description": "환불과 주문 취소 상담 AI"
  }'
```

응답의 프로젝트 `id`를 기록한다.

### 6.2 어댑터 등록

대시보드 왼쪽 `⇄` 메뉴에서 다음 값을 입력한다.

```text
이름: customer-support-adapter
환경: development
```

등록 결과에는 두 종류의 값이 있다.

```text
Application ID
→ EvalRun의 applicationId에 사용

aieval_... 형식 SDK Key
→ Adapter의 AIEVAL_SDK_KEY에 사용
```

SDK Key 원문은 발급 시 한 번만 표시된다. UUID 형식의 Application ID를 SDK Key로 사용하면 안 된다.

API로 등록할 수도 있다.

```bash
curl -X POST \
  http://localhost:3000/api/v1/projects/PROJECT_ID/applications \
  -H 'Content-Type: application/json' \
  --data '{
    "name": "customer-support-adapter",
    "environment": "development"
  }'
```

`PROJECT_ID`는 실제 프로젝트 ID로 교체한다.

### 6.3 자동 EvalRun 생성

다음 명령의 `PROJECT_ID`와 `APPLICATION_ID`를 실제 값으로 교체한다.

```bash
curl -X POST http://localhost:3000/api/v1/eval-runs \
  -H 'Content-Type: application/json' \
  --data '{
    "name": "고객지원 AI 회귀 평가",
    "projectId": "PROJECT_ID",
    "applicationId": "APPLICATION_ID",
    "executionMode": "ADAPTER",
    "judgeModel": "qwen3.5:4b",
    "timeoutMs": 30000,
    "maxAttempts": 3,
    "dataset": [
      {
        "id": "case-001",
        "prompt": "상품을 받은 지 5일 됐는데 환불할 수 있나요?",
        "expectedOutput": "정책 조건을 충족하면 수령 후 7일 이내에 환불할 수 있습니다."
      },
      {
        "id": "case-002",
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

자동 생성:

```text
EvalRun 1개
EvalRunCase 2개
SdkJob 2개
```

### 6.4 Mock Adapter 실행

SDK 빌드:

```bash
cd packages/sdk
./node_modules/.bin/tsc -p tsconfig.json
cd ../..
```

발급받은 실제 SDK Key를 사용한다.

```bash
AIEVAL_BASE_URL='http://localhost:3000/api/v1' \
AIEVAL_SDK_KEY='aieval_실제_SDK_Key' \
node examples/sdk-test-worker.mjs
```

예제 Adapter는 고객 AI를 호출하지 않고 고정된 Mock 답변을 반환한다.

### 6.5 실제 고객 AI 연결

별도 Adapter의 `invoke()`만 고객 API에 맞게 변경한다.

```js
import { createEvaluationAdapter } from '@aieval/sdk';

const adapter = createEvaluationAdapter({
  baseUrl: process.env.AIEVAL_BASE_URL,
  sdkKey: process.env.AIEVAL_SDK_KEY,

  async invoke(testCase, context) {
    const response = await fetch(process.env.CUSTOMER_AI_URL, {
      method: 'POST',
      signal: context.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CUSTOMER_AI_TOKEN}`,
      },
      body: JSON.stringify({
        message: testCase.prompt,
        variables: testCase.variables,
      }),
    });

    if (!response.ok) {
      throw {
        code: response.status >= 500
          ? 'TARGET_UNAVAILABLE'
          : 'EXECUTION_ERROR',
        message: `Customer AI returned HTTP ${response.status}`,
        retryable: response.status >= 500,
      };
    }

    const data = await response.json();

    return {
      output: data.answer,
      metadata: {
        model: data.model,
        traceId: data.traceId,
      },
    };
  },
});

await adapter.start();
```

고객 API의 주소, 인증, 요청 body와 응답의 답변 경로가 고객별 수정 지점이다.

## 7. 진행률과 결과 조회

Run 생성 응답의 ID를 사용한다.

```bash
curl http://localhost:3000/api/v1/eval-runs/RUN_ID
```

`RUN_ID`를 실제 값으로 교체한다.

```json
{
  "status": "RUNNING",
  "progress": {
    "total": 100,
    "waitingForExecution": 20,
    "executing": 5,
    "waitingForJudge": 15,
    "judging": 3,
    "completed": 50,
    "reviewRequired": 5,
    "failed": 2,
    "cancelled": 0
  }
}
```

대시보드의 최근 실행에서 Run을 선택하면 같은 진행률을 확인할 수 있다. 활성 자동 Run은 2초마다 갱신된다.

## 8. 상태 해석

### Case 상태

| 상태 | 의미 |
| --- | --- |
| `WAITING_FOR_EXECUTION` | Adapter 실행 대기 |
| `EXECUTING` | 고객 AI 답변 생성 중 |
| `WAITING_FOR_JUDGE` | 답변 수집 완료, Judge 대기 |
| `JUDGING` | LLM Judge 평가 중 |
| `COMPLETED` | 품질 평가 완료 |
| `REVIEW_REQUIRED` | 사람 검토 필요 |
| `EXECUTION_FAILED` | 고객 AI 실행 기술 실패 |
| `JUDGE_FAILED` | Judge 실행 기술 실패 |

### Run 상태

| 상태 | 의미 |
| --- | --- |
| `QUEUED` | 실행 대기 |
| `RUNNING` | 하나 이상의 Case 처리 중 |
| `COMPLETED` | 모든 Case가 평가 또는 검토 대기로 정상 종결 |
| `COMPLETED_WITH_ERRORS` | 일부 Case에서 실행 또는 Judge 기술 실패 |
| `FAILED` | 모든 Case에서 평가 가능한 결과 생성 실패 |

품질 판정 `FAIL`과 시스템 상태 `FAILED`는 다르다.

```text
EvalResult FAIL
→ 답변은 정상 수집했지만 품질 기준 미달

EvalRun FAILED
→ 답변 수집 또는 Judge 실행 자체가 모두 실패
```

## 9. Judge Worker 설정

| 환경변수 | 기본값 | 의미 |
| --- | --- | --- |
| `AGENT_ENGINE_URL` | `http://127.0.0.1:8000` | Agent Engine 주소 |
| `JUDGE_WORKER_ENABLED` | `true` | `false`이면 자동 Judge 중지 |
| `JUDGE_WORKER_POLL_INTERVAL_MS` | `1000` | JudgeJob 조회 간격 |
| `JUDGE_JOB_LEASE_MS` | `300000` | JudgeJob 실행 권한 유지 시간 |
| `JUDGE_PROMPT_VERSION` | `agent-engine-v0.2.0` | 결과에 기록할 Judge 프롬프트 버전 |

Judge Worker는 일시적인 Agent Engine 오류를 지수 backoff로 재시도한다. 최대 시도를 초과하면 Case를 `JUDGE_FAILED`로 변경한다.

## 10. 가장 빠른 테스트

### 제공된 답변 평가

```text
1. PostgreSQL 실행
2. Prisma migrate deploy
3. Mock Agent Engine 실행
4. Backend 실행
5. PROVIDED_OUTPUT Run 생성
6. Run 조회 또는 대시보드 확인
```

### Adapter 포함 평가

```text
1. 공통 서비스 실행
2. 프로젝트와 어댑터 등록
3. ADAPTER Run 생성
4. Mock Adapter 실행
5. SdkJob → JudgeJob → EvalResult 확인
```

## 11. 문제 해결

### SDK Key ByteString 오류

```text
Cannot convert argument to a ByteString
```

`AIEVAL_SDK_KEY='여기에_키'` 같은 한글 placeholder를 그대로 사용한 경우 발생한다. `aieval_...` 형식의 실제 키를 사용한다.

### SDK 인증 실패

```text
401 Invalid or inactive SDK key
```

UUID 형식의 Application ID가 아니라 등록 시 한 번 발급된 `aieval_...` SDK Key를 사용한다.

### JudgeJob이 PENDING에서 멈춤

확인 항목:

```text
Backend가 실행 중인가
Judge worker started 로그가 있는가
AGENT_ENGINE_URL이 올바른가
Agent Engine /health가 정상인가
Ollama와 Judge 모델이 실행 중인가
```

### Run이 COMPLETED_WITH_ERRORS

Run 상세 응답에서 Case 상태를 확인한다.

```text
EXECUTION_FAILED
→ 고객 AI 또는 Adapter 연결 문제

JUDGE_FAILED
→ Agent Engine, Ollama 또는 Judge 응답 문제
```

## 12. 종료

각 개발 서버는 실행 터미널에서 `Ctrl+C`로 종료한다.

PostgreSQL 종료:

```bash
docker compose stop postgres
```

데이터를 유지한 채 컨테이너만 중지한다.
