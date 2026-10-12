# Lease 펜싱 수정: 수정 전·후 비교

> 작성일 2026-10-12 · 수정 전 기준 커밋 `70851b4` · SDK 경로의 CAS 전환은 `a52c8fe`(`fix/lease-cas-atomic`,
> [SDK-Job-Lease-Race-Fix.md](SDK-Job-Lease-Race-Fix.md))에서, Judge 경로·멱등 보완·통합 테스트는 이어지는 커밋에서 적용 · 대상 코드 `apps/backend/src/eval/judge-worker.repository.ts`,
> `apps/backend/src/sdk-protocol/sdk-protocol.repository.ts` · 검증 `apps/backend/test/integration/`

## 1. 한 줄 요약

작업을 잡았던 워커가 느려져 **소유권(lease)을 잃은 뒤에도 쓰기를 해서 새 소유자의 작업을 덮어쓰던 문제**를,
모든 상태 변경 UPDATE에 **"내 leaseId가 아직 유효할 때만"** 조건을 걸어 고쳤다.
실제 PostgreSQL 통합 테스트 23개 중 **10개가 실패하던 것이 23개 전부 통과**한다.

| | 수정 전 | 수정 후 |
|---|---|---|
| 통합 테스트 | 13 통과 / **10 실패** | **23 통과** (기본 3회 반복 + 300라운드 스트레스 모두 통과) |
| 소유권을 잃은 워커의 뒤늦은 쓰기 | 수락되어 새 소유자 상태를 덮어씀 | 거부(SDK는 409, Judge는 조용히 폐기) |
| 같은 완료 요청이 동시에 8개 도착 | 완료 쓰기가 **8회** 실행 | **1회** 실행, 나머지는 저장된 결과를 반환 |

---

## 2. 어떤 문제였나 (쉬운 설명)

코인 사물함을 떠올리면 쉽다.

- 워커가 작업을 **claim** 하면 사물함에 자기 이름(`leaseId`)과 **반납 기한**(`leaseExpiresAt`)이 적힌 열쇠를 받는다.
- 기한이 지나도록 안 끝나면 관리인(다른 워커의 claim)이 사물함을 비우고 **새 열쇠(새 leaseId)** 로 다른 워커에게 준다.
- 문제는 **느릴 뿐 죽지는 않은 워커**다. 기한이 지나 사물함이 다른 사람에게 넘어간 줄 모르고, 뒤늦게 돌아와
  "내 짐 넣을게요" 하고 **옛 열쇠 번호로 쓰기**를 한다. 코드가 열쇠 번호를 안 보거나, **보더라도 보는 시점과 쓰는 시점이 달랐다.**

그 결과 이런 일이 일어났다 (수정 전 실제 측정).

| 상황 | 수정 전 결과 |
|---|---|
| 느린 Judge 슬롯이 뒤늦게 `complete()` | 결과가 수락되고 작업이 COMPLETED로 바뀌며 **새 소유자의 lease가 지워짐** |
| 성공 처리된 뒤 느린 슬롯이 늦은 `fail()` | 케이스가 JUDGE_FAILED로 덮여 **결과 행은 있는데 EvalRun 전체가 FAILED** |
| 새 소유자가 처리 중일 때 늦은 `fail()`(재시도 가능) | 작업이 PENDING으로 **재큐잉**되어 세 번째 평가가 돌 수 있음 |
| 만료 스캔 직후 정상 완료된 작업 | 다른 슬롯의 갱신이 **COMPLETED를 PENDING으로 되돌려** 다시 평가됨 |
| SDK에서 검사 직후 재할당된 lease로 `complete/start/fail` | 검사를 통과해 **이전 워커의 요청이 수락**됨 |
| 같은 완료 요청이 동시에 8개 도착 | 모두 중복 검사를 통과해 **완료 쓰기 8회 실행** (최종 상태만 우연히 수렴) |

원인은 한 가지 패턴이다: **check-then-act** (확인 따로, 쓰기 따로).
`조회해서 lease가 유효한지 확인 → (이 사이에 상황이 바뀜) → id만 조건으로 UPDATE` 구조라서,
확인한 뒤에 바뀐 상황을 쓰기가 알 수 없었다. Judge 경로는 아예 확인 자체가 없었다.

---

## 3. 어떻게 검증했나

mock이 아니라 **실제 PostgreSQL**(행 잠금과 조건부 UPDATE에 의존하는 로직이라 mock으로는 증명되지 않는다)에서 검증했다.

- 테스트: `apps/backend/test/integration/sdk-protocol.integration-spec.ts`, `judge-lease.integration-spec.ts`
- 도우미: `helpers.ts` — 별도 테스트 DB(`*_test`가 아니면 실행 거부), 쓰기 횟수 계측(`$extends`), 인터리빙 강제(barrier)
- **인터리빙 강제**: "검사를 통과한 바로 직후에 다른 워커가 lease를 회수·재할당"하는 최악의 순서를 코드로 만들어
  우연에 의존하지 않고 결함을 재현한다 (3-b/3-c/3-d, J-6, 4-b).
- lease 만료는 DB의 만료 시각을 과거로 바꿔 시뮬레이션한다(SDK 최소 lease가 60초라서).

처음 19개 테스트에서 5개 실패가 나왔고, 같은 결함을 더 세밀하게 겨냥하는 테스트(3-c, 3-d, J-6, J-7)와 4-a의
엄격한 단언을 추가해 **수정 전 기준선을 23개 중 10개 실패**로 확정한 뒤 코드를 고쳤다.

---

## 4. 수정 전 기록

원본 측정값은 JSON으로 보존했다.

| 위치 | 내용 |
|---|---|
| `apps/backend/test/integration/results/before-fix/` | **수정 전** (기본 반복 50, 23개 테스트 기준) |
| `apps/backend/test/integration/results/after-fix/` | 수정 후 (같은 조건) |
| `apps/backend/test/integration/results/after-fix-stress/` | 수정 후 스트레스 (반복 300) |
| `apps/backend/test/integration/results/*.json` | 가장 최근 실행 결과 |

수정 전 실패 10건:

| 테스트 | 검증하려는 불변식 | 수정 전 실제 결과 |
|---|---|---|
| SDK 3-b | 검사 직후 재할당돼도 이전 워커의 `complete`는 거부 | **수락**, output=`A-stale`, 새 소유자 lease 삭제 |
| SDK 3-c | 〃 `start` 거부 | **수락**, 새 소유자 작업이 RUNNING으로 바뀜 |
| SDK 3-d | 〃 `fail`이 새 소유자 작업을 못 바꿈 | **수락**, 작업 FAILED·케이스 EXECUTION_FAILED, lease 삭제 |
| SDK 4-a | 동일 완료 요청 8개 동시 → 쓰기 1회 (50라운드) | 라운드마다 **8회** (`{"8": 50}`) |
| SDK 4-b | 조회 통과 후 동시 쓰기 강제 → 쓰기 1회 | sdkJob 8 · case 8 · JudgeJob upsert 8회 |
| Judge J-3 | 소유권 잃은 슬롯의 `complete()`는 무효 | 수락, 결과 행이 stale 슬롯 것, lease 삭제 |
| Judge J-4 | 성공 후 늦은 `fail()`이 성공을 못 덮음 | 케이스 JUDGE_FAILED, **Run FAILED** |
| Judge J-5 | 새 소유자 처리 중 늦은 `fail()` 무효 | 작업 PENDING 재큐잉, lease 삭제 |
| Judge J-6 | 만료 스캔 직후 완료된 작업은 되돌리지 않음 | 완료된 작업이 **재claim**(attempt=2) |
| Judge J-7 | 소유권 잃은 슬롯은 평가 호출 전에 중단 | 평가 API **1회 호출**, 새 소유자 상태 변경 |

통과하던 것(수정 전에도 안전했던 부분): 동시 claim 중복 0건, lease 만료 후 재할당, 시도 횟수 소진 처리,
다른 작업의 멱등키 재사용 409(4-c), 첫 완료 이후 순차 재전송 쓰기 0회(4-d), 일반적인 오래된 lease 거부(3-a).

---

## 5. 무엇을 어떻게 고쳤나

### 5.1 핵심 아이디어: "확인"을 "쓰기" 안으로 넣는다

수정 전: `조회로 확인 → UPDATE where id` (두 단계, 사이가 비어 있음)
수정 후: **`UPDATE ... WHERE id AND leaseId = 내 것 AND status = 진행 중` 한 문장** 으로 확인과 쓰기를 합치고,
**바뀐 행 수(`count`)가 1일 때만** 다음 작업을 이어간다.

- DB는 같은 행에 대한 UPDATE를 한 번에 하나씩 처리하고, 이 UPDATE가 **트랜잭션이 끝날 때까지 행 잠금을 쥔다.**
- 그래서 먼저 도착한 UPDATE가 이기면, 뒤의 UPDATE는 기다렸다가 **조건을 다시 평가**해 이미 상태가 바뀐 것을 보고 0행이 된다.
- `count`가 0이면 "나는 이미 소유자가 아니다" → **아무것도 쓰지 않고 중단**한다.
- 소유권 확인용 UPDATE를 트랜잭션의 **맨 앞**에 두었다. 잠금을 쥔 채로 뒤의 쓰기를 하므로, 그 사이에 다른 슬롯이
  회수·재할당할 수 없다.

이를 **펜싱(fencing)** 이라고 부른다. leaseId가 "소유권이 바뀔 때마다 새로 발급되는 번호표"라서, 옛 번호표를 든
쓰기는 번호가 안 맞아 막힌다.

### 5.2 Judge Worker (`judge-worker.repository.ts`)

| 위치 | 수정 전 | 수정 후 |
|---|---|---|
| 신규 `ownedBy(job, statuses)` | 없음 | `{ id, leaseId, status in [...] }` 조건을 만드는 헬퍼. leaseId가 없으면 어떤 행과도 안 맞는 값을 쓴다 |
| `process()` 시작 | `update where id` → RUNNING | `updateMany where ownedBy(['CLAIMED'])`, `count !== 1`이면 **평가 호출 없이 중단** |
| `complete()` | 결과 저장 → 케이스 → 작업 COMPLETED (소유권 확인 없음) | **작업 COMPLETED 전환을 맨 앞에서 조건부로** 수행, 0행이면 `false` 반환(결과·케이스·요약을 건드리지 않음) |
| `fail()` | `findUniqueOrThrow(id)`로 현재 상태만 보고 재큐잉/FAILED | `findFirst where ownedBy`로 소유자일 때만 진행, 쓰기도 `updateMany where ownedBy`, 아니면 로그만 남기고 폐기 |
| `finalizeFailure()` | 케이스 → 작업을 `id`로 무조건 갱신 | 인자 `owner` 추가, **작업 전환을 먼저 조건부로**, 0행이면 `null` 반환. (claim의 시도 소진 경로는 `{id, status:'PENDING'}` 조건 사용) |
| `claim()` 만료 회수 | `updateMany where id in [스캔한 id]` | 조건에 `status in [CLAIMED,RUNNING]`, `leaseExpiresAt < now`를 **다시 확인** |

수정 후 `complete()`의 핵심 부분:

```ts
const applied = await this.prisma.$transaction(async (transaction) => {
  // 소유권 확인과 완료 전환을 UPDATE 한 문장으로. 이 UPDATE가 행 잠금을 잡고 있는 동안
  // 다른 슬롯의 회수·재할당은 대기하므로, 아래 쓰기는 소유자일 때만 실행된다.
  const owned = await transaction.judgeJob.updateMany({
    where: this.ownedBy(job, ['CLAIMED', 'RUNNING']),
    data: { status: 'COMPLETED', completedAt, leaseId: null, leaseExpiresAt: null, error: Prisma.DbNull },
  });
  if (owned.count !== 1) return false;   // lease를 잃음 → 결과를 버린다

  await transaction.evalResult.upsert(/* ... */);
  await transaction.evalRunCase.update(/* ... */);
  await this.refreshRunSummary(transaction, runCase.evalRunId, completedAt);
  return true;
});
```

`claim()` 만료 회수에서 같이 발견해 고친 틈(J-6): 스캔(`findMany`)으로 만료된 id를 읽은 뒤 갱신(`updateMany`) 사이에
소유자가 정상 완료하면, 갱신이 id 목록만 보고 **COMPLETED를 PENDING으로 되돌렸다.** 지금은 갱신 시점에 상태와
만료 조건을 다시 확인한다.

### 5.3 SDK 프로토콜 (`sdk-protocol.repository.ts`)

기존의 `requireLeasedJob` 사전 검사는 **그대로 두었다**(빠른 실패와 명확한 오류 메시지용). 뒤따르는 쓰기에 같은 조건을 다시 건
CAS 전환은 `a52c8fe`에서 먼저 이루어졌고, 이 수정은 그 위에서 **동시에 도착한 같은 요청의 처리**를 보완한다.

| 메서드 | `a52c8fe` (CAS 전환) | 이번 보완 |
|---|---|---|
| `startJob` | `updateMany where {id, leaseId, status:'CLAIMED'}`, 0행이면 409 | 0행일 때 같은 start가 먼저 처리됐는지(RUNNING + 같은 leaseId) 확인해 **멱등하게 같은 결과 반환**, 아니면 409 |
| `completeJob` | `updateMany where {id, leaseId, status:'RUNNING'}`, 0행이면 409 | 0행일 때 같은 멱등키로 이미 완료됐으면 **저장된 결과 반환**, 다른 작업이 쓴 키면 409. 유니크 제약 위반(P2002)도 409로 변환 |
| `failJob` | `updateMany where {id, leaseId, status: 읽은 시점의 job.status}`, 0행이면 409 | 변경 없음 |

보완 후 `completeJob`의 핵심 부분:

```ts
const claimed = await transaction.sdkJob.updateMany({
  where: { id: job.id, leaseId: input.leaseId, status: 'RUNNING' },   // a52c8fe
  data: { status: 'COMPLETED', idempotencyKey, output: {...}, completedAt, leaseId: null, leaseExpiresAt: null },
});
if (claimed.count !== 1) {
  // 동시에 도착한 같은 요청이 먼저 완료했다면 저장된 결과를 그대로 돌려준다(멱등).
  const replay = await transaction.sdkJob.findUnique({ where: { idempotencyKey }, select: {...} });
  if (replay) {
    if (replay.id !== job.id) throw new ConflictException('Idempotency-Key is already in use');
    return replay;
  }
  throw new ConflictException('Job lease is invalid or expired');
}
// 여기서부터(케이스 갱신, JudgeJob upsert)는 정확히 한 요청만 실행한다.
```

### 5.4 동작이 달라진 점 (호환성)

- **응답 형태는 그대로**다 (`{id, status, completedAt}` 등). 컨트롤러·SDK 수정은 없다.
- 소유권을 잃은 SDK 요청은 이전에 사전 검사를 통과하면 수락됐지만 이제 **409**(`Job lease is invalid or expired`)다.
- 소유권을 잃은 **Judge 슬롯의 결과는 예외 없이 조용히 폐기**되고 경고 로그만 남는다 (HTTP 경계가 없는 내부 경로라서).
- 정확히 동시에 도착한 같은 완료 요청: 한 요청만 완료를 실행하고 **나머지는 에러 없이 같은 결과를 돌려받는다.**
- 같은 `start` 요청의 동시 중복은 이전처럼 에러 없이 처리된다(멱등 유지). 동시에 온 같은 `fail` 요청의 두 번째는 409다
  (순차 중복은 원래도 409였다).

---

## 6. 수정 후 결과

### 6.1 시나리오별 전·후 (기본 반복 50)

| 시나리오 | 측정 항목 | 수정 전 | 수정 후 |
|---|---|---|---|
| 3-b 검사 직후 재할당, `complete` | 결과 | accepted, 최종 output `A-stale`, 새 lease 삭제 | **ConflictException**, 작업 CLAIMED·output 없음·새 lease 유지 |
| 3-c 〃 `start` | 결과 | accepted, 작업 RUNNING으로 덮임 | **ConflictException**, 작업 CLAIMED 유지 |
| 3-d 〃 `fail` | 결과 | accepted, 작업 FAILED·케이스 EXECUTION_FAILED | **ConflictException**, 작업 CLAIMED·케이스 WAITING_FOR_EXECUTION |
| 4-a 동일 완료 8개 동시 × 50라운드 | 라운드별 완료 쓰기 횟수 | `{"8": 50}` | **`{"1": 50}`** |
| 4-b 조회 통과 후 동시 쓰기 강제 | 쓰기(sdkJob / case / upsert) | 8 / 8 / 8 | **1 / 1 / 1** (JudgeJob 행 1개) |
| J-3 소유권 잃은 `complete()` | 작업 / 결과 행 / 케이스 | COMPLETED / stale 슬롯 것 / COMPLETED | **RUNNING 유지 / 없음 / JUDGING 유지** |
| J-4 성공 후 늦은 `fail()` | 작업 / 케이스 / Run | FAILED / JUDGE_FAILED / **FAILED** | **COMPLETED / COMPLETED / COMPLETED** |
| J-5 새 소유자 처리 중 늦은 `fail()` | 작업 / 새 lease | PENDING / 삭제됨 | **RUNNING / 유지** |
| J-6 만료 스캔 직후 정상 완료 | 재claim 여부 / attempt | **재claim됨** / 2 | **안 됨** / 1 |
| J-7 소유권 잃은 슬롯의 `process()` | 평가 API 호출 | 1회 | **0회** |

### 6.2 그대로 유지된 것 (회귀 없음)

| 항목 | 수정 전 | 수정 후 |
|---|---|---|
| 동시 claim 중복 선점 (작업 1개 × 8 동시, 50라운드) | 0건 | 0건 |
| 작업 20개 × 8워커 소진 | 중복 0 · 누락 0 | 중복 0 · 누락 0 |
| 첫 완료 이후 순차 재전송 5회의 쓰기 | 0회 | 0회 |
| 다른 작업의 멱등키 재사용 | 409 | 409 |
| lease 만료 후 재할당 / 시도 소진 | 정상 | 정상 |
| 기존 단위 테스트 | 통과 | 통과 |

claim 경쟁에서 진 횟수(`lostRaces`)는 수정 전후가 비슷하다(SDK 538 → 533, Judge 357 → 345; 실행마다 변동). 이 수정은
소유권 방어를 고친 것이지 claim 처리량을 바꾼 것이 아니다.

### 6.3 안정성

- 기본 설정 3회 반복 실행: 매번 23/23 통과 (flaky 없음)
- 스트레스(`IT_ITERATIONS=300`): 23/23 통과 — 동시 claim 2,400회(SDK)·2,400회(Judge) 중복 0건, 동일 완료 8개 동시 × 300라운드 쓰기 모두 정확히 1회
- 단위 테스트 12개 통과 (`a52c8fe`의 CAS 테스트 7개 + 멱등 보완 테스트 4개 + 기존 1개)
- 타입 검사(`tsc --noEmit`)·ESLint: 변경한 소스 파일에 오류 없음 (`project.service.ts`의 기존 린트 오류 1건은 이번 범위 밖)

---

## 7. 남은 한계와 후속 과제

- **lease 연장(heartbeat)이 없다.** 평가가 lease(기본 5분)보다 오래 걸리는 슬롯은 이제 새 소유자를 망치지는 않지만,
  그 슬롯이 한 **평가 작업 자체는 폐기**된다(같은 케이스를 다른 슬롯이 다시 평가). 중복 평가 비용을 줄이려면 평가 중
  `leaseExpiresAt`을 주기적으로 연장하는 heartbeat가 필요하다.
- 동시성은 **단일 Node 프로세스** 안의 병렬 호출로 검증했다. 다중 프로세스·다중 인스턴스 검증은 아니다.
- lease 만료는 DB 시각 조작으로 시뮬레이션했고, 실제 워커 프로세스를 `kill -9` 하는 실험은 하지 않았다.
- `executionMetadata`를 agent-engine으로 전달하는 배선(RAG/ToolCall 검증 활성화)은 이번 수정 범위가 아니다.
- claim 경쟁 비용(`lostRaces`)은 그대로다. 개선하려면 `FOR UPDATE SKIP LOCKED`나 claim 실패 시 다음 후보 재시도를 검토한다.

---

## 8. 재현 방법

```bash
docker compose up -d postgres
docker exec eval_platform_db psql -U postgres -c "CREATE DATABASE eval_platform_test"
cd apps/backend
DATABASE_URL='postgresql://postgres:postgres@localhost:5433/eval_platform_test?schema=public' \
  ./node_modules/.bin/prisma migrate deploy

pnpm test:integration                       # 수정 후 23/23
IT_ITERATIONS=300 pnpm test:integration     # 스트레스
```

**수정 전 상태 재현**: 수정한 소스 파일만 수정 전 커밋(`70851b4`)으로 되돌려 같은 테스트를 돌리면 10개가 실패한다.

```bash
git checkout 70851b4 -- apps/backend/src/eval apps/backend/src/sdk-protocol/sdk-protocol.repository.ts
cd apps/backend && pnpm test:integration    # 23개 중 10 실패
cd ../.. && git checkout HEAD -- apps/backend/src/eval apps/backend/src/sdk-protocol/sdk-protocol.repository.ts
```
