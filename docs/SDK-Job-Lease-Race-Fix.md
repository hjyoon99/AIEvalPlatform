# SDK Job Lease 재할당 레이스 컨디션 수정

`apps/backend/src/sdk-protocol/sdk-protocol.repository.ts`의 lease 기반 상태 전이(`startJob`/`completeJob`/`failJob`)에 있던 TOCTOU(time-of-check to time-of-use) 레이스 컨디션을 수정한 기록이다.

## 배경 — lease와 fencing token

이 시스템은 SDK Job을 워커에게 나눠줄 때 [lease](SDK-Execution-Protocol.md)를 사용한다. `claimJob`이 job을 선점시켜줄 때마다 `randomUUID()`로 새 `leaseId`를 발급하고(fencing token), 이후 `start`/`complete`/`fail` 요청은 이 `leaseId`가 DB에 저장된 현재 값과 정확히 일치해야만 처리된다(`requireLeasedJob`, [sdk-protocol.repository.ts:565-587](../apps/backend/src/sdk-protocol/sdk-protocol.repository.ts#L565-L587)). lease가 만료되면 다음 `claimJob` 호출의 만료 스윕이 job을 `PENDING`으로 되돌리고 `leaseId`를 지운 뒤, 다른 워커가 재선점하면서 완전히 새로운 `leaseId`를 발급한다.

## 문제 — 검증과 쓰기 사이의 레이스

`startJob`/`completeJob`/`failJob`은 공통적으로 다음 순서로 동작했다.

1. `requireLeasedJob`으로 `leaseId` 일치 여부와 만료 여부를 확인 (트랜잭션 **밖**에서 한 번 조회)
2. 확인이 끝난 뒤 `$transaction` 안에서 `sdkJob.update({ where: { id: job.id }, ... })`로 상태를 전이

문제는 2번의 `update`가 `id`로만 조건을 걸고, 1번에서 확인했던 `leaseId`나 `status`를 다시 검증하지 않는다는 점이었다. 즉 "확인했다"와 "썼다" 사이에 시간차가 있고, 그 사이 상태가 바뀌어도 쓰기는 그대로 통과했다.

### 재현 시나리오

1. Worker A가 `leaseId=X`로 job을 보유 중. `leaseExpiresAt`이 임박했지만 아직 지나지 않은 상태.
2. Worker A가 `completeJob(leaseId=X)`를 호출 → `requireLeasedJob`은 이 시점엔 아직 유효하므로 통과.
3. `$transaction`이 실행되는 짧은 틈에, 다른 워커의 `claimJob` 만료 스윕이 먼저 실행되어 이 job을 회수(`leaseId=null` → `PENDING`)하고 Worker B에게 재할당(`leaseId=Y`)한다.
4. Worker A의 `completeJob` 트랜잭션이 뒤늦게 커밋되며 `where: { id: job.id }`만으로 덮어쓴다.

결과:

- Worker B가 `RUNNING` 중이던 job이 Worker A의 stale 데이터(`status`, `output`)로 덮어써진다.
- 더 심각한 건, Worker A의 쓰기가 Worker B의 유효한 `leaseId=Y`를 `null`로 지워버려서, 이후 **정당한 소유자인 Worker B가 오히려 `Job lease is invalid or expired`로 거부당한다.**

`claimJob`의 재선점 로직은 이 문제가 없었다 — `updateMany({ where: { id, status: 'PENDING' } })` + `count` 체크로 조건부 쓰기(CAS)를 이미 쓰고 있었기 때문이다 ([sdk-protocol.repository.ts:322-336](../apps/backend/src/sdk-protocol/sdk-protocol.repository.ts#L322-L336)). `startJob`/`completeJob`/`failJob`만 이 패턴을 따르지 않고 있었다.

## 수정

세 메서드의 상태 전이 쓰기를 `update` → `updateMany`로 바꾸고, `where`절에 `leaseId`와 (읽었던 시점의) `status`를 조건으로 포함시켜 CAS로 만들었다. `count !== 1`이면 그 사이 상태가 바뀐 것이므로 `ConflictException`을 던진다.

```ts
// completeJob 예시
const claimed = await transaction.sdkJob.updateMany({
  where: { id: job.id, leaseId: input.leaseId, status: 'RUNNING' },
  data: { status: 'COMPLETED', leaseId: null, leaseExpiresAt: null, /* ... */ },
});
if (claimed.count !== 1) {
  throw new ConflictException('Job lease is invalid or expired');
}
const completed = await transaction.sdkJob.findUniqueOrThrow({
  where: { id: job.id },
  select: { id: true, status: true, completedAt: true },
});
```

`update`는 Prisma에서 unique 필드만 `where`에 허용하므로 `updateMany`로 전환했고, 갱신 후 필요한 필드는 `claimJob`과 동일하게 별도 `findUniqueOrThrow`로 재조회한다. `failJob`은 진입 시점에 `status`가 `CLAIMED` 또는 `RUNNING` 둘 다 허용되므로, 미리 정해둔 값이 아니라 `requireLeasedJob`이 읽어온 정확한 스냅샷 값(`job.status`)을 조건으로 사용했다.

CAS가 실패(`count === 0`)하면 트랜잭션이 예외로 롤백되면서 `evalRunCase`/`judgeJob` 갱신 등 하위 부수효과도 전혀 실행되지 않는다 — 검증에서 이 부분을 중점적으로 확인했다.

### 변경 파일

- `apps/backend/src/sdk-protocol/sdk-protocol.repository.ts` — `startJob`, `completeJob`, `failJob`을 CAS 패턴으로 수정
- `apps/backend/src/sdk-protocol/sdk-protocol.repository.spec.ts` — 회귀 테스트 신규 작성
- `apps/backend/package.json` — jest가 `prisma/*` 경로 별칭을 못 찾던 문제를 `moduleNameMapper`로 해결 (레포지토리 단위 테스트를 처음 추가하며 드러난 기존 테스트 인프라 공백)

## 테스트

`sdk-protocol.repository.spec.ts`에 Prisma를 목(mock)으로 대체한 단위 테스트를 추가해 다음을 검증했다.

- `startJob`/`completeJob`/`failJob` 각각에서 CAS 실패(`updateMany` count 0) 시 `ConflictException`을 던지고, `evalRunCase.update`/`judgeJob.upsert` 같은 하위 부수효과가 **전혀 호출되지 않음**을 확인 (레이스 시나리오의 핵심 방지 지점)
- 각 메서드의 `updateMany` 호출이 실제로 `leaseId`와 `status`를 `where`절 조건으로 포함하는지 확인
- CAS 성공 시 정상적으로 상태 전이와 하위 부수효과(evalRunCase 갱신, judgeJob 생성 등)가 수행되는지 확인
- DB에 저장된 `leaseId`와 다른 값으로 요청하면 (재할당이 이미 끝난 경우) 트랜잭션 진입 전 `requireLeasedJob` 단계에서부터 거부되는 기존 동작이 유지되는지 확인

```bash
cd apps/backend
npx jest src/sdk-protocol/sdk-protocol.repository.spec.ts
```

7개 테스트 모두 통과했고, 백엔드 전체 테스트 스위트(`npx jest`)와 `tsc --noEmit`, `eslint`도 함께 통과를 확인했다.

## 남은 과제

- lease 연장(heartbeat) 메커니즘이 없다는 점은 이번 수정과 별개의 기존 한계다. 자세한 내용은 [SDK-Execution-Protocol.md](SDK-Execution-Protocol.md)의 "heartbeat와 lease 연장" 항목 참고.
