# Judge Worker 동시성과 로컬 Ollama 튜닝

N-way 동시 Judge 처리(#35)를 도입하면서 나눈 기술 논의를 정리한 문서다. 코드 변경 하나(ESLint 오류 수정)와, 로컬 Ollama 환경 튜닝 하나(재부팅 시 초기화됨, 현재는 미적용 상태)를 다룬다.

## 1. `only-throw-error` ESLint 오류 수정

### 증상

```text
Expected an error object to be thrown.
@typescript-eslint/only-throw-error
```

`apps/backend/src/eval/judge-worker.repository.ts`의 네 곳에서 발생했다.

### 원인

```ts
throw {
  code: 'MISSING_OUTPUT',
  message: 'EvalRunCase has no outputAnswer',
  retryable: false,
} satisfies JudgeExecutionError;
```

`JudgeExecutionError`가 일반 인터페이스(`Error`를 상속하지 않음)라서, 이 형태로 `throw`하면 평범한 객체 리터럴을 던지는 셈이 된다. ESLint의 `only-throw-error` 규칙은 `Error`(또는 하위 클래스)만 던지도록 강제한다.

### 해결

`Error`를 상속하는 `JudgeError` 클래스를 추가하고, 네 곳의 `throw { ... }`를 `throw new JudgeError({ ... })`로 교체했다.

```ts
class JudgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(details: JudgeExecutionError) {
    super(details.message);
    this.name = 'JudgeError';
    this.code = details.code;
    this.retryable = details.retryable;
  }
}
```

`normalizeError()`는 `instanceof JudgeError`로 판별한 뒤 다시 평범한 `{code, message, retryable}` 객체로 변환해서 반환한다. DB에 저장할 때(`Prisma.InputJsonValue`) 그대로 JSON 직렬화해야 하는데, `Error` 인스턴스는 `message`가 열거 불가능(non-enumerable) 속성이라 `JSON.stringify`하면 빈 객체로 직렬화되기 때문에, 저장용 값은 항상 평범한 객체로 유지해야 한다. 이제 안 쓰이게 된 `isJudgeError()` 헬퍼는 제거했다.

> 참고: `asRecord()`(judge-worker.repository.ts)에 있는 `no-unnecessary-type-assertion` 오류 하나는 이번 변경과 무관한 기존 이슈로, `docs/troubleshooting.md` §3에 별도로 정리되어 있다.

## 2. Judge Worker N-way 동시성 구조

하나의 폴링 루프를 반복하는 게 아니라, `concurrency`(기본 4, `JUDGE_WORKER_CONCURRENCY`)만큼 **독립된 폴링 슬롯**을 만든다. 슬롯마다 자기 `setTimeout` 타이머를 가지고 `schedule → tick → runOnce` 루프를 돈다. 작업을 처리했으면 곧바로 다음 틱(0ms), 못 찾았으면 `pollIntervalMs` 뒤에 다음 틱을 예약한다.

여러 슬롯이 동시에 폴링해도 같은 작업을 중복 처리하지 않는 건 `claim()`의 원자적 선점 덕분이다. 트랜잭션 안에서:

1. lease가 만료된(`CLAIMED`/`RUNNING`인데 `leaseExpiresAt < now`) 좀비 작업을 `PENDING`으로 회수하고
2. 가장 오래된 `PENDING` 작업 하나를 후보로 고른 뒤
3. `updateMany({ where: { id, status: 'PENDING' } })`로 조건부 업데이트한다 — 여러 슬롯이 동시에 같은 후보를 집어도 실제 행이 바뀌는 건 하나뿐이라(`claimed.count !== 1`이면 포기), 낙관적 락으로 중복 처리를 막는다.

슬롯이 잡은 작업은 `process()`가 처리한다. 상태를 `RUNNING`/`JUDGING`으로 바꾼 뒤 `evaluate()`에서 agent-engine의 `/agents/evaluate/sync`를 동기 호출한다. 즉 슬롯이 4개면 agent-engine으로 나가는 HTTP 호출도 최대 4개가 동시에 떠 있을 수 있다.

## 3. SSE 진행률 스트리밍 구조

`EvalRunEvents`(`apps/backend/src/eval/eval-run.events.ts`)는 Node `EventEmitter` 기반의 **프로세스 내부 in-memory pub/sub**이다. 워커가 별도 프로세스로 분리 배포되면 Postgres LISTEN/NOTIFY나 Redis pub/sub으로 교체가 필요하다는 주석이 코드에 남아 있다.

`complete()`/`finalizeFailure()`가 트랜잭션 커밋 뒤 `emitProgress(evalRunId)`를 호출하면, `/eval-runs/:id/events` SSE 엔드포인트(`eval.controller.ts`)가 이를 구독해 자기 `id`와 일치하는 이벤트마다 `findOne(id)`로 스냅샷을 다시 조회해 클라이언트로 밀어준다. 슬롯이 4개라 케이스 여러 개가 거의 동시에 끝날 수 있어 리스너 상한을 100으로 올려뒀고, `switchMap`을 써서 겹쳐 들어오는 재조회는 이전 걸 취소하고 최신 것만 반영한다.

## 4. Agent Engine 파이프라인은 케이스 내부에서 순차적

`evaluation_graph.py`의 LangGraph 그래프는 `supervisor`를 허브로 두고, 워커 노드(`verify`/`groundedness_check`/`tool_call_check`/`evaluate`)가 실행 후 항상 `supervisor`로만 복귀한다. 즉 케이스 하나의 파이프라인(`verify → [groundedness_check | tool_call_check] → evaluate → supervisor`, RETRY면 반복)은 **완전히 순차적**이며 노드 간 병렬 실행이 없다. 그래서 슬롯 하나당 순간적으로 Ollama에 나가는 호출은 항상 1개뿐이다.

## 5. 동시성 병목은 3단계

케이스 몇백~몇천 개를 빠르게 돌리고 싶을 때, 실제 동시 처리 개수는 다음 세 값 중 최솟값이다.

1. **`JUDGE_WORKER_CONCURRENCY`** (docker-compose 기본 4) — 몇 개의 Judge Job을 동시에 붙잡을지.
2. **agent-engine** — uvicorn 단일 프로세스(`--workers` 옵션 없음)지만 I/O 바운드라 이벤트 루프 하나로도 여러 요청을 동시에 들고 있을 수 있어 추가 병목은 아니다.
3. **Ollama 데몬의 `OLLAMA_NUM_PARALLEL`** — 모델 하나(런타임 하나)가 동시에 처리할 수 있는 배치 슬롯 수. `.env`에 설정돼 있지 않으면 로컬 Ollama의 기본값(메모리 상황에 따라 자동 결정, 보통 1~4)을 따른다.

`JUDGE_WORKER_CONCURRENCY`만 올리는 건 LLM 호출 자체의 동시 처리량에는 별 의미가 없다 — Ollama 쪽 `OLLAMA_NUM_PARALLEL`이 낮으면 결국 Ollama 내부 큐에 쌓여 순차 처리된다.

## 6. 데몬 하나로도 진짜 병렬 처리가 되는가

된다. `OLLAMA_NUM_PARALLEL`은 데몬을 여러 개 띄우는 게 아니라, **데몬 하나 안에서 로드된 모델 런타임 하나가 요청 여러 개를 배치(batch)로 묶어 처리**하게 하는 옵션이다(vLLM류의 continuous batching과 비슷한 개념). 다만 트레이드오프가 있다.

- **메모리** — 병렬 슬롯마다 KV 캐시를 따로 예약해야 해서, 값을 올릴수록 그 모델이 쓰는 VRAM/RAM이 슬롯 수만큼 늘어난다.
- **연산량은 그대로** — 배치로 묶여도 총 연산량은 동일하다. "N배 빨라진다"가 아니라 "케이스 여러 개를 처리하는 총 시간이 줄어든다"에 가깝고, 개별 요청 하나의 응답 속도는 오히려 약간 느려질 수 있다.
- **CPU 추론이면 효과가 제한적** — GPU 배치 연산의 이득이 CPU에선 상대적으로 작다.
- **모델이 여러 종류면 `OLLAMA_MAX_LOADED_MODELS`가 별도로 관여** — 지금 구성처럼 verifier/evaluator/supervisor가 같은 `judgeModel` 하나를 쓰면 `OLLAMA_NUM_PARALLEL`만 신경 쓰면 된다.

## 7. 로컬 환경에 실제 적용한 내용 (2026-08-13 기준)

로컬 macOS 환경 확인 결과: Ollama는 Homebrew 서비스(`launchd`, `homebrew.mxcl.ollama`)로 떠 있고, `qwen3.5:4b`(3.4GB) 모델 하나만 사용 중이며, 시스템 메모리는 16GB. `~/Library/LaunchAgents/homebrew.mxcl.ollama.plist`에 이미 `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`(KV 캐시 8비트 양자화, 메모리 절약)이 설정돼 있었다.

`JUDGE_WORKER_CONCURRENCY`(4)에 맞춰 `OLLAMA_NUM_PARALLEL=4`를 적용하기로 하고 두 가지 방법을 시도했다.

1. **plist 직접 수정 → 실패.** `EnvironmentVariables`에 `OLLAMA_NUM_PARALLEL=4`를 추가하고 `brew services restart ollama`를 실행했더니, Homebrew가 재시작 시 포뮬러 정의로 plist를 다시 생성해버려서 수정 내용이 그대로 사라졌다. `launchctl print gui/$(id -u)/homebrew.mxcl.ollama`로 확인 시 `environment`에 `OLLAMA_NUM_PARALLEL`이 빠져 있었다.
2. **`launchctl setenv` → 성공.** `launchctl setenv OLLAMA_NUM_PARALLEL 4` 실행 후 `brew services restart ollama`로 확인하니 job의 `inherited environment`에 `OLLAMA_NUM_PARALLEL => 4`가 반영됐다. 이 방식은 launchd 사용자 도메인 환경에 값을 설정하는 것이라 brew의 plist 재생성에 영향받지 않는다.

**제약 — 재부팅 시 초기화됨.** `launchctl setenv`는 로그아웃/재부팅하면 초기화된다. 재부팅 후에도 계속 4-way 병렬을 쓰려면 `launchctl setenv OLLAMA_NUM_PARALLEL 4` 명령을 다시 실행해야 한다. 이를 자동화하려면 로그인 시 이 명령을 실행해주는 LaunchAgent를 하나 더 만들면 되는데(껐다 켜기 쉬움 — `launchctl bootout`으로 끄고 plist 파일만 지우면 원상복구), 현재는 **적용하지 않기로 결정**했다. 필요해지면 그때 다시 켜기로 하고, 이 사실을 `.env`에 주석으로 남겨뒀다(`OLLAMA_HOST` 옆).

## 8. 남은 선택지

- 재부팅 후 병렬 처리가 다시 느려진 것처럼 느껴지면, `launchctl setenv OLLAMA_NUM_PARALLEL 4` && `brew services restart ollama`를 다시 실행하면 된다.
- 재부팅마다 수동으로 재실행하는 게 번거로워지면, 로그인 시 자동으로 이 값을 설정해주는 LaunchAgent를 추가로 만들 수 있다(가역적이고 제거가 쉬움).
