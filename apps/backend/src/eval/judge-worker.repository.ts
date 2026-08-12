import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type JudgeJob } from '@prisma/client';
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
        finalizedEvalRunId = await this.finalizeFailure(
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
    if (finalizedEvalRunId) this.events.emitProgress(finalizedEvalRunId);
    return claimedJob;
  }

  /**
   * 선점 작업과 평가 케이스를 실행 상태로 전환한 뒤 평가 결과를 반영한다.
   * @param job - 처리할 선점된 Judge 작업
   * @returns 처리와 상태 반영이 끝나면 이행되는 Promise
   */
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
      await this.complete(
        job,
        runCase,
        result,
        Date.now() - startedAt.getTime(),
      );
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
      throw {
        code: 'MISSING_OUTPUT',
        message: 'EvalRunCase has no outputAnswer',
        retryable: false,
      } satisfies JudgeExecutionError;
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
      throw {
        code: 'INVALID_CASE_INPUT',
        message: 'EvalRunCase input has no prompt',
        retryable: false,
      } satisfies JudgeExecutionError;
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

  /**
   * Judge 성공 결과를 저장하고 작업·케이스·실행의 상태를 함께 갱신한다.
   * @param job - 완료 처리할 Judge 작업
   * @param runCase - 평가 결과를 연결할 실행 케이스
   * @param result - Agent Engine이 반환한 평가 결과
   * @param durationMs - Judge 처리에 걸린 밀리초
   * @returns 트랜잭션 반영이 끝나면 이행되는 Promise
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
    this.events.emitProgress(runCase.evalRunId);
  }

  /**
   * 실패의 재시도 가능성과 시도 횟수에 따라 재큐잉하거나 최종 실패 처리한다.
   * @param job - 실패한 Judge 작업
   * @param error - 재시도 정보가 포함된 표준 오류
   * @returns 실패 상태 반영이 끝나면 이행되는 Promise
   */
  private async fail(job: JudgeJob, error: JudgeExecutionError) {
    const failedAt = new Date();
    const finalizedEvalRunId = await this.prisma.$transaction(
      async (transaction) => {
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
          return null;
        }

        return this.finalizeFailure(transaction, current, error, failedAt);
      },
    );
    if (finalizedEvalRunId) this.events.emitProgress(finalizedEvalRunId);
  }

  /**
   * 재시도할 수 없는 작업과 케이스를 실패 상태로 확정한다.
   * @param transaction - 상태를 원자적으로 갱신할 Prisma 트랜잭션
   * @param job - 최종 실패 처리할 Judge 작업
   * @param error - 저장할 표준 오류
   * @param failedAt - 실패가 확정된 시각
   * @returns 실패 및 실행 요약 반영이 끝나면 이행되는 Promise
   */
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
    return runCase.evalRunId;
  }

  /**
   * 케이스 종결 상태를 집계해 상위 평가 실행의 상태와 카운터를 갱신한다.
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

  /**
   * 값이 JudgeExecutionError 구조를 만족하는지 판별한다.
   * @param value - 검사할 임의의 값
   * @returns 표준 Judge 오류 구조이면 true
   */
  private isJudgeError(value: unknown): value is JudgeExecutionError {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<JudgeExecutionError>;
    return (
      typeof candidate.code === 'string' &&
      typeof candidate.message === 'string' &&
      typeof candidate.retryable === 'boolean'
    );
  }

  /**
   * Prisma JSON 값이 일반 객체일 때만 레코드로 반환한다.
   * @param value - 변환할 Prisma JSON 값
   * @returns 일반 객체이면 해당 레코드, 아니면 빈 객체
   */
  private asRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
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
