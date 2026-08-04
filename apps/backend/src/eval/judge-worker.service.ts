import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type JudgeJob } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';

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

interface AgentEngineResponse {
  runId: string;
  results: AgentEngineResult[];
}

interface JudgeExecutionError {
  code: string;
  message: string;
  retryable: boolean;
}

@Injectable()
export class JudgeWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JudgeWorkerService.name);
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
  private timer?: NodeJS.Timeout;
  private stopping = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Judge worker is disabled.');
      return;
    }
    this.schedule(0);
    this.logger.log('Judge worker started.');
  }

  onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async runOnce() {
    const job = await this.claim();
    if (!job) return false;
    await this.process(job);
    return true;
  }

  private schedule(delayMs: number) {
    if (this.stopping || !this.enabled) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick() {
    try {
      const handled = await this.runOnce();
      this.schedule(handled ? 0 : this.pollIntervalMs);
    } catch (error) {
      this.logger.error(
        'Judge worker polling failed.',
        error instanceof Error ? error.stack : String(error),
      );
      this.schedule(this.pollIntervalMs);
    }
  }

  private async claim(): Promise<JudgeJob | null> {
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const expired = await transaction.judgeJob.findMany({
        where: {
          status: { in: ['CLAIMED', 'RUNNING'] },
          leaseExpiresAt: { lt: now },
        },
        select: { id: true, evalRunCaseId: true },
      });
      if (expired.length > 0) {
        await transaction.judgeJob.updateMany({
          where: { id: { in: expired.map((job) => job.id) } },
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
        await this.finalizeFailure(
          transaction,
          candidate,
          {
            code: 'MAX_ATTEMPTS_EXCEEDED',
            message: 'Maximum Judge attempts exceeded',
            retryable: false,
          },
          now,
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
  }

  private async process(job: JudgeJob) {
    const startedAt = new Date();
    const runCase = await this.prisma.$transaction(async (transaction) => {
      await transaction.judgeJob.update({
        where: { id: job.id },
        data: { status: 'RUNNING', startedAt },
      });
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

    try {
      const result = await this.evaluate(runCase);
      await this.complete(job, runCase, result, Date.now() - startedAt.getTime());
    } catch (error) {
      await this.fail(job, this.normalizeError(error));
    }
  }

  private async evaluate(
    runCase: Prisma.EvalRunCaseGetPayload<{ include: { evalRun: true } }>,
  ) {
    if (!runCase.outputAnswer?.trim()) {
      throw {
        code: 'MISSING_OUTPUT',
        message: 'EvalRunCase has no outputAnswer',
        retryable: false,
      } satisfies JudgeExecutionError;
    }

    const input = this.asRecord(runCase.input);
    const expected = this.asRecord(runCase.expected);
    const rubric = this.asRecord(runCase.rubricSnapshot);
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    if (!prompt.trim()) {
      throw {
        code: 'INVALID_CASE_INPUT',
        message: 'EvalRunCase input has no prompt',
        retryable: false,
      } satisfies JudgeExecutionError;
    }

    const response = await fetch(`${this.agentEngineUrl}/agents/evaluate/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: runCase.evalRunId,
        agentName: runCase.evalRun.agentName,
        model: runCase.evalRun.judgeModel ?? runCase.evalRun.model,
        maxRetries: runCase.evalRun.maxRetries,
        passThreshold: runCase.evalRun.passThreshold,
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
            criteria: Array.isArray(rubric.criteria)
              ? rubric.criteria
              : [],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw {
        code: 'AGENT_ENGINE_ERROR',
        message: `Agent Engine returned HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      } satisfies JudgeExecutionError;
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
      throw {
        code: 'INVALID_JUDGE_RESPONSE',
        message: 'Agent Engine returned an invalid evaluation result',
        retryable: true,
      } satisfies JudgeExecutionError;
    }
    return result;
  }

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

    await this.prisma.$transaction(async (transaction) => {
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
          judgeModel:
            runCase.evalRun.judgeModel ?? runCase.evalRun.model,
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
          inputPrompt: this.stringValue(this.asRecord(runCase.input).prompt) ?? '',
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
          judgeModel:
            runCase.evalRun.judgeModel ?? runCase.evalRun.model,
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
      await transaction.judgeJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          completedAt,
          leaseId: null,
          leaseExpiresAt: null,
          error: Prisma.DbNull,
        },
      });
      await this.refreshRunSummary(transaction, runCase.evalRunId, completedAt);
    });
  }

  private async fail(job: JudgeJob, error: JudgeExecutionError) {
    const failedAt = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.judgeJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      const shouldRetry =
        error.retryable && current.attempt < current.maxAttempts;
      if (shouldRetry) {
        const backoffMs = Math.min(
          1_000 * 2 ** Math.max(current.attempt - 1, 0),
          30_000,
        );
        await transaction.judgeJob.update({
          where: { id: job.id },
          data: {
            status: 'PENDING',
            availableAt: new Date(failedAt.getTime() + backoffMs),
            leaseId: null,
            leaseExpiresAt: null,
            startedAt: null,
            error: error as unknown as Prisma.InputJsonValue,
          },
        });
        await transaction.evalRunCase.update({
          where: { id: job.evalRunCaseId },
          data: { status: 'WAITING_FOR_JUDGE' },
        });
        return;
      }

      await this.finalizeFailure(transaction, current, error, failedAt);
    });
  }

  private async finalizeFailure(
    transaction: Prisma.TransactionClient,
    job: JudgeJob,
    error: JudgeExecutionError,
    failedAt: Date,
  ) {
    const runCase = await transaction.evalRunCase.update({
      where: { id: job.evalRunCaseId },
      data: {
        status: 'JUDGE_FAILED',
        completedAt: failedAt,
      },
      select: { evalRunId: true },
    });
    await transaction.judgeJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        error: error as unknown as Prisma.InputJsonValue,
        completedAt: failedAt,
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    await this.refreshRunSummary(transaction, runCase.evalRunId, failedAt);
  }

  private async refreshRunSummary(
    transaction: Prisma.TransactionClient,
    evalRunId: string,
    now: Date,
  ) {
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

  private normalizeError(error: unknown): JudgeExecutionError {
    if (this.isJudgeError(error)) return error;
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

  private isJudgeError(value: unknown): value is JudgeExecutionError {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<JudgeExecutionError>;
    return (
      typeof candidate.code === 'string' &&
      typeof candidate.message === 'string' &&
      typeof candidate.retryable === 'boolean'
    );
  }

  private asRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' ? value : undefined;
  }

  private jsonOrUndefined(value: Record<string, unknown> | undefined) {
    return value as Prisma.InputJsonValue | undefined;
  }

  private jsonOrDbNull(value: Record<string, unknown> | undefined) {
    return value
      ? (value as Prisma.InputJsonValue)
      : Prisma.DbNull;
  }

  private readPositiveInteger(value: string | undefined, fallback: number) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
