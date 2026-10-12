import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

const DEFAULT_TEST_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5433/eval_platform_test?schema=public';

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

/** 테이블을 비우는 테스트이므로 `_test`로 끝나지 않는 DB에서는 실행을 거부한다. */
function assertSafeTestDatabase() {
  const name = new URL(testDatabaseUrl).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `통합 테스트는 이름이 _test로 끝나는 DB에서만 실행합니다. (현재: ${name})`,
    );
  }
}

/**
 * 동시 호출 수보다 큰 커넥션 풀을 가진 Prisma 클라이언트를 만든다.
 * 서비스의 PrismaService는 풀 크기가 기본값(10)이라 동시성 실험에는 쓰지 않는다.
 */
export function createPrisma(poolSize = 32) {
  assertSafeTestDatabase();
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: testDatabaseUrl,
      max: poolSize,
    }),
  });
}

/** 레포지토리가 요구하는 PrismaService 타입으로 클라이언트를 좁혀 준다. */
export const asService = (client: unknown) => client as PrismaService;

export async function resetDatabase(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Project","EvaluationPolicy","Scenario","AIApplication",' +
      '"SdkJob","EvalRun","EvalRunCase","EvalResult","JudgeJob" RESTART IDENTITY CASCADE',
  );
}

const ITERATIONS = Number(process.env.IT_ITERATIONS ?? 50);
export const iterations = (fallback = ITERATIONS) =>
  Number.isFinite(ITERATIONS) && ITERATIONS > 0 ? ITERATIONS : fallback;

/** `parties`개의 호출이 모두 도착해야 함께 통과시키는 장벽이다. 인터리빙을 강제할 때 쓴다. */
export function createBarrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async arrive() {
      arrived += 1;
      if (arrived >= parties) release();
      await gate;
    },
  };
}
export type Barrier = ReturnType<typeof createBarrier>;

/**
 * 쓰기 호출 횟수를 세고, 멱등키 조회 직후 장벽을 걸 수 있는 계측 클라이언트를 만든다.
 * 레포지토리 코드를 수정하지 않고 "같은 완료 처리가 몇 번 실행됐는가"를 관측하기 위한 용도다.
 */
export function instrument(
  base: PrismaClient,
  options: {
    barrier?: Barrier;
    /** 만료 lease 스캔(findMany) 직후 한 번만 실행해 스캔과 갱신 사이의 인터리빙을 만든다. */
    afterExpiredScan?: () => Promise<void>;
  } = {},
) {
  // 카운터는 "변경된 행 수"다. update는 1행, updateMany는 반환된 count만큼 센다.
  const counters = { sdkJobUpdate: 0, evalRunCaseUpdate: 0, judgeJobUpsert: 0 };
  let afterExpiredScan = options.afterExpiredScan;
  const client = base.$extends({
    query: {
      sdkJob: {
        async findUnique({ args, query }) {
          const result = await query(args);
          if (options.barrier && args.where && 'idempotencyKey' in args.where) {
            await options.barrier.arrive();
          }
          return result;
        },
        async update({ args, query }) {
          counters.sdkJobUpdate += 1;
          return query(args);
        },
        async updateMany({ args, query }) {
          const result = await query(args);
          counters.sdkJobUpdate += result.count;
          return result;
        },
      },
      evalRunCase: {
        async update({ args, query }) {
          counters.evalRunCaseUpdate += 1;
          return query(args);
        },
        async updateMany({ args, query }) {
          const result = await query(args);
          counters.evalRunCaseUpdate += result.count;
          return result;
        },
      },
      judgeJob: {
        async upsert({ args, query }) {
          counters.judgeJobUpsert += 1;
          return query(args);
        },
        async findMany({ args, query }) {
          const result = await query(args);
          if (
            afterExpiredScan &&
            args.where &&
            'leaseExpiresAt' in args.where &&
            result.length > 0
          ) {
            const hook = afterExpiredScan;
            afterExpiredScan = undefined;
            await hook();
          }
          return result;
        },
      },
    },
  });
  return { client: asService(client), counters };
}

export const snapshot = <T extends Record<string, number>>(counters: T): T => ({
  ...counters,
});

export const diff = <T extends Record<string, number>>(after: T, before: T) =>
  Object.fromEntries(
    Object.keys(after).map((key) => [key, after[key] - before[key]]),
  ) as T;

const records: Record<string, unknown>[] = [];

/** 시나리오별 측정값을 모아 두었다가 JSON 파일로 남긴다. */
export function record(entry: Record<string, unknown>) {
  records.push(entry);
}

export function flushResults(fileName: string) {
  const dir = join(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, fileName),
    JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2),
  );
}

export async function expireSdkLease(prisma: PrismaClient, jobId: string) {
  await prisma.sdkJob.update({
    where: { id: jobId },
    data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
  });
}

export async function expireJudgeLease(prisma: PrismaClient, jobId: string) {
  await prisma.judgeJob.update({
    where: { id: jobId },
    data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
  });
}

/** 프로젝트와 AI 애플리케이션을 만들고 SDK 키 원문을 돌려준다. */
export async function createSdkFixture(
  prisma: PrismaClient,
  repo: {
    createApplication: (
      projectId: string,
      input: { name: string },
    ) => Promise<{ application: { id: string }; sdkKey: string }>;
  },
) {
  const project = await prisma.project.create({
    data: { name: 'it-project', domain: 'integration-test' },
  });
  const { application, sdkKey } = await repo.createApplication(project.id, {
    name: 'it-app',
  });
  return { projectId: project.id, applicationId: application.id, sdkKey };
}

let caseSequence = 0;

/** EvalRun·EvalRunCase에 연결된 SdkJob을 만들어 완료 시 JudgeJob이 생성되는 경로를 재현한다. */
export async function createLinkedSdkJob(
  prisma: PrismaClient,
  applicationId: string,
  options: { timeoutMs?: number; maxAttempts?: number } = {},
) {
  caseSequence += 1;
  const run = await prisma.evalRun.create({
    data: {
      name: `it-run-${caseSequence}`,
      agentName: 'it-agent',
      model: 'it-model',
      applicationId,
      executionMode: 'ADAPTER',
      totalCases: 1,
    },
  });
  const runCase = await prisma.evalRunCase.create({
    data: {
      evalRunId: run.id,
      caseIndex: 0,
      evaluationMode: 'RUBRIC_ONLY',
      input: { prompt: 'q' },
    },
  });
  const job = await prisma.sdkJob.create({
    data: {
      applicationId,
      evalRunCaseId: runCase.id,
      testCase: { prompt: 'q' },
      timeoutMs: options.timeoutMs ?? 1_000,
      maxAttempts: options.maxAttempts ?? 3,
    },
  });
  return { evalRunId: run.id, evalRunCaseId: runCase.id, jobId: job.id };
}

/** 답변 수집이 끝나 Judge 대기 중인 케이스와 PENDING JudgeJob을 만든다. */
export async function createJudgeFixture(
  prisma: PrismaClient,
  options: { maxAttempts?: number } = {},
) {
  caseSequence += 1;
  const run = await prisma.evalRun.create({
    data: {
      name: `it-judge-run-${caseSequence}`,
      agentName: 'it-agent',
      model: 'it-model',
      status: 'RUNNING',
      totalCases: 1,
    },
  });
  const runCase = await prisma.evalRunCase.create({
    data: {
      evalRunId: run.id,
      caseIndex: 0,
      evaluationMode: 'RUBRIC_ONLY',
      status: 'WAITING_FOR_JUDGE',
      input: { prompt: 'q' },
      outputAnswer: 'a',
    },
  });
  const job = await prisma.judgeJob.create({
    data: {
      evalRunCaseId: runCase.id,
      maxAttempts: options.maxAttempts ?? 3,
    },
  });
  return { evalRunId: run.id, evalRunCaseId: runCase.id, jobId: job.id };
}
