# API 명세서

> Wiki 경로: `API-Reference`

## 기본 주소

| API | Base URL |
| --- | --- |
| Backend | `http://localhost:3000/api/v1` |
| Agent Engine | `http://localhost:8000` |
| FastAPI Swagger | `http://localhost:8000/docs` |

현재 인증은 구현되어 있지 않다. 모든 요청과 응답은 별도 표기가 없으면 JSON이다.

## Backend API

### 상태 확인

```http
GET /api/v1
```

NestJS 기본 응답을 반환한다.

### 프로젝트 생성

```http
POST /api/v1/projects
Content-Type: application/json
```

```json
{
  "name": "고객지원 평가",
  "domain": "전자상거래 고객센터",
  "description": "환불 및 배송 안내 품질 평가",
  "context": {
    "refundWindowDays": 7
  }
}
```

필수: `name`, `domain`

오류:

- 400: name 또는 domain 누락

### 프로젝트 목록

```http
GET /api/v1/projects
```

최신순으로 반환하며 `_count.policies`, `_count.scenarios`, `_count.evalRuns`를 포함한다.

### 평가 정책 생성

```http
POST /api/v1/projects/{projectId}/policies
```

```json
{
  "name": "기본 품질 정책",
  "passThreshold": 0.8,
  "maxRetries": 1,
  "metrics": [
    {
      "key": "accuracy",
      "name": "정확성",
      "description": "정책과 사실에 맞는가",
      "weight": 0.6,
      "required": true
    },
    {
      "key": "tone",
      "name": "응대 품질",
      "description": "명확하고 친절한가",
      "weight": 0.4
    }
  ]
}
```

제약:

- metrics는 한 개 이상이어야 한다.
- weight 합은 1이어야 한다.
- 기본 passThreshold는 0.7이다.
- 기본 maxRetries는 1이다.

### 평가 정책 목록

```http
GET /api/v1/projects/{projectId}/policies
```

프로젝트의 정책을 최신순으로 반환한다.

### 시나리오 생성

```http
POST /api/v1/projects/{projectId}/scenarios/generate
```

```json
{
  "policyId": "policy-uuid",
  "count": 5,
  "model": "qwen3.5:4b"
}
```

`policyId`를 생략하면 프로젝트의 최신 정책을 사용한다. count는 Backend에서 1~10으로 제한한다.

응답은 프로젝트의 전체 Scenario 목록이다.

오류:

- 404: Project가 없음
- 502: Agent Engine 시나리오 생성 실패

### 시나리오 목록

```http
GET /api/v1/projects/{projectId}/scenarios
```

최신순으로 반환한다.

### 시나리오 수정

```http
PATCH /api/v1/scenarios/{scenarioId}
```

모든 필드는 선택 사항이다.

```json
{
  "title": "환불 가능 기간 문의",
  "prompt": "상품을 받은 지 5일 됐는데 환불할 수 있나요?",
  "testOutput": "수령 후 7일 이내라면 환불 신청이 가능합니다.",
  "expectedOutput": "정책 조건을 확인한 뒤 7일 이내 환불 가능성을 안내한다.",
  "expectedBehavior": ["기간 안내", "조건 확인"],
  "evaluationRubric": {
    "metrics": [],
    "requiredConditions": [],
    "failConditions": [],
    "allowedVariations": []
  },
  "riskLevel": "MEDIUM"
}
```

수정 성공 시 상태는 항상 DRAFT가 되고 reviewedAt은 null로 초기화된다. `testOutput: null`은 기존 테스트 출력을 삭제한다.

### 시나리오 승인 또는 거절

```http
PATCH /api/v1/scenarios/{scenarioId}/review
```

승인:

```json
{
  "status": "APPROVED"
}
```

거절:

```json
{
  "status": "REJECTED",
  "rejectionReason": "기대 답변이 업무 정책과 다릅니다."
}
```

status는 APPROVED 또는 REJECTED만 허용한다.

### 평가 실행

```http
POST /api/v1/eval-runs
```

Scenario 기반 예시:

```json
{
  "projectId": "project-uuid",
  "policyId": "policy-uuid",
  "scenarioIds": ["scenario-uuid-1", "scenario-uuid-2"],
  "name": "고객지원 회귀 평가",
  "agentName": "customer-support-agent",
  "model": "qwen3.5:4b"
}
```

직접 dataset 예시:

```json
{
  "name": "빠른 평가",
  "agentName": "sample-agent",
  "model": "qwen3.5:4b",
  "passThreshold": 0.7,
  "maxRetries": 1,
  "dataset": [
    {
      "prompt": "대한민국의 수도는 어디인가요?",
      "output": "대한민국의 수도는 서울입니다.",
      "expectedOutput": "서울",
      "criteria": [
        {
          "key": "accuracy",
          "name": "정확성",
          "weight": 1
        }
      ]
    }
  ]
}
```

제약:

- name과 agentName은 필수다.
- dataset 또는 승인된 scenarioId가 한 개 이상 필요하다.
- passThreshold는 0~1이다.
- maxRetries는 0~2의 정수다.
- Scenario 방식은 선택 프로젝트의 APPROVED 시나리오만 허용한다.

성공 시 results를 포함한 EvalRun 상세를 반환한다. Agent Engine 오류 시 502를 반환하고 실행 상태를 FAILED로 저장한다.

### 평가 실행 목록

```http
GET /api/v1/eval-runs
```

최근 30개 실행과 각 실행의 results를 반환한다.

### 평가 요약

```http
GET /api/v1/eval-runs/summary
```

```json
{
  "totalRuns": 12,
  "totalEvaluations": 48,
  "averageScore": 0.81,
  "passRate": 0.75
}
```

passRate는 0~1 비율이다.

### 평가 실행 상세

```http
GET /api/v1/eval-runs/{id}
```

EvalRun과 생성순 results를 반환한다.

오류:

- 404: Evaluation run을 찾을 수 없음

## Agent Engine API

일반 사용자는 Backend를 통해 호출한다. 다음 API는 엔진 테스트와 내부 연동용이다.

### Health

```http
GET /health
```

```json
{
  "status": "ok",
  "service": "agent-engine",
  "workflow": "langgraph-supervisor"
}
```

### 동기 평가

```http
POST /agents/evaluate/sync
```

```json
{
  "runId": "test-run-001",
  "agentName": "sample-agent",
  "model": "qwen3.5:4b",
  "maxRetries": 1,
  "passThreshold": 0.7,
  "criteria": [],
  "dataset": [
    {
      "prompt": "물의 화학식은?",
      "output": "H2O입니다.",
      "expectedOutput": "H2O"
    }
  ]
}
```

output을 생략하면 Executor가 답변을 생성한다.

응답:

```json
{
  "runId": "test-run-001",
  "results": [
    {
      "prompt": "물의 화학식은?",
      "output": "H2O입니다.",
      "expectedOutput": "H2O",
      "outputSource": "provided",
      "score": 1,
      "passed": true,
      "verdict": "PASS",
      "verification": {},
      "evaluation": {},
      "supervision": {},
      "retryCount": 0,
      "metrics": {}
    }
  ]
}
```

### 비동기 평가

```http
POST /agents/evaluate
```

요청 스키마는 동기 평가와 같다. FastAPI BackgroundTasks에 작업을 등록하고 즉시 Accepted 응답을 반환한다.

```json
{
  "status": "Accepted",
  "message": "Evaluation pipeline started in background.",
  "runId": "test-run-001"
}
```

현재 비동기 API에는 결과 조회 및 영속화가 연결되어 있지 않으므로 Backend는 동기 API를 사용한다.

### 시나리오 생성

```http
POST /scenarios/generate
```

```json
{
  "domain": "전자상거래 고객지원",
  "description": "환불 문의 평가",
  "context": {
    "refundWindowDays": 7
  },
  "criteria": [],
  "count": 5,
  "model": "qwen3.5:4b"
}
```

count는 1~10이다.

```json
{
  "scenarios": [
    {
      "title": "환불 기간 문의",
      "category": "정상",
      "prompt": "수령 후 5일 된 상품을 환불할 수 있나요?",
      "expectedOutput": "조건 확인 후 환불 가능성을 안내한다.",
      "expectedBehavior": ["정책 기간 안내"],
      "evaluationRubric": {},
      "riskLevel": "MEDIUM",
      "autoValidation": {},
      "status": "AUTO_VERIFIED"
    }
  ]
}
```

## curl 예시

```bash
curl http://localhost:8000/health
```

```bash
curl -X POST http://localhost:3000/api/v1/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "고객지원 평가",
    "domain": "전자상거래 고객지원"
  }'
```

```bash
curl http://localhost:3000/api/v1/eval-runs/summary
```

## HTTP 오류 의미

| 상태 | 의미 |
| ---: | --- |
| 400 | 요청 필드 또는 정책·시나리오 조건이 올바르지 않음 |
| 404 | Project, Scenario 또는 EvalRun을 찾을 수 없음 |
| 502 | Backend가 Agent Engine의 정상 응답을 받지 못함 |
