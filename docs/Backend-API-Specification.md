# Backend API 명세

이 문서는 `apps/backend/src`의 현재 구현을 기준으로 한 Backend REST API 계약이다.

## 공통 규약

| 항목 | 값 |
| --- | --- |
| 기본 URL | `http://localhost:3000/api/v1` |
| Content-Type | `application/json` |
| 날짜/시간 | ISO 8601 UTC 문자열 |
| 식별자 | UUID 문자열 |
| 관리 API 인증 | 현재 없음 |
| SDK 프로토콜 인증 | `Authorization: Bearer {sdkKey}` |

NestJS 기본 오류 응답은 다음 형태다.

```json
{
  "statusCode": 400,
  "message": "name and domain are required",
  "error": "Bad Request"
}
```

주요 상태 코드는 `200` 성공, `201` 생성 성공, `204` 본문 없는 성공, `400` 입력 오류, `401` SDK 인증 실패, `404` 리소스 없음, `409` 상태 충돌, `502` Agent Engine 오류다. 별도 DTO 런타임 변환이나 전역 ValidationPipe는 적용되어 있지 않으므로 명세에 없는 필드는 현재 제거되지 않을 수 있다.

## Endpoint 요약

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/` | Backend 상태 문자열 |
| POST/GET | `/projects` | 프로젝트 생성/목록 |
| DELETE | `/projects/{projectId}` | 프로젝트 삭제 |
| GET/PATCH | `/projects/{projectId}/agent-prompts` | 평가 에이전트 프롬프트 조회/수정 |
| POST/GET | `/projects/{projectId}/policies` | 정책 생성/목록 |
| DELETE | `/policies/{policyId}` | 정책 삭제 |
| POST/GET | `/projects/{projectId}/scenarios` | 시나리오 생성/목록 |
| POST | `/projects/{projectId}/scenarios/generate` | AI 시나리오 생성 |
| PATCH/DELETE | `/scenarios/{scenarioId}` | 시나리오 수정/삭제 |
| PATCH | `/scenarios/{scenarioId}/review` | 시나리오 승인/거절 |
| POST/GET | `/projects/{projectId}/applications` | AI Application 생성/목록 |
| DELETE | `/applications/{applicationId}` | AI Application 삭제 |
| POST/GET | `/applications/{applicationId}/jobs` | SDK Job 수동 생성/목록 |
| POST/GET | `/eval-runs` | 평가 실행 생성/최근 목록 |
| GET | `/eval-runs/summary` | 평가 집계 |
| GET/DELETE | `/eval-runs/{id}` | 실행 상세/삭제 |
| POST | `/sdk/v1/jobs/claim` | SDK Job claim |
| POST | `/sdk/v1/jobs/{jobId}/start` | SDK Job 시작 |
| POST | `/sdk/v1/jobs/{jobId}/complete` | SDK Job 완료 |
| POST | `/sdk/v1/jobs/{jobId}/fail` | SDK Job 실패 |

## 프로젝트

### 프로젝트 생성

`POST /projects`

```json
{
  "name": "고객지원 평가",
  "domain": "전자상거래",
  "description": "환불·배송 응답 품질 평가",
  "context": { "refundWindowDays": 7 }
}
```

`name`, `domain`은 공백이 아닌 문자열이어야 한다. 응답은 생성된 `Project`다.

### 프로젝트 목록

`GET /projects`

생성일 내림차순 배열이며 각 항목에 `_count.policies`, `_count.scenarios`, `_count.evalRuns`가 포함된다.

### 프로젝트 삭제

`DELETE /projects/{projectId}`

```json
{ "id": "project-uuid", "deleted": true }
```

`QUEUED` 또는 `RUNNING` 실행이 있으면 `409`다. 삭제 연쇄 효과는 [데이터베이스 설계](./Database-Design.md)를 따른다.

### Agent Prompt

`GET /projects/{projectId}/agent-prompts`는 `verifier`, `evaluator`, `supervisor` 프롬프트를 반환한다. 저장값이 없으면 시스템 기본값을 반환한다.

`PATCH /projects/{projectId}/agent-prompts`

```json
{
  "verifier": "유효성과 안전성을 검증한다.",
  "evaluator": "정책 기준으로 채점한다.",
  "supervisor": "최종 판정을 감사한다."
}
```

세 값 모두 필수이며 각 1~20,000자다.

## 평가 정책

### 생성

`POST /projects/{projectId}/policies`

```json
{
  "name": "기본 정책",
  "passThreshold": 0.8,
  "maxRetries": 1,
  "metrics": [
    {
      "key": "accuracy",
      "name": "정확성",
      "description": "정책과 사실에 부합하는가",
      "weight": 1,
      "required": true
    }
  ]
}
```

`name`과 1개 이상의 `metrics`가 필수이며 `weight` 합은 오차 `0.001` 이내에서 1이어야 한다. 기본값은 `passThreshold=0.7`, `maxRetries=1`이다. 현재 이 Endpoint는 threshold 범위와 retry 범위를 별도로 검증하지 않는다.

### 목록과 삭제

- `GET /projects/{projectId}/policies`: 생성일 내림차순 배열
- `DELETE /policies/{policyId}`: `{ "id": "...", "deleted": true }`

정책 삭제 후 기존 실행은 유지되고 `policyId`가 `null`이 되며 `policySnapshot`은 보존된다.

## 시나리오

### 직접 생성

`POST /projects/{projectId}/scenarios`

```json
{
  "title": "환불 기간 문의",
  "category": "refund",
  "prompt": "수령 5일 후 환불할 수 있나요?",
  "testOutput": "7일 이내라면 가능합니다.",
  "expectedOutput": "조건을 확인하고 환불 가능 기간을 안내한다.",
  "expectedBehavior": ["기간 안내", "조건 확인"],
  "evaluationRubric": {
    "requiredConditions": ["7일을 언급한다"],
    "failConditions": ["무조건 환불을 약속한다"]
  },
  "riskLevel": "MEDIUM"
}
```

`title`, `prompt`가 필수다. 초기 `status`는 `DRAFT`, 기본 `riskLevel`은 `MEDIUM`이다.

### AI 생성

`POST /projects/{projectId}/scenarios/generate`

```json
{ "policyId": "policy-uuid", "count": 5, "model": "qwen3.5:4b" }
```

정책을 생략하면 최신 정책을 사용하며 `count`는 서버에서 1~10으로 보정된다. Agent Engine의 `/scenarios/generate`를 호출하고, 생성된 시나리오를 저장한 후 프로젝트의 전체 시나리오를 반환한다. 엔진 실패는 `502`다.

### 목록, 수정, 검토, 삭제

- `GET /projects/{projectId}/scenarios`: 생성일 내림차순 배열
- `PATCH /scenarios/{scenarioId}`: `title`, `prompt`, `testOutput`, `expectedOutput`, `expectedBehavior`, `evaluationRubric`, `riskLevel` 부분 수정
- `PATCH /scenarios/{scenarioId}/review`: 아래 검토 요청
- `DELETE /scenarios/{scenarioId}`: 삭제 결과 반환

```json
{ "status": "APPROVED" }
```

또는:

```json
{ "status": "REJECTED", "rejectionReason": "기대 답변 수정 필요" }
```

수정 후에는 항상 `DRAFT`, `reviewedAt=null`이 된다. `testOutput:null`은 출력 삭제다. 검토 status는 `APPROVED|REJECTED`만 허용한다.

## AI Application과 수동 Job

### Application 생성

`POST /projects/{projectId}/applications`

```json
{ "name": "운영 챗봇", "environment": "production" }
```

```json
{
  "application": {
    "id": "application-uuid",
    "projectId": "project-uuid",
    "name": "운영 챗봇",
    "environment": "production",
    "active": true,
    "createdAt": "2026-08-06T00:00:00.000Z",
    "updatedAt": "2026-08-06T00:00:00.000Z"
  },
  "sdkKey": "aieval_..."
}
```

`name`이 필수이며 environment 기본값은 `development`다. 원본 `sdkKey`는 이 응답에서만 반환되고 DB에는 SHA-256 해시만 저장된다.

### Application 목록과 삭제

- `GET /projects/{projectId}/applications`: 생성일 내림차순, Job 수와 최근 Job 상태 포함
- `DELETE /applications/{applicationId}`: 삭제 결과 반환

연결된 자동 평가 Job이 `PENDING|CLAIMED|RUNNING`이면 삭제는 `409`다.

### 수동 Job 생성과 목록

`POST /applications/{applicationId}/jobs`

```json
{
  "testCase": { "id": "case-1", "prompt": "배송은 언제 오나요?" },
  "timeoutMs": 30000,
  "maxAttempts": 3
}
```

활성 Application만 가능하다. `testCase` 객체는 필수, `timeoutMs`는 1,000~300,000 정수, `maxAttempts`는 1~5 정수다. `GET /applications/{applicationId}/jobs`는 최신 100개를 반환하며 lease와 idempotency key는 노출하지 않는다.

## 평가 실행

### 요청 모델

`POST /eval-runs`

```ts
interface StartEvalRunRequest {
  projectId?: string;
  policyId?: string;
  scenarioIds?: string[];
  applicationId?: string;
  executionMode?: "ADAPTER" | "PROVIDED_OUTPUT";
  name: string;
  agentName?: string;
  model?: string;
  judgeModel?: string;
  passThreshold?: number; // 0..1
  maxRetries?: number;    // 0..2 integer
  timeoutMs?: number;     // 1000..300000, automated run
  maxAttempts?: number;   // 1..5, ADAPTER execution
  dataset?: DatasetItem[];
}

interface DatasetItem {
  id?: string;
  prompt: string;
  output?: string;
  expectedOutput?: string;
  variables?: Record<string, unknown>;
  context?: unknown[];
  expectedBehavior?: string[];
  requiredConditions?: string[];
  failConditions?: string[];
  allowedVariations?: string[];
  criteria?: Record<string, unknown>[];
}
```

`dataset`이 없고 `scenarioIds`가 있으면 선택 프로젝트의 승인된 시나리오를 dataset으로 변환한다.

### 자동화 실행

`executionMode`를 명시하면 비동기 실행을 만든다.

ADAPTER 예:

```json
{
  "projectId": "project-uuid",
  "applicationId": "application-uuid",
  "executionMode": "ADAPTER",
  "name": "운영 챗봇 회귀 평가",
  "dataset": [
    {
      "id": "refund-1",
      "prompt": "5일 지난 상품을 환불하고 싶어요.",
      "expectedOutput": "7일 이내 환불 가능 조건을 안내한다."
    }
  ]
}
```

PROVIDED_OUTPUT 예:

```json
{
  "executionMode": "PROVIDED_OUTPUT",
  "name": "저장 출력 평가",
  "dataset": [
    {
      "prompt": "대한민국의 수도는?",
      "output": "서울입니다.",
      "expectedOutput": "서울"
    }
  ]
}
```

공통 제약:

- 1개 이상의 dataset 또는 승인된 scenario가 필요하다.
- 모든 항목에 공백이 아닌 `prompt`가 필요하다.
- PROVIDED_OUTPUT은 모든 항목에 공백이 아닌 `output`이 필요하다.
- `expectedOutput`이 없는 RUBRIC_ONLY 항목은 criteria, 기대 행동/필수/실패 조건 또는 정책 metrics가 필요하다.
- ADAPTER는 활성 `applicationId`가 필수이며 project와 application/policy의 소속이 일치해야 한다.

응답은 `QUEUED` 실행 상세다. ADAPTER는 case별 `SdkJob`, PROVIDED_OUTPUT은 `JudgeJob`을 생성한다.

### 레거시 동기 실행

`executionMode`를 생략하면 `name`, `agentName`, dataset이 필수다. Backend가 Agent Engine 평가를 기다린 뒤 `COMPLETED` 실행과 results를 반환한다. 엔진 실패 시 실행을 `FAILED`로 저장하고 `502`를 반환한다.

### 조회, 요약, 삭제

- `GET /eval-runs`: 최근 30개, cases 상태, results, 계산된 `progress`
- `GET /eval-runs/{id}`: application, cases, SDK/Judge Job 요약, result를 포함한 상세
- `GET /eval-runs/summary`: 아래 전체 집계
- `DELETE /eval-runs/{id}`: 종결 실행 삭제; `QUEUED|RUNNING`은 `400`

```json
{
  "totalRuns": 12,
  "totalEvaluations": 48,
  "averageScore": 0.81,
  "passRate": 0.75
}
```

## SDK 실행 프로토콜

SDK용 네 Endpoint의 상세 계약과 상태 전이는 [SDK API 명세](./SDK-API-Specification.md)를 참고한다.

