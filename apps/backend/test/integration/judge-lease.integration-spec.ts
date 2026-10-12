/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
   private 메서드(claim/complete/fail/requireLeasedJob)를 직접 호출하고 가로채는 테스트라 any 접근이 의도적이다. */
import type { JudgeJob } from '@prisma/client';
import { EvalRunEvents } from '../../src/eval/eval-run.events';
import { JudgeWorkerRepository } from '../../src/eval/judge-worker.repository';
import {
  asService,
  createJudgeFixture,
  createPrisma,
  expireJudgeLease,
  flushResults,
  instrument,
  iterations,
  record,
  resetDatabase,
} from './helpers';

/**
 * 내부 Judge Worker의 claim/lease 동작을 실제 PostgreSQL에서 검증한다.
 * claim/complete/fail은 private이라 테스트에서만 `as any`로 직접 호출한다.
 */
const prisma = createPrisma();
const repo = new JudgeWorkerRepository(asService(prisma), new EvalRunEvents());
const internal = repo as any;

type JudgeJobRow = JudgeJob;

const judgeResult = (label: string) => ({
  prompt: 'q',
  output: 'a',
  score: 0.9,
  verdict: 'PASS' as const,
  retryCount: 0,
  verification: { isValid: true },
  evaluation: { score: 0.9, metrics: {} },
  supervision: { verdict: 'PASS', reason: label },
});

/** `process()`가 하는 RUNNING/JUDGING 전환만 재현한다. 외부 호출(Agent Engine)은 하지 않는다. */
async function markRunning(evalRunCaseId: string, jobId: string) {
  await prisma.judgeJob.update({
    where: { id: jobId },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  await prisma.evalRunCase.update({
    where: { id: evalRunCaseId },
    data: { status: 'JUDGING' },
  });
}

const loadCase = (evalRunCaseId: string) =>
  prisma.evalRunCase.findUniqueOrThrow({
    where: { id: evalRunCaseId },
    include: { evalRun: true },
  });

/** 슬롯 A가 claim한 뒤 느려져 lease가 만료되고, 슬롯 B가 회수해 재할당받은 상황을 만든다. */
async function slowSlotScenario() {
  const fx = await createJudgeFixture(prisma);
  const a: JudgeJobRow = await internal.claim();
  await markRunning(fx.evalRunCaseId, fx.jobId);
  await expireJudgeLease(prisma, fx.jobId);
  const b: JudgeJobRow = await internal.claim();
  await markRunning(fx.evalRunCaseId, fx.jobId);
  return { fx, a, b, runCase: await loadCase(fx.evalRunCaseId) };
}

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  flushResults('judge-lease.json');
  await prisma.$disconnect();
});

describe('Judge Worker 기본 동작 (양성 대조)', () => {
  it('J-0. 단일 슬롯이 claim → complete 하면 작업·케이스·결과·실행 요약이 일관되게 갱신된다', async () => {
    const fx = await createJudgeFixture(prisma);
    const job: JudgeJobRow = await internal.claim();
    await markRunning(fx.evalRunCaseId, fx.jobId);
    await internal.complete(
      job,
      await loadCase(fx.evalRunCaseId),
      judgeResult('ok'),
      10,
    );

    const row = await prisma.judgeJob.findUniqueOrThrow({
      where: { id: fx.jobId },
    });
    const runCase = await loadCase(fx.evalRunCaseId);
    const run = await prisma.evalRun.findUniqueOrThrow({
      where: { id: fx.evalRunId },
    });
    expect(row.status).toBe('COMPLETED');
    expect(row.leaseId).toBeNull();
    expect(runCase.status).toBe('COMPLETED');
    expect(await prisma.evalResult.count()).toBe(1);
    expect(run.status).toBe('COMPLETED');
  });
});

describe('시나리오 1. 여러 슬롯이 동시에 선점할 때 (Judge 경로)', () => {
  it('J-1a. 작업 1개를 8개 슬롯이 동시에 claim하면 매 라운드 정확히 1개 슬롯만 성공한다', async () => {
    const slots = 8;
    const rounds = iterations();
    let successfulClaims = 0;
    let duplicateClaims = 0;

    for (let round = 0; round < rounds; round++) {
      await resetDatabase(prisma);
      const fx = await createJudgeFixture(prisma);
      const results: (JudgeJobRow | null)[] = await Promise.all(
        Array.from({ length: slots }, () => internal.claim()),
      );
      const claimed = results.flatMap((item) => (item ? [item] : []));
      successfulClaims += claimed.length;
      duplicateClaims += Math.max(0, claimed.length - 1);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].id).toBe(fx.jobId);
      expect(claimed[0].attempt).toBe(1);
    }

    record({
      scenario: 'J-1a',
      description: '작업 1개 × 슬롯 8개 동시 claim',
      rounds,
      slots,
      claimAttempts: rounds * slots,
      successfulClaims,
      duplicateClaims,
    });
    expect(duplicateClaims).toBe(0);
  });

  it('J-1b. 작업 20개를 기본 동시성(4)으로 소진할 때 중복·누락은 없고, 경쟁에서 진 claim 횟수를 측정한다', async () => {
    const slots = 4;
    const jobsPerRound = 20;
    const rounds = Math.max(1, Math.floor(iterations() / 5));
    let totalClaims = 0;
    let duplicates = 0;
    let missing = 0;
    let lostRaces = 0;

    for (let round = 0; round < rounds; round++) {
      await resetDatabase(prisma);
      const fixtures: Awaited<ReturnType<typeof createJudgeFixture>>[] = [];
      for (let i = 0; i < jobsPerRound; i++) {
        fixtures.push(await createJudgeFixture(prisma));
      }
      const drain = async () => {
        const mine: JudgeJobRow[] = [];
        for (let guard = 0; guard < 10_000; guard++) {
          const job: JudgeJobRow | null = await internal.claim();
          if (job) {
            mine.push(job);
            continue;
          }
          const remaining = await prisma.judgeJob.count({
            where: { status: 'PENDING' },
          });
          if (remaining === 0) return mine;
          lostRaces += 1;
        }
        throw new Error('drain did not converge');
      };
      const claimed = (
        await Promise.all(Array.from({ length: slots }, drain))
      ).flat();
      const ids = new Set(claimed.map((job) => job.id));
      totalClaims += claimed.length;
      duplicates += claimed.length - ids.size;
      missing += fixtures.filter((fx) => !ids.has(fx.jobId)).length;
    }

    record({
      scenario: 'J-1b',
      description: '작업 20개 × 슬롯 4개가 큐를 비울 때까지 claim',
      rounds,
      slots,
      jobsPerRound,
      totalClaims,
      duplicates,
      missing,
      lostRaces,
    });
    expect(duplicates).toBe(0);
    expect(missing).toBe(0);
  });
});

describe('시나리오 2. lease 만료·재할당 (Judge 경로)', () => {
  it('J-2a. lease가 살아있으면 회수되지 않고, 만료되면 새 leaseId로 재할당되며 케이스는 대기 상태로 돌아간다', async () => {
    const fx = await createJudgeFixture(prisma);
    const a: JudgeJobRow = await internal.claim();
    await markRunning(fx.evalRunCaseId, fx.jobId);

    expect(await internal.claim()).toBeNull();

    await expireJudgeLease(prisma, fx.jobId);
    const b: JudgeJobRow = await internal.claim();

    expect(b.id).toBe(fx.jobId);
    expect(b.attempt).toBe(2);
    expect(b.leaseId).not.toBe(a.leaseId);
    expect((await loadCase(fx.evalRunCaseId)).status).toBe('WAITING_FOR_JUDGE');
  });

  it('J-2b. 시도 횟수를 소진하면 재할당하지 않고 JUDGE_FAILED로 확정한다', async () => {
    const fx = await createJudgeFixture(prisma, { maxAttempts: 2 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const job: JudgeJobRow = await internal.claim();
      expect(job.attempt).toBe(attempt);
      await expireJudgeLease(prisma, fx.jobId);
    }
    expect(await internal.claim()).toBeNull();

    const row = await prisma.judgeJob.findUniqueOrThrow({
      where: { id: fx.jobId },
    });
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatchObject({ code: 'MAX_ATTEMPTS_EXCEEDED' });
    expect((await loadCase(fx.evalRunCaseId)).status).toBe('JUDGE_FAILED');
  });
});

describe('시나리오 3. 소유권을 잃은(느린) 슬롯의 뒤늦은 쓰기 (Judge 경로)', () => {
  it('J-3. 소유권을 잃은 슬롯의 뒤늦은 complete()는 새 소유자의 작업·케이스·결과를 건드리면 안 된다', async () => {
    const { fx, a, b, runCase } = await slowSlotScenario();

    const outcome = await internal
      .complete(a, runCase, judgeResult('A-stale'), 100)
      .then(
        () => 'accepted',
        (error: Error) => error.constructor.name,
      );

    const job = await prisma.judgeJob.findUniqueOrThrow({
      where: { id: fx.jobId },
    });
    const result = await prisma.evalResult.findUnique({
      where: { evalRunCaseId: fx.evalRunCaseId },
    });
    const after = await loadCase(fx.evalRunCaseId);
    record({
      scenario: 'J-3',
      description: '소유권을 잃은 슬롯의 늦은 complete()',
      outcome,
      jobStatus: job.status,
      newHolderLeaseSurvived: job.leaseId === b.leaseId,
      evalResultFromStaleSlot: result?.reason ?? null,
      caseStatus: after.status,
    });

    expect(result).toBeNull();
    expect(job.status).toBe('RUNNING');
    expect(job.leaseId).toBe(b.leaseId);
    expect(after.status).toBe('JUDGING');
  });

  it('J-4. 성공 처리된 뒤 소유권을 잃은 슬롯의 뒤늦은 fail(재시도 불가)이 성공 결과를 덮어쓰면 안 된다', async () => {
    const { fx, a, b, runCase } = await slowSlotScenario();
    await internal.complete(b, runCase, judgeResult('B'), 100);

    await internal
      .fail(a, {
        code: 'AGENT_ENGINE_ERROR',
        message: 'late',
        retryable: false,
      })
      .catch(() => undefined);

    const job = await prisma.judgeJob.findUniqueOrThrow({
      where: { id: fx.jobId },
    });
    const result = await prisma.evalResult.findUnique({
      where: { evalRunCaseId: fx.evalRunCaseId },
    });
    const after = await loadCase(fx.evalRunCaseId);
    const run = await prisma.evalRun.findUniqueOrThrow({
      where: { id: fx.evalRunId },
    });
    record({
      scenario: 'J-4',
      description: '성공 이후 도착한 늦은 fail(retryable=false)',
      jobStatus: job.status,
      caseStatus: after.status,
      evalResultExists: result !== null,
      runStatus: run.status,
    });

    expect(job.status).toBe('COMPLETED');
    expect(after.status).toBe('COMPLETED');
    expect(run.status).toBe('COMPLETED');
  });

  it('J-5. 새 소유자가 처리 중일 때 도착한 이전 슬롯의 늦은 fail(재시도 가능)이 작업을 재큐잉하면 안 된다', async () => {
    const { fx, b } = await slowSlotScenario();
    const staleA = { ...b, leaseId: 'stale-lease', attempt: 1 };

    await internal
      .fail(staleA, {
        code: 'AGENT_ENGINE_ERROR',
        message: 'late',
        retryable: true,
      })
      .catch(() => undefined);

    const job = await prisma.judgeJob.findUniqueOrThrow({
      where: { id: fx.jobId },
    });
    const after = await loadCase(fx.evalRunCaseId);
    record({
      scenario: 'J-5',
      description: '새 소유자 처리 중 도착한 늦은 fail(retryable=true)',
      jobStatus: job.status,
      newHolderLeaseSurvived: job.leaseId === b.leaseId,
      caseStatus: after.status,
    });

    expect(job.status).toBe('RUNNING');
    expect(job.leaseId).toBe(b.leaseId);
    expect(after.status).toBe('JUDGING');
  });

  it('J-6. 만료 스캔과 갱신 사이에 정상 완료된 작업은 다시 PENDING으로 되돌려져 재평가되면 안 된다', async () => {
    const fx = await createJudgeFixture(prisma);
    const a: JudgeJobRow = await internal.claim();
    await markRunning(fx.evalRunCaseId, fx.jobId);
    // 소유자는 살아 있지만 lease만 만료된 느린 슬롯이다.
    await expireJudgeLease(prisma, fx.jobId);
    const runCase = await loadCase(fx.evalRunCaseId);

    // 다른 슬롯의 claim이 만료 스캔을 마친 직후, 원래 소유자가 정상 완료하도록 인터리빙을 강제한다.
    const { client } = instrument(prisma, {
      afterExpiredScan: async () => {
        await internal.complete(a, runCase, judgeResult('A'), 10);
      },
    });
    const other = new JudgeWorkerRepository(client, new EvalRunEvents());
    const reclaimed = await (other as any).claim();

    const job = await prisma.judgeJob.findUniqueOrThrow({
      where: { id: fx.jobId },
    });
    const after = await loadCase(fx.evalRunCaseId);
    record({
      scenario: 'J-6',
      description:
        '만료 스캔 직후 정상 완료된 작업을 다른 슬롯의 갱신이 되돌리는 인터리빙',
      reclaimedAfterCompletion: reclaimed !== null,
      jobStatus: job.status,
      jobAttempt: job.attempt,
      caseStatus: after.status,
      evalResults: await prisma.evalResult.count(),
    });

    expect(reclaimed).toBeNull();
    expect(job.status).toBe('COMPLETED');
    expect(job.attempt).toBe(1);
    expect(after.status).toBe('COMPLETED');
  });

  it('J-7. 소유권을 잃은 슬롯은 process() 시작 단계에서 중단되어 평가를 호출하지 않는다', async () => {
    const fx = await createJudgeFixture(prisma);
    const a: JudgeJobRow = await internal.claim();
    await expireJudgeLease(prisma, fx.jobId);
    const b: JudgeJobRow = await internal.claim();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('evaluate must not be called'));

    await internal.process(a);

    const job = await prisma.judgeJob.findUniqueOrThrow({
      where: { id: fx.jobId },
    });
    const after = await loadCase(fx.evalRunCaseId);
    record({
      scenario: 'J-7',
      description: '소유권을 잃은 슬롯의 process() 시작',
      evaluateCalls: fetchSpy.mock.calls.length,
      jobStatus: job.status,
      newHolderLeaseSurvived: job.leaseId === b.leaseId,
      caseStatus: after.status,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(job.status).toBe('CLAIMED');
    expect(job.leaseId).toBe(b.leaseId);
    expect(after.status).toBe('WAITING_FOR_JUDGE');
  });
});
