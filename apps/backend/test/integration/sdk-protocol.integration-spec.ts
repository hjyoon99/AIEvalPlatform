/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
   private 메서드(claim/complete/fail/requireLeasedJob)를 직접 호출하고 가로채는 테스트라 any 접근이 의도적이다. */
import { ConflictException } from '@nestjs/common';
import { SdkProtocolRepository } from '../../src/sdk-protocol/sdk-protocol.repository';
import {
  asService,
  createBarrier,
  createLinkedSdkJob,
  createPrisma,
  createSdkFixture,
  diff,
  expireSdkLease,
  flushResults,
  instrument,
  iterations,
  record,
  resetDatabase,
  snapshot,
} from './helpers';

/**
 * SDK Job claim/lease/멱등 완료 프로토콜을 실제 PostgreSQL에서 검증한다.
 * mock으로는 행 잠금과 조건부 UPDATE의 동작을 증명할 수 없어 DB를 직접 사용한다.
 */
const prisma = createPrisma();
const repo = new SdkProtocolRepository(asService(prisma));

let fixture: Awaited<ReturnType<typeof createSdkFixture>>;

const leaseOf = (job: { leaseId: string | null } | null) =>
  (job as { leaseId: string }).leaseId;

const enqueue = (count: number, options: { maxAttempts?: number } = {}) =>
  Promise.all(
    Array.from({ length: count }, () =>
      repo.createJob(fixture.applicationId, {
        testCase: { prompt: 'q' },
        ...options,
      }),
    ),
  );

/** 큐가 빌 때까지 claim을 반복한다. 경쟁에서 져서 null을 받은 횟수도 센다. */
async function drain(stats: { lostRaces: number }) {
  const mine: NonNullable<Awaited<ReturnType<typeof repo.claimJob>>>[] = [];
  for (let guard = 0; guard < 10_000; guard++) {
    const job = await repo.claimJob(fixture.sdkKey);
    if (job) {
      mine.push(job);
      continue;
    }
    const remaining = await prisma.sdkJob.count({
      where: { status: 'PENDING' },
    });
    if (remaining === 0) return mine;
    stats.lostRaces += 1;
  }
  throw new Error('drain did not converge');
}

beforeEach(async () => {
  await resetDatabase(prisma);
  fixture = await createSdkFixture(prisma, repo);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  flushResults('sdk-protocol.json');
  await prisma.$disconnect();
});

describe('시나리오 1. 여러 워커가 동시에 선점할 때', () => {
  it('1-a. 작업 1개를 8개 워커가 동시에 claim하면 매 라운드 정확히 1명만 성공한다', async () => {
    const workers = 8;
    const rounds = iterations();
    let successfulClaims = 0;
    let duplicateClaims = 0;

    for (let round = 0; round < rounds; round++) {
      const [job] = await enqueue(1);
      const results = await Promise.all(
        Array.from({ length: workers }, () => repo.claimJob(fixture.sdkKey)),
      );
      const claimed = results.flatMap((item) => (item ? [item] : []));

      successfulClaims += claimed.length;
      duplicateClaims += Math.max(0, claimed.length - 1);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].id).toBe(job.id);

      const row = await prisma.sdkJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(row.status).toBe('CLAIMED');
      expect(row.attempt).toBe(1);
      expect(row.leaseId).toBe(claimed[0].leaseId);
    }

    record({
      scenario: '1-a',
      description: '작업 1개 × 워커 8개 동시 claim',
      rounds,
      workers,
      claimAttempts: rounds * workers,
      successfulClaims,
      duplicateClaims,
    });
    expect(duplicateClaims).toBe(0);
  });

  it('1-b. 작업 20개를 8개 워커가 나눠 가져가면 중복과 누락이 없다', async () => {
    const workers = 8;
    const jobsPerRound = 20;
    const rounds = Math.max(1, Math.floor(iterations() / 5));
    let totalClaims = 0;
    let duplicates = 0;
    let missing = 0;
    const stats = { lostRaces: 0 };

    for (let round = 0; round < rounds; round++) {
      const created = await enqueue(jobsPerRound);
      const perWorker = await Promise.all(
        Array.from({ length: workers }, () => drain(stats)),
      );
      const claimed = perWorker.flat();
      const ids = new Set(claimed.map((job) => job.id));
      const leases = new Set(claimed.map((job) => job.leaseId));

      totalClaims += claimed.length;
      duplicates += claimed.length - ids.size;
      missing += created.filter((job) => !ids.has(job.id)).length;
      expect(leases.size).toBe(claimed.length);
      expect(claimed.every((job) => job.attempt === 1)).toBe(true);
    }

    record({
      scenario: '1-b',
      description: '작업 20개 × 워커 8개가 큐를 비울 때까지 claim',
      rounds,
      workers,
      jobsPerRound,
      totalClaims,
      duplicates,
      missing,
      lostRaces: stats.lostRaces,
    });
    expect(duplicates).toBe(0);
    expect(missing).toBe(0);
  });
});

describe('시나리오 2. 워커 종료 후 lease 만료·재할당', () => {
  it('2-a. lease가 살아있는 동안은 회수되지 않고, 만료되면 새 leaseId로 재할당된다', async () => {
    const [job] = await enqueue(1);
    const a = await repo.claimJob(fixture.sdkKey);
    expect(a?.id).toBe(job.id);

    // 음성 대조: 아직 lease가 유효하면 다른 워커는 가져가지 못한다.
    expect(await repo.claimJob(fixture.sdkKey)).toBeNull();

    await expireSdkLease(prisma, job.id);
    const b = await repo.claimJob(fixture.sdkKey);

    expect(b?.id).toBe(job.id);
    expect(b?.attempt).toBe(2);
    expect(leaseOf(b)).not.toBe(leaseOf(a));
    const row = await prisma.sdkJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(row.status).toBe('CLAIMED');
    expect(row.leaseId).toBe(leaseOf(b));

    record({
      scenario: '2-a',
      description: 'lease 만료 후 재할당',
      reclaimedBeforeExpiry: false,
      reclaimedAfterExpiry: true,
      attemptAfterReclaim: b?.attempt,
      leaseIdChanged: leaseOf(a) !== leaseOf(b),
    });
  });

  it('2-b. 실행 중이던 케이스는 회수 시 실행 전 상태로 되돌아간다', async () => {
    const linked = await createLinkedSdkJob(prisma, fixture.applicationId);
    const a = await repo.claimJob(fixture.sdkKey);
    await repo.startJob(fixture.sdkKey, linked.jobId, { leaseId: leaseOf(a) });
    const running = await prisma.evalRunCase.findUniqueOrThrow({
      where: { id: linked.evalRunCaseId },
    });
    expect(running.status).toBe('EXECUTING');

    await expireSdkLease(prisma, linked.jobId);
    await repo.claimJob(fixture.sdkKey);

    const reset = await prisma.evalRunCase.findUniqueOrThrow({
      where: { id: linked.evalRunCaseId },
    });
    expect(reset.status).toBe('WAITING_FOR_EXECUTION');
    expect(reset.executionStartedAt).toBeNull();
  });

  it('2-c. 시도 횟수를 소진하면 재할당하지 않고 실패로 확정한다', async () => {
    const linked = await createLinkedSdkJob(prisma, fixture.applicationId, {
      maxAttempts: 2,
    });

    for (let attempt = 1; attempt <= 2; attempt++) {
      const claimed = await repo.claimJob(fixture.sdkKey);
      expect(claimed?.attempt).toBe(attempt);
      await expireSdkLease(prisma, linked.jobId);
    }
    expect(await repo.claimJob(fixture.sdkKey)).toBeNull();

    const row = await prisma.sdkJob.findUniqueOrThrow({
      where: { id: linked.jobId },
    });
    const runCase = await prisma.evalRunCase.findUniqueOrThrow({
      where: { id: linked.evalRunCaseId },
    });
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatchObject({ code: 'MAX_ATTEMPTS_EXCEEDED' });
    expect(runCase.status).toBe('EXECUTION_FAILED');
  });
});

/** requireLeasedJob이 "유효"를 돌려준 직후 다른 워커가 lease를 회수·재claim하도록 인터리빙을 강제한다. */
function reclaimRightAfterLeaseCheck(jobId: string) {
  const original = (repo as any).requireLeasedJob.bind(repo);
  jest
    .spyOn(repo as any, 'requireLeasedJob')
    .mockImplementationOnce(async (...args: unknown[]) => {
      const job = await original(...args);
      await expireSdkLease(prisma, jobId);
      await repo.claimJob(fixture.sdkKey);
      return job;
    });
}

describe('시나리오 3. 이전 lease를 가진 워커의 뒤늦은 완료 요청', () => {
  async function reclaimedByB() {
    const linked = await createLinkedSdkJob(prisma, fixture.applicationId);
    const a = await repo.claimJob(fixture.sdkKey);
    await repo.startJob(fixture.sdkKey, linked.jobId, { leaseId: leaseOf(a) });
    await expireSdkLease(prisma, linked.jobId);
    const b = await repo.claimJob(fixture.sdkKey);
    await repo.startJob(fixture.sdkKey, linked.jobId, { leaseId: leaseOf(b) });
    return { linked, a, b };
  }

  it('3-a. lease가 회수·재할당된 뒤 도착한 이전 워커의 완료 요청은 409로 거부된다', async () => {
    const { linked, a, b } = await reclaimedByB();
    const staleKey = `${linked.jobId}-attempt-1`;

    await expect(
      repo.completeJob(fixture.sdkKey, linked.jobId, staleKey, {
        leaseId: leaseOf(a),
        output: 'A-late',
      }),
    ).rejects.toThrow('Job lease is invalid or expired');

    const untouched = await prisma.sdkJob.findUniqueOrThrow({
      where: { id: linked.jobId },
    });
    expect(untouched.status).toBe('RUNNING');
    expect(untouched.leaseId).toBe(leaseOf(b));
    expect(untouched.output).toBeNull();

    const completed = await repo.completeJob(
      fixture.sdkKey,
      linked.jobId,
      `${linked.jobId}-attempt-2`,
      { leaseId: leaseOf(b), output: 'B' },
    );
    expect(completed.status).toBe('COMPLETED');
    const row = await prisma.sdkJob.findUniqueOrThrow({
      where: { id: linked.jobId },
    });
    expect(row.output).toMatchObject({ text: 'B' });

    // B가 끝난 뒤에 A가 다시 시도해도 거부된다.
    await expect(
      repo.completeJob(fixture.sdkKey, linked.jobId, staleKey, {
        leaseId: leaseOf(a),
        output: 'A-late-again',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    record({
      scenario: '3-a',
      description: '회수 후 도착한 이전 lease의 완료 요청',
      staleRequestRejected: true,
      finalOutputFromNewHolder: true,
    });
  });

  it('3-b. 검사 직후 lease가 회수·재할당돼도 이전 워커의 완료 요청은 거부되어야 한다 (check-then-act)', async () => {
    const linked = await createLinkedSdkJob(prisma, fixture.applicationId);
    const a = await repo.claimJob(fixture.sdkKey);
    await repo.startJob(fixture.sdkKey, linked.jobId, { leaseId: leaseOf(a) });

    reclaimRightAfterLeaseCheck(linked.jobId);

    const outcome = await repo
      .completeJob(fixture.sdkKey, linked.jobId, `${linked.jobId}-attempt-1`, {
        leaseId: leaseOf(a),
        output: 'A-stale',
      })
      .then(
        () => 'accepted',
        (error: Error) => error.constructor.name,
      );

    const row = await prisma.sdkJob.findUniqueOrThrow({
      where: { id: linked.jobId },
    });
    record({
      scenario: '3-b',
      description: '검사와 쓰기 사이에 lease가 회수·재할당되는 인터리빙',
      outcome,
      finalStatus: row.status,
      finalOutput: row.output,
      newHolderLeaseSurvived: row.leaseId !== null,
    });
    expect(outcome).toBe('ConflictException');
    expect(row.status).not.toBe('COMPLETED');
    expect(row.output).toBeNull();
    expect(row.leaseId).not.toBeNull();
  });

  it('3-c. 검사 직후 lease가 회수·재할당돼도 이전 워커의 start 요청은 거부되어야 한다', async () => {
    const linked = await createLinkedSdkJob(prisma, fixture.applicationId);
    const a = await repo.claimJob(fixture.sdkKey);
    reclaimRightAfterLeaseCheck(linked.jobId);

    const outcome = await repo
      .startJob(fixture.sdkKey, linked.jobId, { leaseId: leaseOf(a) })
      .then(
        () => 'accepted',
        (error: Error) => error.constructor.name,
      );

    const row = await prisma.sdkJob.findUniqueOrThrow({
      where: { id: linked.jobId },
    });
    record({
      scenario: '3-c',
      description:
        '검사와 쓰기 사이에 lease가 회수·재할당되는 인터리빙 (start)',
      outcome,
      finalStatus: row.status,
      attempt: row.attempt,
    });
    expect(outcome).toBe('ConflictException');
    expect(row.status).toBe('CLAIMED');
    expect(row.attempt).toBe(2);
  });

  it('3-d. 검사 직후 lease가 회수·재할당돼도 이전 워커의 fail 요청은 새 소유자의 작업을 바꾸지 못한다', async () => {
    const linked = await createLinkedSdkJob(prisma, fixture.applicationId);
    const a = await repo.claimJob(fixture.sdkKey);
    await repo.startJob(fixture.sdkKey, linked.jobId, { leaseId: leaseOf(a) });
    reclaimRightAfterLeaseCheck(linked.jobId);

    const outcome = await repo
      .failJob(fixture.sdkKey, linked.jobId, {
        leaseId: leaseOf(a),
        error: { code: 'LATE', message: 'late', retryable: false },
      })
      .then(
        () => 'accepted',
        (error: Error) => error.constructor.name,
      );

    const row = await prisma.sdkJob.findUniqueOrThrow({
      where: { id: linked.jobId },
    });
    const runCase = await prisma.evalRunCase.findUniqueOrThrow({
      where: { id: linked.evalRunCaseId },
    });
    record({
      scenario: '3-d',
      description: '검사와 쓰기 사이에 lease가 회수·재할당되는 인터리빙 (fail)',
      outcome,
      finalStatus: row.status,
      newHolderLeaseSurvived: row.leaseId !== null,
      caseStatus: runCase.status,
    });
    expect(outcome).toBe('ConflictException');
    expect(row.status).toBe('CLAIMED');
    expect(row.attempt).toBe(2);
    expect(row.leaseId).not.toBeNull();
    expect(runCase.status).toBe('WAITING_FOR_EXECUTION');
  });
});

describe('시나리오 4. 동일 완료 요청이 동시에 들어왔을 때', () => {
  async function startedJob(client = repo) {
    const linked = await createLinkedSdkJob(prisma, fixture.applicationId);
    const claimed = await client.claimJob(fixture.sdkKey);
    await client.startJob(fixture.sdkKey, linked.jobId, {
      leaseId: leaseOf(claimed),
    });
    return { linked, leaseId: leaseOf(claimed) };
  }

  it('4-a. 같은 키의 완료 요청 8개가 동시에 도착해도 최종 상태는 단일 결과로 수렴한다', async () => {
    const parallel = 8;
    const rounds = iterations();
    const { client, counters } = instrument(prisma);
    const instrumented = new SdkProtocolRepository(client);
    const writesHistogram: Record<string, number> = {};
    const rejections: Record<string, number> = {};
    let fulfilled = 0;

    for (let round = 0; round < rounds; round++) {
      const { linked, leaseId } = await startedJob(instrumented);
      const before = snapshot(counters);
      const key = `${linked.jobId}-attempt-1`;

      const settled = await Promise.allSettled(
        Array.from({ length: parallel }, () =>
          instrumented.completeJob(fixture.sdkKey, linked.jobId, key, {
            leaseId,
            output: 'same-output',
          }),
        ),
      );
      const delta = diff(snapshot(counters), before);

      for (const item of settled) {
        if (item.status === 'fulfilled') fulfilled += 1;
        else {
          const name = (item.reason as Error).constructor.name;
          rejections[name] = (rejections[name] ?? 0) + 1;
        }
      }
      writesHistogram[delta.sdkJobUpdate] =
        (writesHistogram[delta.sdkJobUpdate] ?? 0) + 1;

      const judgeJobs = await prisma.judgeJob.count({
        where: { evalRunCaseId: linked.evalRunCaseId },
      });
      const row = await prisma.sdkJob.findUniqueOrThrow({
        where: { id: linked.jobId },
      });
      expect(judgeJobs).toBe(1);
      expect(row.status).toBe('COMPLETED');
      expect(row.output).toMatchObject({ text: 'same-output' });
    }

    record({
      scenario: '4-a',
      description: '동일 키 완료 요청 8개 동시 (자연 경쟁)',
      rounds,
      parallel,
      fulfilled,
      rejections,
      sdkJobUpdateExecutionsPerRound: writesHistogram,
    });
    expect(rejections).toEqual({});
    expect(writesHistogram).toEqual({ '1': rounds });
  });

  it('4-b. 모든 요청이 멱등키 조회를 통과한 최악의 인터리빙에서도 완료 처리는 한 번만 실행되어야 한다', async () => {
    const parallel = 8;
    const { client, counters } = instrument(prisma, {
      barrier: createBarrier(parallel),
    });
    const instrumented = new SdkProtocolRepository(client);
    // 장벽은 completeJob의 멱등키 조회에만 걸리므로 claim/start는 일반 레포지토리로 수행한다.
    const { linked, leaseId } = await startedJob();
    const before = snapshot(counters);
    const key = `${linked.jobId}-attempt-1`;

    const settled = await Promise.allSettled(
      Array.from({ length: parallel }, () =>
        instrumented.completeJob(fixture.sdkKey, linked.jobId, key, {
          leaseId,
          output: 'same-output',
        }),
      ),
    );
    const delta = diff(snapshot(counters), before);
    const judgeJobs = await prisma.judgeJob.count({
      where: { evalRunCaseId: linked.evalRunCaseId },
    });
    const rejected = settled.filter((item) => item.status === 'rejected');

    record({
      scenario: '4-b',
      description:
        '동일 키 완료 요청 8개, 조회 통과 후 동시에 쓰기 (인터리빙 강제)',
      parallel,
      fulfilled: settled.length - rejected.length,
      rejected: rejected.map((item) => (item.reason as Error).constructor.name),
      sdkJobUpdateExecutions: delta.sdkJobUpdate,
      evalRunCaseUpdateExecutions: delta.evalRunCaseUpdate,
      judgeJobUpsertExecutions: delta.judgeJobUpsert,
      judgeJobRows: judgeJobs,
    });

    expect(rejected).toHaveLength(0);
    expect(judgeJobs).toBe(1);
    expect(delta.sdkJobUpdate).toBe(1);
    expect(delta.evalRunCaseUpdate).toBe(1);
    expect(delta.judgeJobUpsert).toBe(1);
    expect(
      settled.every(
        (item) => item.status === 'fulfilled' && item.value.id === linked.jobId,
      ),
    ).toBe(true);
  });

  it('4-c. 다른 작업이 이미 사용한 멱등키를 재사용하면 409로 거부된다', async () => {
    const first = await createLinkedSdkJob(prisma, fixture.applicationId);
    const second = await createLinkedSdkJob(prisma, fixture.applicationId);
    const firstClaim = await repo.claimJob(fixture.sdkKey);
    await repo.startJob(fixture.sdkKey, first.jobId, {
      leaseId: leaseOf(firstClaim),
    });
    const sharedKey = 'shared-key';
    await repo.completeJob(fixture.sdkKey, first.jobId, sharedKey, {
      leaseId: leaseOf(firstClaim),
      output: 'first',
    });

    const secondClaim = await repo.claimJob(fixture.sdkKey);
    expect(secondClaim?.id).toBe(second.jobId);
    await repo.startJob(fixture.sdkKey, second.jobId, {
      leaseId: leaseOf(secondClaim),
    });

    await expect(
      repo.completeJob(fixture.sdkKey, second.jobId, sharedKey, {
        leaseId: leaseOf(secondClaim),
        output: 'second',
      }),
    ).rejects.toThrow('Idempotency-Key is already in use');
  });

  it('4-d. 첫 완료가 끝난 뒤 도착한 재전송은 저장된 결과를 돌려주고 쓰기를 다시 실행하지 않는다', async () => {
    const { client, counters } = instrument(prisma);
    const instrumented = new SdkProtocolRepository(client);
    const { linked, leaseId } = await startedJob(instrumented);
    const key = `${linked.jobId}-attempt-1`;
    const input = { leaseId, output: 'same-output' };

    const first = await instrumented.completeJob(
      fixture.sdkKey,
      linked.jobId,
      key,
      input,
    );
    const before = snapshot(counters);
    const replays: Awaited<ReturnType<typeof instrumented.completeJob>>[] = [];
    for (let i = 0; i < 5; i++) {
      replays.push(
        await instrumented.completeJob(
          fixture.sdkKey,
          linked.jobId,
          key,
          input,
        ),
      );
    }
    const delta = diff(snapshot(counters), before);
    const judgeJobs = await prisma.judgeJob.count({
      where: { evalRunCaseId: linked.evalRunCaseId },
    });

    record({
      scenario: '4-d',
      description: '첫 완료 이후 순차 재전송 5회',
      replays: replays.length,
      sdkJobUpdateExecutions: delta.sdkJobUpdate,
      evalRunCaseUpdateExecutions: delta.evalRunCaseUpdate,
      judgeJobUpsertExecutions: delta.judgeJobUpsert,
      judgeJobRows: judgeJobs,
    });
    expect(replays.every((item) => item.id === first.id)).toBe(true);
    expect(replays.every((item) => item.status === 'COMPLETED')).toBe(true);
    expect(delta).toEqual({
      sdkJobUpdate: 0,
      evalRunCaseUpdate: 0,
      judgeJobUpsert: 0,
    });
    expect(judgeJobs).toBe(1);
  });
});

describe('시나리오 4 (start). 같은 start 요청이 동시에 들어왔을 때', () => {
  it('4-e. 모든 요청이 lease 사전 검사를 통과한 뒤 동시에 쓰기를 해도 에러 없이 같은 결과를 받고 시작 처리는 한 번만 실행된다', async () => {
    const parallel = 8;
    const rounds = Math.max(1, Math.floor(iterations() / 5));
    const { client, counters } = instrument(prisma);
    const instrumented = new SdkProtocolRepository(client);
    const original = (instrumented as any).requireLeasedJob.bind(instrumented);
    const leaseCheck = jest.spyOn(instrumented as any, 'requireLeasedJob');
    const writesHistogram: Record<string, number> = {};
    const caseWritesHistogram: Record<string, number> = {};
    const rejections: Record<string, number> = {};
    let fulfilled = 0;

    for (let round = 0; round < rounds; round++) {
      const linked = await createLinkedSdkJob(prisma, fixture.applicationId);
      const claimed = await repo.claimJob(fixture.sdkKey);
      // 8개 요청이 모두 CLAIMED 상태로 사전 검사를 통과한 뒤에 쓰기 경쟁을 하도록 강제한다.
      const barrier = createBarrier(parallel);
      leaseCheck.mockImplementation(async (...args: unknown[]) => {
        const job = await original(...args);
        await barrier.arrive();
        return job;
      });
      const before = snapshot(counters);

      const settled = await Promise.allSettled(
        Array.from({ length: parallel }, () =>
          instrumented.startJob(fixture.sdkKey, linked.jobId, {
            leaseId: leaseOf(claimed),
          }),
        ),
      );
      const delta = diff(snapshot(counters), before);

      for (const item of settled) {
        if (item.status === 'fulfilled') {
          fulfilled += 1;
          expect(item.value.status).toBe('RUNNING');
        } else {
          const name = (item.reason as Error).constructor.name;
          rejections[name] = (rejections[name] ?? 0) + 1;
        }
      }
      writesHistogram[delta.sdkJobUpdate] =
        (writesHistogram[delta.sdkJobUpdate] ?? 0) + 1;
      caseWritesHistogram[delta.evalRunCaseUpdate] =
        (caseWritesHistogram[delta.evalRunCaseUpdate] ?? 0) + 1;

      const row = await prisma.sdkJob.findUniqueOrThrow({
        where: { id: linked.jobId },
      });
      const runCase = await prisma.evalRunCase.findUniqueOrThrow({
        where: { id: linked.evalRunCaseId },
      });
      expect(row.status).toBe('RUNNING');
      expect(row.attempt).toBe(1);
      expect(row.leaseId).toBe(leaseOf(claimed));
      expect(runCase.status).toBe('EXECUTING');
    }

    record({
      scenario: '4-e',
      description:
        '같은 start 요청 8개 동시 (사전 검사 통과 후 쓰기 경쟁 강제)',
      rounds,
      parallel,
      fulfilled,
      rejections,
      sdkJobUpdateExecutionsPerRound: writesHistogram,
      evalRunCaseUpdateExecutionsPerRound: caseWritesHistogram,
    });
    expect(rejections).toEqual({});
    expect(writesHistogram).toEqual({ '1': rounds });
    expect(caseWritesHistogram).toEqual({ '1': rounds });
  });
});
