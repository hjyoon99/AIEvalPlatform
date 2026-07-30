# 문제 해결과 트러블슈팅

## 1. 문제를 분리하는 기본 원칙

이 프로젝트는 여러 런타임으로 구성되어 있어 화면의 “평가 실패” 한 문장만으로 원인을 알기 어렵다. 다음 순서로 경계를 확인한다.

```text
Dashboard → Backend → PostgreSQL
                    → Agent Engine → Ollama → Model
```

각 단계의 health 또는 로그를 먼저 확인하고, 통과한 마지막 경계 다음을 조사한다.

```bash
docker compose ps
curl http://localhost:11434/api/tags
curl http://localhost:8000/health
curl http://localhost:3000/api/v1
```

## 2. pnpm 실행 전 서명 또는 버전 전환 오류

### 증상

```text
Refusing to run pnpm...
registry signature could not be verified
fetch failed
```

### 원인

프로젝트가 요구하는 pnpm 버전으로 자동 전환하는 과정에서 npm registry에 접근하지 못했거나, 내려받은 메타데이터를 검증하지 못한 경우다. TypeScript 코드 오류보다 앞에서 발생하므로 `eval.service.ts`와 직접 관련이 없다.

### 확인과 해결

```bash
node --version
pnpm --version
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install
```

사내 프록시 환경이라면 npm registry와 인증서 설정도 확인한다. 코드 문제인지 분리해야 할 때는 이미 설치된 로컬 실행 파일로 타입 검사를 할 수 있다.

```bash
apps/backend/node_modules/.bin/tsc \
  -p apps/backend/tsconfig.json \
  --noEmit
```

## 3. ESLint의 불필요한 타입 단언

### 증상

```text
This assertion is unnecessary since the receiver accepts
the original type of the expression.
@typescript-eslint/no-unnecessary-type-assertion
```

### 발생 이유

Prisma JSON 필드에 객체를 넣으면서 `as Prisma.InputJsonValue`를 붙였지만, 수신 타입이 원래 객체 타입을 이미 허용하면 단언은 정보를 추가하지 않는다.

### 해결 원칙

오류를 숨기기 위해 규칙을 끄지 않고, 해당 단언만 제거한다.

```ts
policySnapshot: {
  name: policy.name,
  passThreshold: policy.passThreshold,
  metrics: policy.metrics,
}
```

반대로 `Record<string, unknown>`처럼 Prisma JSON 타입과 실제로 호환되지 않는 값에는 검증 또는 명시적 변환이 필요하다. 모든 `as`를 기계적으로 제거하면 안 된다.

검증:

```bash
cd apps/backend
./node_modules/.bin/eslint src
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

## 4. ESLint의 객체 문자열 변환 오류

### 증상

```text
will use Object's default stringification format ('[object Object]')
@typescript-eslint/no-base-to-string
```

### 원인

LLM JSON의 `criteria`가 문자열이라고 가정하고 `String(value)`를 호출하면 객체가 들어왔을 때 의미 없는 `[object Object]`가 저장된다.

### 해결

타입을 확인한 뒤 문자열만 허용한다.

```ts
const criteria = item.criteria ?? item.description;

return {
  criteria: typeof criteria === 'string' ? criteria : '',
};
```

이 문제는 린트 스타일 문제가 아니라 외부 모델 출력의 런타임 타입을 신뢰하면 안 된다는 신호다.

## 5. Prisma 타입이 에디터에서만 빨갛게 보임

### 증상

- `project`, `scenario`, `evaluationPolicy`가 PrismaService에 없다고 표시
- 터미널 빌드는 통과하거나 스키마 변경 직후에만 발생

### 원인

`schema.prisma`는 바뀌었지만 생성된 Prisma Client 또는 에디터 TypeScript 캐시가 이전 모델을 보고 있다.

### 해결

```bash
pnpm --filter backend exec prisma generate
```

그 후 VS Code에서 `TypeScript: Restart TS Server`를 실행한다. DB 테이블까지 바뀌었다면 별도로 마이그레이션도 적용한다.

```bash
pnpm --filter backend exec prisma migrate deploy
```

## 6. 데이터베이스 연결 실패

### 증상

```text
DATABASE_URL environment variable is not defined
Failed to connect to the database
```

### 확인

```bash
docker compose ps
docker compose logs postgres
```

로컬 Backend가 Docker의 PostgreSQL에 접근할 때는 compose 외부 포트인 `5433`을 사용한다.

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/eval_platform?schema=public
```

컨테이너끼리 통신하는 구성으로 바꾸면 host와 port가 `postgres:5432`가 된다. 실행 위치에 따라 주소가 다르다는 점이 핵심이다.

## 7. Backend의 `listen EPERM` 또는 `EADDRINUSE`

### `EADDRINUSE`

3000 포트를 다른 프로세스가 사용 중이다. 해당 프로세스를 종료하거나 `apps/backend/.env`의 PORT를 바꾼다.

### `EPERM`

제한된 샌드박스나 실행 환경이 네트워크 포트 바인딩을 허용하지 않을 수 있다. 애플리케이션 초기화와 DB 연결이 성공한 뒤 `listen EPERM`이 발생했다면 EvalService 오류가 아니라 환경 권한 문제다.

이 경우 빌드와 타입 검사는 포트를 열지 않고 수행할 수 있다.

```bash
pnpm --filter backend build
pnpm --filter backend exec tsc -p tsconfig.json --noEmit
```

## 8. Backend가 HTTP 502를 반환함

### 흐름

EvalService는 Agent Engine 호출 실패를 `BadGatewayException`으로 변환한다. 동시에 이미 만든 EvalRun을 `FAILED`로 변경한다.

### 확인 순서

```bash
curl http://localhost:8000/health
curl http://localhost:11434/api/tags
ollama list
```

`AGENT_ENGINE_URL`과 `OLLAMA_HOST`도 확인한다.

```env
AGENT_ENGINE_URL=http://127.0.0.1:8000
OLLAMA_HOST=http://localhost:11434
```

FastAPI 로그에 모델 not found가 있다면:

```bash
ollama pull qwen3.5:4b
```

## 9. 시나리오 자동 검증이 DRAFT로 떨어짐

### 증상

- 시나리오는 생성됐지만 `AUTO_VERIFIED`가 아님
- `VALIDATION_RESPONSE_ERROR`가 있음
- 검증 점수가 0으로 표시됨

### 원인

로컬 소형 모델이 긴 구조화 JSON을 반복하거나 응답이 잘려 Pydantic 파싱에 실패할 수 있다.

### 현재 폴백

생성된 시나리오를 삭제하지 않고 다음 상태로 보존한다.

- `valid: false`
- `score: 0.0`
- `status: DRAFT`
- 사람 검토 필요 사유 기록

### 개선 방법

- 생성 개수를 줄인다.
- 더 긴 context와 안정적인 structured output을 지원하는 모델을 사용한다.
- 루브릭 설명 길이를 줄인다.
- 자동 검증을 시나리오별 개별 호출로 나누되 호출 수 증가를 감수한다.

## 10. 평가 점수와 PASS/FAIL이 예상과 다름

다음 네 층을 순서대로 확인한다.

1. Policy의 weight 합과 `passThreshold`
2. Scenario의 rubric, requiredConditions, failConditions
3. EvalResult.evaluation의 지표별 점수와 누락/위반 조건
4. EvalResult.supervision의 최종 사유와 issues

실패 조건이나 필수 조건 누락이 있으면 가중 평균이 높아도 점수가 0이 된다. 또한 Supervisor가 PASS를 제안해도 점수가 실행 기준보다 낮으면 코드가 FAIL로 바꾼다.

## 11. 재시도가 예상보다 많거나 적음

`maxRetries`는 0~2 범위로 Backend에서 검증한다. 그래프의 초기 `retry_count`는 0이고 Supervisor가 RETRY를 반환할 때 증가한다.

현재 재시도는 답변 재생성이 아니라 Evaluator 재호출이다. “답변을 새로 생성해 다시 평가”하는 기능을 기대했다면 현재 동작과 다르다.

재시도 관련 문제를 볼 때 EvalResult의 `retryCount`와 supervision reason을 함께 확인한다.

## 12. CORS 오류

Backend는 기본적으로 다음 origin을 허용한다.

- `DASHBOARD_URL` 또는 `http://localhost:5173`
- `http://127.0.0.1:5173`

Dashboard를 다른 host나 port에서 실행하면 `apps/backend/.env`를 수정하고 Backend를 재시작한다.

```env
DASHBOARD_URL=http://localhost:새포트
```

## 13. 검증 체크리스트

변경 후 최소 검증:

```bash
cd apps/backend
./node_modules/.bin/eslint src
./node_modules/.bin/tsc -p tsconfig.json --noEmit

cd ../dashboard
./node_modules/.bin/tsc -b
./node_modules/.bin/vite build

cd ../agent-engine
python3 -m compileall -q app
```

문서 변경:

```bash
git diff --check
```

서비스 통합 확인:

```bash
curl http://localhost:11434/api/tags
curl http://localhost:8000/health
curl http://localhost:3000/api/v1
```
