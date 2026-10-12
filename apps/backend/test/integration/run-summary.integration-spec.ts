/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/no-unsafe-argument --
   private 메서드(claim/complete/fail)를 직접 호출하는 테스트라 any 접근이 의도적이다. */
import { EvalRunEvents } from '../../src/eval/eval-run.events';
import { JudgeWorkerRepository } from '../../src/eval/judge-worker.repository';
import { SdkProtocolRepository } from '../../src/sdk-protocol/sdk-protocol.repository';
import {
  asService,
  createBarrier,
  createPrisma,
  createSdkFixture,
  iterations,
  resetDatabase,
} from './helpers';

/**
 * 같은 EvalRun의 케이스가 동시에 종료될 때 실행 요약(completedCases/failedCases/status/completedAt)이
 * 케이스 상태와 일치하는지 검증한다. (이슈 #47)
 *
 * READ COMMITTED에서는 다른 트랜잭션의 미커밋 종결이 보이지 않아, 요약을 잠금 없이 계산하면
 * 각 트랜잭션이 "내 케이스만 종결"로 집계하고 마지막에 쓴 값이 남는다. 장벽으로 모든 트랜잭션이
 * "내 케이스 갱신"을 마친 뒤(커밋 전)에 요약을 계산하게 만들어 이 인터리빙을 결정적으로 재현한다.
 */
const prisma = createPrisma();

const TERMINAL_CASE_STATUSES = [
  'COMPLETED',
  'REVIEW_REQUIRED',
  'JUDGE_FAILED',
  'EXECUTION_FAILED',
];

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

/** 케이스를 종결 상태로 갱신한 트랜잭션이 `parties`개 모일 때까지 요약 계산을 미루는 클라이언트. */
function clientWithBarrier(parties: number) {
  const barrier = createBarrier(parties);
  return asService(
    (prisma as any).$extends({
      query: {
        evalRunCase: {
          async update({ args, query }: any) {
            const result = await query(args);
            if (TERMINAL_CASE_STATUSES.includes(String(args.data?.status))) {
              await barrier.arrive();
            }
            return result;
          },
        },
      },
    }),
  );
}

const judgeResult = (verdict: 'PASS' | 'RETRY') => ({
  prompt: 'q',
  output: 'a',
  score: 0.9,
  verdict,
  retryCount: 0,
  verification: { isValid: true },
  evaluation: { score: 0.9, metrics: {} },
  supervision: { verdict, reason: 'ok' },
});

/** 한 Run에 Judge 대기 케이스 `count`개를 만들고, 각 작업을 선점해 처리 중 상태로 만든다. */
async function createRunWithClaimedJudgeJobs(count: number) {
  const run = await prisma.evalRun.create({
    data: {
      name: 'run-summary',
      agentName: 'a',
      model: 'm',
      status: 'RUNNING',
      totalCases: count,
    },
  });
  for (let i = 0; i < count; i++) {
    const runCase = await prisma.evalRunCase.create({
      data: {
        evalRunId: run.id,
        caseIndex: i,
        evaluationMode: 'RUBRIC_ONLY',
        status: 'WAITING_FOR_JUDGE',
        input: { prompt: 'q' },
        outputAnswer: 'a',
      },
    });
    await prisma.judgeJob.create({
      data: { evalRunCaseId: runCase.id, maxAttempts: 3 },
    });
  }
  const claimer = new JudgeWorkerRepository(
    asService(prisma),
    new EvalRunEvents(),
  ) as any;
  const jobs: any[] = [];
  for (let i = 0; i < count; i++) {
    const job = await claimer.claim();
    await prisma.judgeJob.update({
      where: { id: job.id },
      data: { status: 'RUNNING' },
    });
    await prisma.evalRunCase.update({
      where: { id: job.evalRunCaseId },
      data: { status: 'JUDGING' },
    });
    jobs.push(job);
  }
  return { runId: run.id, jobs };
}

const loadCase = (id: string) =>
  prisma.evalRunCase.findUniqueOrThrow({
    where: { id },
    include: { evalRun: true },
  });

describe('동시에 종료된 케이스의 EvalRun 요약 (#47)', () => {
  it('R-1. Judge 케이스 4개가 동시에 완료돼도 Run이 completedCases=4, COMPLETED로 갱신된다', async () => {
    const { runId, jobs } = await createRunWithClaimedJudgeJobs(4);
    const repo = new JudgeWorkerRepository(
      clientWithBarrier(4),
      new EvalRunEvents(),
    ) as any;

    await Promise.all(
      jobs.map(async (job) =>
        repo.complete(
          job,
          await loadCase(job.evalRunCaseId),
          judgeResult('PASS'),
          10,
        ),
      ),
    );

    const run = await prisma.evalRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(
      await prisma.evalRunCase.count({
        where: { evalRunId: runId, status: 'COMPLETED' },
      }),
    ).toBe(4);
    expect(run.completedCases).toBe(4);
    expect(run.status).toBe('COMPLETED');
    expect(run.completedAt).not.toBeNull();
  });

  it('R-2. 완료·검토 필요·실패가 섞여 동시에 종료돼도 Run 집계와 상태가 케이스와 일치한다', async () => {
    const { runId, jobs } = await createRunWithClaimedJudgeJobs(4);
    const repo = new JudgeWorkerRepository(
      clientWithBarrier(4),
      new EvalRunEvents(),
    ) as any;

    await Promise.all(
      [
        jobs
          .slice(0, 2)
          .map(async (job) =>
            repo.complete(
              job,
              await loadCase(job.evalRunCaseId),
              judgeResult('PASS'),
              10,
            ),
          ),
        (async () =>
          repo.complete(
            jobs[2],
            await loadCase(jobs[2].evalRunCaseId),
            judgeResult('RETRY'),
            10,
          ))(),
        repo.fail(jobs[3], { code: 'X', message: 'boom', retryable: false }),
      ].flat(),
    );

    const run = await prisma.evalRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect({
      completed: run.completedCases,
      review: run.reviewCases,
      failed: run.failedCases,
      status: run.status,
    }).toEqual({
      completed: 2,
      review: 1,
      failed: 1,
      status: 'COMPLETED_WITH_ERRORS',
    });
    expect(run.completedAt).not.toBeNull();
  });

  it('R-4. 장벽 없이 자연스럽게 겹치는 동시 완료를 반복해도 교착 없이 요약이 항상 맞는다', async () => {
    const rounds = Math.max(5, Math.floor(iterations() / 5));
    const slots = 8;

    for (let round = 0; round < rounds; round++) {
      await resetDatabase(prisma);
      const { runId, jobs } = await createRunWithClaimedJudgeJobs(slots);
      const repo = new JudgeWorkerRepository(
        asService(prisma),
        new EvalRunEvents(),
      ) as any;
      const runCases = await Promise.all(
        jobs.map((job) => loadCase(job.evalRunCaseId)),
      );

      await Promise.all(
        jobs.map((job, index) =>
          repo.complete(job, runCases[index], judgeResult('PASS'), 10),
        ),
      );

      const run = await prisma.evalRun.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(run.completedCases).toBe(slots);
      expect(run.status).toBe('COMPLETED');
    }
  });

  it('R-3. SDK 경로에서 같은 Run의 실행 실패가 동시에 일어나도 failedCases=4, FAILED로 갱신된다', async () => {
    const sdk = new SdkProtocolRepository(asService(prisma));
    const { applicationId, sdkKey } = await createSdkFixture(prisma, sdk);
    const run = await prisma.evalRun.create({
      data: {
        name: 'sdk-run-summary',
        agentName: 'a',
        model: 'm',
        applicationId,
        executionMode: 'ADAPTER',
        status: 'RUNNING',
        totalCases: 4,
      },
    });
    for (let i = 0; i < 4; i++) {
      const runCase = await prisma.evalRunCase.create({
        data: {
          evalRunId: run.id,
          caseIndex: i,
          evaluationMode: 'RUBRIC_ONLY',
          input: { prompt: 'q' },
        },
      });
      await prisma.sdkJob.create({
        data: {
          applicationId,
          evalRunCaseId: runCase.id,
          testCase: { prompt: 'q' },
          maxAttempts: 1,
        },
      });
    }
    const claimed: NonNullable<Awaited<ReturnType<typeof sdk.claimJob>>>[] = [];
    for (let i = 0; i < 4; i++) {
      claimed.push((await sdk.claimJob(sdkKey))!);
    }

    const racing = new SdkProtocolRepository(clientWithBarrier(4));
    await Promise.all(
      claimed.map((job) =>
        racing.failJob(sdkKey, job.id, {
          leaseId: job.leaseId as string,
          error: { code: 'E', message: 'boom', retryable: false },
        }),
      ),
    );

    const after = await prisma.evalRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(after.failedCases).toBe(4);
    expect(after.status).toBe('FAILED');
    expect(after.completedAt).not.toBeNull();
  });
});
