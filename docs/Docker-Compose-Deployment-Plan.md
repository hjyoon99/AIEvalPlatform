# Docker Compose 통합 실행 및 고객사 배포

## 1. 문서 목적

이 문서는 AIEvalPlatform의 Mock 평가 환경을 Docker Compose 명령 한 번으로 실행하는 방법과 실제 고객사 배포 확장 방향을 설명한다.

다음 두 환경을 대상으로 한다.

- 개발자 또는 평가 담당자가 사용하는 Mock 테스트 환경
- 실제 고객 AI 서비스와 연결하는 고객사 내부망 환경

현재 통합 Compose에는 PostgreSQL, Backend, Dashboard, Mock Agent Engine이 포함되어 있다. Mock Adapter는 SDK 키 발급 후 선택적으로 실행한다. 실제 Agent Engine, Ollama 및 고객별 Adapter를 포함하는 운영 배포 구성은 후속 확장 대상이다.

## 2. 기존 개별 실행 방식

현재는 구성요소를 각각 실행해야 한다.

```text
터미널 1: PostgreSQL
터미널 2: Mock Agent Engine 또는 실제 Agent Engine
터미널 3: Backend + Judge Worker
터미널 4: Dashboard
터미널 5: SDK Adapter Worker(ADAPTER 평가인 경우)
```

예시는 다음과 같다.

```bash
docker compose up -d postgres
```

```bash
node examples/mock-agent-engine.mjs
```

```bash
pnpm dev:backend
```

```bash
pnpm dev:dashboard
```

ADAPTER 평가에서는 SDK Worker도 실행한다.

```bash
AIEVAL_BASE_URL='http://localhost:3000/api/v1' \
AIEVAL_SDK_KEY='발급받은 SDK 키' \
node examples/sdk-test-worker.mjs
```

## 3. 현재 통합 실행 방식

Mock Judge 환경에서는 다음 명령 한 번으로 공통 구성요소를 실행한다.

```bash
cp .env.example .env
docker compose up -d --build
```

실행되는 서비스는 다음과 같다.

```text
postgres
mock-agent-engine
backend
dashboard
```

통합 Mock 서비스 구성은 다음과 같다.

```text
브라우저
   │
   ▼
Dashboard
   │
   ▼
Backend + Judge Worker ───── PostgreSQL
   │
   ▼
Agent Engine ─────────────── Ollama

Backend ◀──── SDK Adapter ──▶ 고객 AI
         Job API              내부 API
```

| Compose 서비스 | 책임 | 필수 여부 |
|---|---|---|
| `postgres` | 프로젝트, Job, 답변, 평가 결과 저장 | 필수 |
| `backend` | API, EvalRun 오케스트레이션, Judge Worker | 필수 |
| `dashboard` | 평가 설정, 실행 현황 및 결과 화면 | 필수 |
| `agent-engine` | Ollama를 호출하여 답변 평가 | 운영 구성 확장 대상 |
| `mock-agent-engine` | Agent Engine과 Judge 응답 모사 | Mock 프로필에서 사용 |
| `customer-adapter` | SdkJob을 받아 고객 AI 호출 | ADAPTER 평가에서 사용 |
| `ollama` | 고객사 내부 Judge 모델 제공 | 운영 구성 확장 대상 |

## 4. 두 가지 테스트 프로필

### 4.1 PROVIDED_OUTPUT 테스트

이미 생성된 답변을 평가한다. 고객 AI와 SDK Adapter가 필요하지 않다.

```text
평가 API 요청
→ EvalRunCase 생성
→ JudgeJob 생성
→ Mock 또는 실제 Judge 실행
→ EvalResult 저장
```

필요한 서비스는 다음과 같다.

```text
postgres
backend
dashboard
mock-agent-engine 또는 agent-engine
```

### 4.2 ADAPTER 테스트

평가 질문을 실제 고객 AI에 전달하여 답변을 생성한 뒤 평가한다.

```text
평가 API 요청
→ SdkJob 생성
→ SDK Adapter가 Job claim
→ 고객 AI 호출
→ 생성 답변 제출
→ JudgeJob 생성
→ EvalResult 저장
```

필요한 서비스는 다음과 같다.

```text
postgres
backend
dashboard
mock-agent-engine 또는 agent-engine
customer-adapter
고객 AI
```

## 5. 네트워크 주소 규칙

Compose 컨테이너끼리는 `localhost` 대신 서비스 이름을 사용한다.

```text
Backend → postgresql://postgres:5432/eval_platform
Backend → http://agent-engine:8000
Adapter → http://backend:3000/api/v1
Agent Engine → http://ollama:11434
```

컨테이너 내부에서 `localhost`는 해당 컨테이너 자신을 가리킨다.

고객 AI가 개발자의 macOS 호스트에서 실행 중이라면 다음 주소를 사용한다.

```env
CUSTOMER_AI_URL=http://host.docker.internal:9000
```

고객 AI가 사내 다른 서버에서 실행 중이라면 실제 내부 DNS 또는 IP를 사용한다.

```env
CUSTOMER_AI_URL=http://customer-ai.internal:9000
```

## 6. 환경변수 계획

고객사는 저장소에 포함되지 않는 `.env` 파일에 설치별 설정을 입력한다.

```env
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change-me
POSTGRES_DB=eval_platform

BACKEND_PORT=3000
DASHBOARD_PORT=5173

AIEVAL_SDK_KEY=replace-with-issued-sdk-key
CUSTOMER_AI_URL=http://customer-ai.internal:9000
CUSTOMER_AI_KEY=replace-with-customer-ai-key

AGENT_ENGINE_URL=http://agent-engine:8000
OLLAMA_HOST=http://ollama:11434
JUDGE_MODEL=qwen3.5:4b
```

API 키와 비밀번호가 포함된 실제 `.env` 파일은 Git에 커밋하지 않는다. 고객사 운영 환경에서는 Docker Secret이나 사내 비밀 관리 시스템 사용을 권장한다.

## 7. 실제 고객 AI Adapter

고객별 변경 범위는 Adapter의 `invoke()`에 한정한다.

```ts
createEvaluationAdapter({
  async invoke(input) {
    const response = await fetch(process.env.CUSTOMER_AI_URL!, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CUSTOMER_AI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: input.question,
        context: input.context,
      }),
    });

    const payload = await response.json();

    return {
      output: payload.answer,
    };
  },
});
```

고객마다 주로 다음 부분만 달라진다.

- 고객 AI API 주소
- 인증 헤더
- 요청 payload
- 응답에서 최종 답변을 추출하는 방법
- 필요한 경우 세션 ID, RAG 문맥, 도구 호출 정보 매핑

## 8. Ollama 실행 선택지

### Linux 또는 GPU 서버

Ollama를 Compose 서비스로 함께 실행할 수 있다.

```text
Agent Engine → http://ollama:11434
```

GPU 사용을 위해서는 고객사 서버의 Docker 및 NVIDIA Container Toolkit 설정이 별도로 필요하다.

### macOS 개발 환경

호스트에 설치된 Ollama를 사용할 수 있다.

```env
OLLAMA_HOST=http://host.docker.internal:11434
```

### 빠른 Mock 테스트

Ollama 대신 `examples/mock-agent-engine.mjs`에 해당하는 Mock 서비스를 사용한다. Mock은 통합 흐름을 검증하기 위한 것으로 실제 Judge 품질을 검증하지 않는다.

## 9. 통합 실행 후 운영 명령

다음 명령은 현재 통합 Mock Compose에서 사용할 수 있다.

전체 서비스 상태:

```bash
docker compose ps
```

전체 로그:

```bash
docker compose logs -f
```

특정 서비스 로그:

```bash
docker compose logs -f backend
docker compose logs -f customer-adapter
docker compose logs -f agent-engine
```

서비스 재시작:

```bash
docker compose restart backend
```

전체 종료:

```bash
docker compose down
```

DB 볼륨까지 삭제:

```bash
docker compose down -v
```

> `docker compose down -v`는 PostgreSQL의 평가 데이터까지 삭제한다. 테스트 데이터를 초기화하려는 경우에만 사용한다.

## 10. 구현 현황과 후속 작업

현재 완료된 항목:

1. Backend용 Dockerfile
2. Dashboard 빌드 및 Nginx 이미지
3. Mock Agent Engine 이미지
4. Mock Adapter 이미지와 `adapter` 프로필
5. Backend 시작 전 PostgreSQL migration 자동 실행
6. 서비스 health check 및 시작 순서
7. `.env.example`

후속 운영 배포 작업:

1. 실제 Agent Engine Dockerfile 구현
2. Ollama를 포함하거나 외부 Ollama 주소를 선택하는 프로필
3. 고객별 Adapter 이미지 템플릿
4. 운영용 Secret 관리
5. TLS와 사내 인증 연동
6. 이미지 레지스트리 배포 및 버전 고정

## 11. Mock 통합 테스트 기준

통합 Compose 작업은 다음 조건을 만족하면 완료된 것으로 본다.

- 새 환경에서 `docker compose up -d --build`가 성공한다.
- PostgreSQL migration이 자동 적용된다.
- Dashboard에서 Backend API를 호출할 수 있다.
- PROVIDED_OUTPUT 평가가 `EvalResult`까지 완료된다.
- ADAPTER 평가가 `SdkJob → JudgeJob → EvalResult`까지 완료된다.
- 컨테이너 재시작 후에도 대기 중인 Job과 결과가 유지된다.
- `docker compose logs`에서 구성요소별 실패 원인을 확인할 수 있다.
- 고객 AI URL과 SDK 키를 환경변수만으로 변경할 수 있다.

## 12. Mock Adapter 추가 실행

기본 Compose만으로 PROVIDED_OUTPUT 평가를 테스트할 수 있다. ADAPTER 평가에서는 먼저 Dashboard 또는 API로 Application을 등록하여 `aieval_...` 형식 SDK 키를 발급받는다.

```bash
printf 'AIEVAL_SDK_KEY=aieval_발급받은_키\n' >> .env
docker compose --profile adapter up -d --build mock-adapter
```

Mock Adapter 로그:

```bash
docker compose logs -f mock-adapter
```

SDK 키가 비어 있거나 Application ID를 SDK 키로 사용하면 Adapter 인증에 실패한다.
