import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type JudgeJob, type JudgeJobStatus } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { EvalRunEvents } from './eval-run.events';

/** Agent Engine이 반환하는 단일 케이스의 검증·채점·감독 결과다. */
interface AgentEngineResult {
  prompt: string;
  output: string;
  expectedOutput?: string;
  score: number;
  verdict: 'PASS' | 'FAIL' | 'RETRY';
  retryCount?: number;
  verification?: Record<string, unknown>;
  evaluation?: Record<string, unknown>;
  supervision?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}

/** Judge 요청에 대한 Agent Engine 응답 구조다. */
interface AgentEngineResponse {
  runId: string;
  results: AgentEngineResult[];
}

/** 재시도 가능 여부를 포함한 Judge 작업의 표준 오류 구조다. */
interface JudgeExecutionError {
  code: string;
  message: string;
  retryable: boolean;
}

/** throw 가능하도록 Error를 상속한 JudgeExecutionError 구현체다. */
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

@Injectable()
export class JudgeWorkerRepository {
  private readonly logger = new Logger(JudgeWorkerRepository.name);
  private readonly agentEngineUrl =
    process.env.AGENT_ENGINE_URL ?? 'http://127.0.0.1:8000';
  private readonly pollIntervalMs = this.readPositiveInteger(
    process.env.JUDGE_WORKER_POLL_INTERVAL_MS,
    1_000,
  );
  private readonly leaseDurationMs = this.readPositiveInteger(
    process.env.JUDGE_JOB_LEASE_MS,
    300_000,
  );
  private readonly enabled =
    process.env.JUDGE_WORKER_ENABLED?.toLowerCase() !== 'false';
  /**
   * 동시에 처리할 Judge 작업 슬롯 개수. `claim()`이 이미 `status: 'PENDING'`
   * 조건부 `updateMany`로 원자적 선점을 하기 때문에 슬롯을 늘리는 것만으로
   * 안전하게 동시성을 얻는다. 다만 슬롯 하나당 Agent Engine 호출 1건이
   * 동시에 나가고, 그 안에서 Ollama가 여러 번 순차 호출되므로 과도하게
   * 늘리면 로컬 Ollama가 감당 못 할 수 있다 — 기본값을 보수적으로 둔다.
   */
  private readonly concurrency = this.readPositiveInteger(
    process.env.JUDGE_WORKER_CONCURRENCY,
    4,
  );
  private timers: (NodeJS.Timeout | undefined)[] = [];
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EvalRunEvents,
  ) {}

  /**
   * 모듈 시작 시 활성화된 Judge 워커의 폴링 슬롯을 동시성만큼 시작한다.
   * @returns 값을 반환하지 않는다
   */
  start() {
    if (!this.enabled) {
      this.logger.log('Judge worker is disabled.');
      return;
    }
    this.stopping = false;
    for (let slot = 0; slot < this.concurrency; slot++) {
      this.schedule(slot, 0);
    }
    this.logger.log(
      `Judge worker started with concurrency=${this.concurrency}.`,
    );
  }

  /**
   * 모듈 종료 시 추가 스케줄링을 막고 대기 중인 모든 슬롯의 타이머를 해제한다.
   * @returns 값을 반환하지 않는다
   */
  stop() {
    this.stopping = true;
    for (const timer of this.timers) {
      if (timer) clearTimeout(timer);
    }
    this.timers = [];
  }

  /**
   * 처리 가능한 Judge 작업 하나를 선점해 실행하고 처리 여부를 반환한다.
   * 여러 슬롯에서 동시에 호출돼도 `claim()`의 원자적 선점 덕분에 같은
   * 작업이 중복 처리되지 않는다.
   * @returns 작업을 처리했으면 true, 대기 작업이 없으면 false
   */
  async runOnce() {
    const job = await this.claim();
    if (!job) return false;
    await this.process(job);
    return true;
  }

  /**
   * 지정된 슬롯에서 지정된 지연 뒤 다음 폴링을 실행하도록 비차단 타이머를 예약한다.
   * @param slot - 이 타이머가 속한 폴링 슬롯 번호
   * @param delayMs - 다음 폴링까지 기다릴 밀리초
   * @returns 값을 반환하지 않는다
   */
  private schedule(slot: number, delayMs: number) {
    if (this.stopping || !this.enabled) return;
    const timer = setTimeout(() => {
      void this.tick(slot);
    }, delayMs);
    timer.unref();
    this.timers[slot] = timer;
  }

  /**
   * 지정된 슬롯에서 한 번 폴링하고 작업 유무 또는 오류에 따라 다음 실행 시점을 결정한다.
   * @param slot - 폴링을 수행하는 슬롯 번호
   * @returns 폴링 및 다음 예약이 끝나면 이행되는 Promise
   */
  private async tick(slot: number) {
    try {
      const handled = await this.runOnce();
      this.schedule(slot, handled ? 0 : this.pollIntervalMs);
    } catch (error) {
      this.logger.error(
        'Judge worker polling failed.',
        error instanceof Error ? error.stack : String(error),
      );
      this.schedule(slot, this.pollIntervalMs);
    }
  }

  /**
   * 만료 리스를 회수하고 가장 오래된 대기 작업 하나를 원자적으로 선점한다.
   * @returns 선점된 Judge 작업 또는 처리 가능한 작업이 없으면 null
   */
  private async claim(): Promise<JudgeJob | null> {
    const now = new Date();
    let finalizedEvalRunId: string | null = null;
    const claimedJob = await this.prisma.$transaction(async (transaction) => {
      const expired = await transaction.judgeJob.findMany({
        where: {
          status: { in: ['CLAIMED', 'RUNNING'] },
          leaseExpiresAt: { lt: now },
        },
        select: { id: true, evalRunCaseId: true },
      });
      if (expired.length > 0) {
        await transaction.judgeJob.updateMany({
          where: {
            id: { in: expired.map((job) => job.id) },
            // 스캔 이후 정상 완료되었거나 이미 재할당된 작업을 되돌리지 않도록
            // 갱신 시점에 만료 조건을 다시 확인한다.
            status: { in: ['CLAIMED', 'RUNNING'] },
            leaseExpiresAt: { lt: now },
          },
          data: {
            status: 'PENDING',
            leaseId: null,
            leaseExpiresAt: null,
            startedAt: null,
          },
        });
        await transaction.evalRunCase.updateMany({
          where: {
            id: { in: expired.map((job) => job.evalRunCaseId) },
            status: 'JUDGING',
          },
          data: { status: 'WAITING_FOR_JUDGE' },
        });
      }

      const candidate = await transaction.judgeJob.findFirst({
        where: {
          status: 'PENDING',
          availableAt: { lte: now },
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;

      if (candidate.attempt >= candidate.maxAttempts) {
        finalizedEvalRunId = await this.finalizeFailure(
          transaction,
          candidate,
          {
            code: 'MAX_ATTEMPTS_EXCEEDED',
            message: 'Maximum Judge attempts exceeded',
            retryable: false,
          },
          now,
          { id: candidate.id, status: 'PENDING' },
        );
        return null;
      }

      const leaseId = randomUUID();
      const claimed = await transaction.judgeJob.updateMany({
        where: { id: candidate.id, status: 'PENDING' },
        data: {
          status: 'CLAIMED',
          attempt: { increment: 1 },
          leaseId,
          leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
        },
      });
      if (claimed.count !== 1) return null;

      return transaction.judgeJob.findUniqueOrThrow({
        where: { id: candidate.id },
      });
    });
    if (finalizedEvalRunId) this.events.emitProgress(finalizedEvalRunId);
    return claimedJob;
  }

  /**
   * 이 슬롯이 아직 lease 소유자일 때만 일치하는 조건을 만든다(펜싱).
   * lease는 UUID이므로, leaseId가 없는 작업은 어떤 행과도 일치하지 않는 빈 문자열로 비교한다.
   * @param job - 선점 시점의 Judge 작업(leaseId 포함)
   * @param statuses - 소유자로 인정할 작업 상태 목록
   * @returns 상태 변경 UPDATE의 where 조건
   */
  private ownedBy(
    job: JudgeJob,
    statuses: JudgeJobStatus[],
  ): Prisma.JudgeJobWhereInput {
    return {
      id: job.id,
      leaseId: job.leaseId ?? '',
      status: { in: statuses },
    };
  }

  /**
   * 선점 작업과 평가 케이스를 실행 상태로 전환한 뒤 평가 결과를 반영한다.
   * lease를 잃은 슬롯은 어떤 상태도 바꾸지 않고 평가 호출 전에 중단한다.
   * @param job - 처리할 선점된 Judge 작업
   * @returns 처리와 상태 반영이 끝나면 이행되는 Promise
   */
  private async process(job: JudgeJob) {
    const startedAt = new Date();
    const runCase = await this.prisma.$transaction(async (transaction) => {
      const started = await transaction.judgeJob.updateMany({
        where: this.ownedBy(job, ['CLAIMED']),
        data: { status: 'RUNNING', startedAt },
      });
      if (started.count !== 1) return null;
      const selectedCase = await transaction.evalRunCase.update({
        where: { id: job.evalRunCaseId },
        data: { status: 'JUDGING' },
        include: { evalRun: true },
      });
      await transaction.evalRun.updateMany({
        where: { id: selectedCase.evalRunId, status: 'QUEUED' },
        data: { status: 'RUNNING', startedAt },
      });
      return selectedCase;
    });
    if (!runCase) {
      this.logger.warn(`Judge job ${job.id} lost its lease before start.`);
      return;
    }

    try {
      const result = await this.evaluate(runCase);
      const applied = await this.complete(
        job,
        runCase,
        result,
        Date.now() - startedAt.getTime(),
      );
      if (!applied) {
        this.logger.warn(
          `Judge job ${job.id} lost its lease; discarded the stale result.`,
        );
      }
    } catch (error) {
      await this.fail(job, this.normalizeError(error));
    }
  }

  /**
   * 케이스 입력을 Agent Engine 형식으로 변환하고 응답 스키마를 검증한다.
   * @param runCase - 상위 평가 실행 정보가 포함된 평가 케이스
   * @returns 검증된 Agent Engine의 단일 평가 결과
   */
  private async evaluate(
    runCase: Prisma.EvalRunCaseGetPayload<{ include: { evalRun: true } }>,
  ) {
    if (!runCase.outputAnswer?.trim()) {
      throw new JudgeError({
        code: 'MISSING_OUTPUT',
        message: 'EvalRunCase has no outputAnswer',
        retryable: false,
      });
    }

    const input = this.asRecord(runCase.input);
    const expected = this.asRecord(runCase.expected);
    const rubric = this.asRecord(runCase.rubricSnapshot);
    const judgeConfig = this.asRecord(runCase.evalRun.judgeConfig);
    const agentPrompts = this.asRecord(
      judgeConfig.agentPrompts as Prisma.JsonValue,
    );
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    if (!prompt.trim()) {
      throw new JudgeError({
        code: 'INVALID_CASE_INPUT',
        message: 'EvalRunCase input has no prompt',
        retryable: false,
      });
    }

    const response = await fetch(
      `${this.agentEngineUrl}/agents/evaluate/sync`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: runCase.evalRunId,
          agentName: runCase.evalRun.agentName,
          judgeModel: runCase.evalRun.judgeModel ?? 'qwen3.5:4b',
          maxRetries: runCase.evalRun.maxRetries,
          passThreshold: runCase.evalRun.passThreshold,
          agentPrompts,
          metadata: {
            evalRunCaseId: runCase.id,
            evaluationMode: runCase.evaluationMode,
          },
          dataset: [
            {
              prompt,
              output: runCase.outputAnswer,
              expectedOutput:
                typeof expected.referenceAnswer === 'string'
                  ? expected.referenceAnswer
                  : undefined,
              criteria: Array.isArray(rubric.criteria) ? rubric.criteria : [],
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      throw new JudgeError({
        code: 'AGENT_ENGINE_ERROR',
        message: `Agent Engine returned HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const payload = (await response.json()) as AgentEngineResponse;
    const result = payload.results?.[0];
    if (
      !result ||
      !Number.isFinite(result.score) ||
      result.score < 0 ||
      result.score > 1 ||
      !['PASS', 'FAIL', 'RETRY'].includes(result.verdict)
    ) {
      throw new JudgeError({
        code: 'INVALID_JUDGE_RESPONSE',
        message: 'Agent Engine returned an invalid evaluation result',
        retryable: true,
      });
    }
    return result;
  }

  /**
   * Judge 성공 결과를 저장하고 작업·케이스·실행의 상태를 함께 갱신한다.
   * @param job - 완료 처리할 Judge 작업
   * @param runCase - 평가 결과를 연결할 실행 케이스
   * @param result - Agent Engine이 반환한 평가 결과
   * @param durationMs - Judge 처리에 걸린 밀리초
   * @returns 반영했으면 true, lease를 이미 잃어 결과를 버렸으면 false
   */
  private async complete(
    job: JudgeJob,
    runCase: Prisma.EvalRunCaseGetPayload<{ include: { evalRun: true } }>,
    result: AgentEngineResult,
    durationMs: number,
  ) {
    const completedAt = new Date();
    const expected = this.asRecord(runCase.expected);
    const reason =
      this.stringValue(result.supervision?.reason) ??
      this.stringValue(result.metrics?.reason);
    const caseStatus =
      result.verdict === 'RETRY' ? 'REVIEW_REQUIRED' : 'COMPLETED';

    const applied = await this.prisma.$transaction(async (transaction) => {
      // 소유권 확인과 완료 전환을 UPDATE 한 문장으로 처리한다. 이 UPDATE가 행 잠금을
      // 잡고 있는 동안 다른 슬롯의 회수·재할당은 대기하므로, 아래 쓰기는 소유자일 때만 실행된다.
      const owned = await transaction.judgeJob.updateMany({
        where: this.ownedBy(job, ['CLAIMED', 'RUNNING']),
        data: {
          status: 'COMPLETED',
          completedAt,
          leaseId: null,
          leaseExpiresAt: null,
          error: Prisma.DbNull,
        },
      });
      if (owned.count !== 1) return false;

      await transaction.evalResult.upsert({
        where: { evalRunCaseId: runCase.id },
        update: {
          score: result.score,
          verdict: result.verdict,
          reason,
          verification: this.jsonOrDbNull(result.verification),
          evaluation: this.jsonOrDbNull(
            result.evaluation ?? {
              score: result.score,
              metrics: result.metrics ?? {},
            },
          ),
          supervision: this.jsonOrDbNull(result.supervision),
          judgeModel: runCase.evalRun.judgeModel ?? runCase.evalRun.model,
          judgePromptVersion:
            process.env.JUDGE_PROMPT_VERSION ?? 'agent-engine-v0.2.0',
          judgeAttempts: job.attempt,
          schemaValid: true,
          retryCount: result.retryCount ?? 0,
          durationMs,
        },
        create: {
          evalRunId: runCase.evalRunId,
          evalRunCaseId: runCase.id,
          inputPrompt:
            this.stringValue(this.asRecord(runCase.input).prompt) ?? '',
          outputAnswer: runCase.outputAnswer!,
          expectedOutput: this.stringValue(expected.referenceAnswer),
          score: result.score,
          verdict: result.verdict,
          reason,
          verification: this.jsonOrUndefined(result.verification),
          evaluation: this.jsonOrUndefined(
            result.evaluation ?? {
              score: result.score,
              metrics: result.metrics ?? {},
            },
          ),
          supervision: this.jsonOrUndefined(result.supervision),
          judgeModel: runCase.evalRun.judgeModel ?? runCase.evalRun.model,
          judgePromptVersion:
            process.env.JUDGE_PROMPT_VERSION ?? 'agent-engine-v0.2.0',
          judgeAttempts: job.attempt,
          schemaValid: true,
          retryCount: result.retryCount ?? 0,
          durationMs,
        },
      });
      await transaction.evalRunCase.update({
        where: { id: runCase.id },
        data: { status: caseStatus, completedAt },
      });
      await this.refreshRunSummary(transaction, runCase.evalRunId, completedAt);
      return true;
    });
    if (applied) this.events.emitProgress(runCase.evalRunId);
    return applied;
  }

  /**
   * 실패의 재시도 가능성과 시도 횟수에 따라 재큐잉하거나 최종 실패 처리한다.
   * lease를 이미 잃은 슬롯의 실패 보고는 새 소유자의 작업·케이스를 건드리지 않고 버린다.
   * @param job - 실패한 Judge 작업
   * @param error - 재시도 정보가 포함된 표준 오류
   * @returns 실패 상태 반영이 끝나면 이행되는 Promise
   */
  private async fail(job: JudgeJob, error: JudgeExecutionError) {
    const failedAt = new Date();
    const owner = this.ownedBy(job, ['CLAIMED', 'RUNNING']);
    const outcome = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.judgeJob.findFirst({ where: owner });
      if (!current) return null;

      const shouldRetry =
        error.retryable && current.attempt < current.maxAttempts;
      if (shouldRetry) {
        const backoffMs = Math.min(
          1_000 * 2 ** Math.max(current.attempt - 1, 0),
          30_000,
        );
        const requeued = await transaction.judgeJob.updateMany({
          where: owner,
          data: {
            status: 'PENDING',
            availableAt: new Date(failedAt.getTime() + backoffMs),
            leaseId: null,
            leaseExpiresAt: null,
            startedAt: null,
            error: error as unknown as Prisma.InputJsonValue,
          },
        });
        if (requeued.count !== 1) return null;
        await transaction.evalRunCase.update({
          where: { id: job.evalRunCaseId },
          data: { status: 'WAITING_FOR_JUDGE' },
        });
        return { finalizedEvalRunId: null };
      }

      const finalizedEvalRunId = await this.finalizeFailure(
        transaction,
        current,
        error,
        failedAt,
        owner,
      );
      return finalizedEvalRunId ? { finalizedEvalRunId } : null;
    });
    if (!outcome) {
      this.logger.warn(
        `Judge job ${job.id} lost its lease; discarded the stale failure report.`,
      );
      return;
    }
    if (outcome.finalizedEvalRunId) {
      this.events.emitProgress(outcome.finalizedEvalRunId);
    }
  }

  /**
   * 재시도할 수 없는 작업과 케이스를 실패 상태로 확정한다.
   * 작업 전환을 먼저 조건부로 수행해, 소유자가 아니면 케이스와 실행 요약을 건드리지 않는다.
   * @param transaction - 상태를 원자적으로 갱신할 Prisma 트랜잭션
   * @param job - 최종 실패 처리할 Judge 작업
   * @param error - 저장할 표준 오류
   * @param failedAt - 실패가 확정된 시각
   * @param owner - 이 실패를 확정할 자격을 판별하는 조건(lease 소유자 또는 PENDING 후보)
   * @returns 확정된 평가 실행 식별자, 소유자가 아니어서 반영하지 못했으면 null
   */
  private async finalizeFailure(
    transaction: Prisma.TransactionClient,
    job: JudgeJob,
    error: JudgeExecutionError,
    failedAt: Date,
    owner: Prisma.JudgeJobWhereInput,
  ) {
    const failed = await transaction.judgeJob.updateMany({
      where: owner,
      data: {
        status: 'FAILED',
        error: error as unknown as Prisma.InputJsonValue,
        completedAt: failedAt,
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    if (failed.count !== 1) return null;

    const runCase = await transaction.evalRunCase.update({
      where: { id: job.evalRunCaseId },
      data: {
        status: 'JUDGE_FAILED',
        completedAt: failedAt,
      },
      select: { evalRunId: true },
    });
    await this.refreshRunSummary(transaction, runCase.evalRunId, failedAt);
    return runCase.evalRunId;
  }

  /**
   * 케이스 종결 상태를 집계해 상위 평가 실행의 상태와 카운터를 갱신한다.
   * @param transaction - 집계와 갱신에 사용할 Prisma 트랜잭션
   * @param evalRunId - 갱신할 평가 실행 식별자
   * 같은 Run의 요약 갱신은 EvalRun 행 잠금으로 직렬화한다. 잠금 없이 집계하면 READ COMMITTED에서
   * 다른 트랜잭션의 미커밋 종결이 보이지 않아, 동시에 끝난 케이스마다 "내 케이스만 종결"로 계산한
   * stale 값이 마지막에 덮어써진다. 잠금을 기다린 트랜잭션은 앞선 트랜잭션의 커밋을 본 뒤 집계한다.
   * `FOR UPDATE`가 아니라 `FOR NO KEY UPDATE`를 쓰는 이유: EvalResult INSERT의 외래키 검사가 EvalRun 행에
   * `FOR KEY SHARE`를 걸어 두므로, `FOR UPDATE`는 동시에 완료된 트랜잭션끼리 서로를 기다리는 교착이 된다.
   * @param transaction - 집계와 갱신에 사용할 Prisma 트랜잭션
   * @param evalRunId - 갱신할 평가 실행 식별자
   * @param now - 완료 시각으로 기록할 기준 시각
   * @returns 실행 요약 갱신이 끝나면 이행되는 Promise
   */
  private async refreshRunSummary(
    transaction: Prisma.TransactionClient,
    evalRunId: string,
    now: Date,
  ) {
    await transaction.$queryRaw`SELECT id FROM "EvalRun" WHERE id = ${evalRunId} FOR NO KEY UPDATE`;
    const cases = await transaction.evalRunCase.findMany({
      where: { evalRunId },
      select: { status: true },
    });
    const completedCases = cases.filter(
      (item) => item.status === 'COMPLETED',
    ).length;
    const reviewCases = cases.filter(
      (item) => item.status === 'REVIEW_REQUIRED',
    ).length;
    const failedCases = cases.filter((item) =>
      ['EXECUTION_FAILED', 'JUDGE_FAILED'].includes(item.status),
    ).length;
    const terminalCases = completedCases + reviewCases + failedCases;
    const allTerminal = cases.length > 0 && terminalCases === cases.length;
    const successfulCases = completedCases + reviewCases;

    await transaction.evalRun.update({
      where: { id: evalRunId },
      data: {
        completedCases,
        reviewCases,
        failedCases,
        status: allTerminal
          ? successfulCases === 0
            ? 'FAILED'
            : failedCases > 0
              ? 'COMPLETED_WITH_ERRORS'
              : 'COMPLETED'
          : 'RUNNING',
        completedAt: allTerminal ? now : null,
      },
    });
  }

  /**
   * 임의의 예외를 재시도 정보를 가진 표준 Judge 오류로 변환한다.
   * @param error - 정규화할 임의의 오류 값
   * @returns 코드, 메시지 및 재시도 여부를 가진 표준 오류
   */
  private normalizeError(error: unknown): JudgeExecutionError {
    if (error instanceof JudgeError) {
      return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      };
    }
    if (error instanceof Error) {
      return {
        code: 'JUDGE_EXECUTION_ERROR',
        message: error.message,
        retryable: true,
      };
    }
    return {
      code: 'JUDGE_EXECUTION_ERROR',
      message: 'Unknown Judge execution error',
      retryable: true,
    };
  }

  /**
   * Prisma JSON 값이 일반 객체일 때만 레코드로 반환한다.
   * @param value - 변환할 Prisma JSON 값
   * @returns 일반 객체이면 해당 레코드, 아니면 빈 객체
   */
  private asRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  /**
   * 알 수 없는 값에서 문자열만 안전하게 추출한다.
   * @param value - 검사할 임의의 값
   * @returns 문자열 값 또는 undefined
   */
  private stringValue(value: unknown) {
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * 선택적인 객체를 Prisma create 입력용 JSON 값으로 변환한다.
   * @param value - 변환할 선택적 객체
   * @returns Prisma JSON 입력값 또는 undefined
   */
  private jsonOrUndefined(value: Record<string, unknown> | undefined) {
    return value as Prisma.InputJsonValue | undefined;
  }

  /**
   * 선택적인 객체를 Prisma update 입력용 JSON 또는 DB null로 변환한다.
   * @param value - 변환할 선택적 객체
   * @returns Prisma JSON 입력값 또는 데이터베이스 null
   */
  private jsonOrDbNull(value: Record<string, unknown> | undefined) {
    return value ? (value as Prisma.InputJsonValue) : Prisma.DbNull;
  }

  /**
   * 환경 변수 문자열을 양의 정수로 읽고 유효하지 않으면 기본값을 사용한다.
   * @param value - 숫자로 해석할 환경 변수 값
   * @param fallback - 값이 유효하지 않을 때 사용할 기본값
   * @returns 파싱된 양의 정수 또는 기본값
   */
  private readPositiveInteger(value: string | undefined, fallback: number) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
