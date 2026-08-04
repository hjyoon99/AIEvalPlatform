import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';

export interface EvalDatasetItemInput {
  id?: string;
  prompt: string;
  output?: string;
  expectedOutput?: string;
  variables?: Record<string, unknown>;
  context?: unknown[];
  expectedBehavior?: string[];
  requiredConditions?: string[];
  failConditions?: string[];
  allowedVariations?: string[];
  criteria?: Record<string, unknown>[];
}

export interface StartEvalRunInput {
  projectId?: string;
  policyId?: string;
  scenarioIds?: string[];
  applicationId?: string;
  executionMode?: 'ADAPTER' | 'PROVIDED_OUTPUT';
  name: string;
  agentName?: string;
  model?: string;
  judgeModel?: string;
  passThreshold?: number;
  maxRetries?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  dataset?: EvalDatasetItemInput[];
}

interface AgentEngineResult {
  prompt: string;
  output: string;
  expectedOutput?: string;
  score: number;
  verdict: string;
  retryCount?: number;
  verification?: Record<string, unknown>;
  supervision?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}

interface AgentEngineResponse {
  runId: string;
  results: AgentEngineResult[];
}

@Injectable()
export class EvalService {
  private readonly agentEngineUrl =
    process.env.AGENT_ENGINE_URL ?? 'http://127.0.0.1:8000';

  constructor(private readonly prisma: PrismaService) {}

  async createAndRun(input: StartEvalRunInput) {
    const policy = input.policyId
      ? await this.prisma.evaluationPolicy.findUnique({
          where: { id: input.policyId },
        })
      : null;
    if (input.policyId && !policy) {
      throw new BadRequestException('Evaluation policy not found');
    }

    let dataset = input.dataset;
    if ((!dataset || dataset.length === 0) && input.scenarioIds?.length) {
      const scenarios = await this.prisma.scenario.findMany({
        where: {
          id: { in: input.scenarioIds },
          status: 'APPROVED',
          ...(input.projectId ? { projectId: input.projectId } : {}),
        },
      });
      if (scenarios.length !== input.scenarioIds.length) {
        throw new BadRequestException(
          'Only approved scenarios from the selected project can be tested',
        );
      }
      const policyMetrics = Array.isArray(policy?.metrics)
        ? (policy.metrics as Record<string, unknown>[])
        : [];
      dataset = scenarios.map((scenario) => {
        const rubric = (scenario.evaluationRubric ?? {}) as Record<
          string,
          unknown
        >;
        const rubricMetrics = Array.isArray(rubric.metrics)
          ? (rubric.metrics as Record<string, unknown>[])
          : [];
        const criteria =
          policyMetrics.length > 0
            ? policyMetrics.map((metric) => ({
                ...metric,
                rubric: rubricMetrics.find((item) => item.key === metric.key),
                requiredConditions: rubric.requiredConditions ?? [],
                failConditions: rubric.failConditions ?? [],
                allowedVariations: rubric.allowedVariations ?? [],
              }))
            : [
                {
                  key: 'scenarioCompliance',
                  name: '시나리오 충족도',
                  description: '시나리오별 채점 루브릭 충족 여부',
                  weight: 1,
                  rubric,
                },
              ];
        return {
          prompt: scenario.prompt,
          output: scenario.testOutput?.trim() || undefined,
          expectedOutput: scenario.expectedOutput ?? undefined,
          criteria,
        };
      });
    }

    if (input.executionMode) {
      return this.createQueuedRun(input, dataset, policy);
    }

    this.validateLegacyInput(input, dataset);

    const run = await this.prisma.evalRun.create({
      data: {
        projectId: input.projectId,
        policyId: policy?.id,
        policySnapshot: policy
          ? {
              name: policy.name,
              passThreshold: policy.passThreshold,
              maxRetries: policy.maxRetries,
              metrics: policy.metrics,
            }
          : undefined,
        name: input.name.trim(),
        agentName: input.agentName!.trim(),
        model: input.model ?? 'qwen3.5:4b',
        judgeModel: input.model ?? 'qwen3.5:4b',
        passThreshold: input.passThreshold ?? policy?.passThreshold ?? 0.7,
        maxRetries: input.maxRetries ?? policy?.maxRetries ?? 1,
        status: 'RUNNING',
      },
    });

    const startedAt = Date.now();

    try {
      const response = await fetch(
        `${this.agentEngineUrl}/agents/evaluate/sync`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId: run.id,
            agentName: run.agentName,
            model: run.model,
            maxRetries: run.maxRetries,
            passThreshold: run.passThreshold,
            criteria: policy?.metrics ?? [],
            dataset,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Agent engine returned ${response.status}: ${await response.text()}`,
        );
      }

      const payload = (await response.json()) as AgentEngineResponse;
      const durationMs = Date.now() - startedAt;

      await this.prisma.$transaction([
        this.prisma.evalResult.createMany({
          data: payload.results.map((result) => ({
            evalRunId: run.id,
            inputPrompt: result.prompt,
            outputAnswer: result.output,
            expectedOutput: result.expectedOutput,
            score: result.score,
            verdict: result.verdict,
            reason:
              (result.supervision?.reason as string | undefined) ??
              (result.metrics?.reason as string | undefined),
            verification:
              (result.verification as Prisma.InputJsonValue | undefined) ??
              undefined,
            evaluation: {
              score: result.score,
              metrics: result.metrics ?? {},
            } as Prisma.InputJsonValue,
            supervision:
              (result.supervision as Prisma.InputJsonValue | undefined) ??
              undefined,
            retryCount: result.retryCount ?? 0,
            durationMs,
          })),
        }),
        this.prisma.evalRun.update({
          where: { id: run.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
          },
        }),
      ]);

      return this.findOne(run.id);
    } catch (error) {
      await this.prisma.evalRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
        },
      });

      throw new BadGatewayException(
        error instanceof Error ? error.message : 'Agent engine request failed',
      );
    }
  }

  async findAll() {
    const runs = await this.prisma.evalRun.findMany({
      include: {
        cases: {
          select: { status: true },
          orderBy: { caseIndex: 'asc' },
        },
        results: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return runs.map((run) => ({
      ...run,
      progress: this.buildProgress(run.cases),
    }));
  }

  async findOne(id: string) {
    const run = await this.prisma.evalRun.findUnique({
      where: { id },
      include: {
        application: {
          select: {
            id: true,
            name: true,
            environment: true,
            active: true,
          },
        },
        cases: {
          include: {
            sdkJob: {
              select: {
                id: true,
                status: true,
                attempt: true,
                maxAttempts: true,
                error: true,
              },
            },
            judgeJob: {
              select: {
                id: true,
                status: true,
                attempt: true,
                maxAttempts: true,
                error: true,
              },
            },
            result: true,
          },
          orderBy: { caseIndex: 'asc' },
        },
        results: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!run) {
      throw new NotFoundException('Evaluation run not found');
    }
    return {
      ...run,
      progress: this.buildProgress(run.cases),
    };
  }

  async remove(id: string) {
    const run = await this.prisma.evalRun.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!run) {
      throw new NotFoundException('Evaluation run not found');
    }
    if (['QUEUED', 'RUNNING'].includes(run.status)) {
      throw new BadRequestException(
        'A queued or running evaluation cannot be deleted',
      );
    }
    await this.prisma.evalRun.delete({ where: { id } });
    return { id, deleted: true };
  }

  async getSummary() {
    const [totalRuns, totalResults, passedResults, score] = await Promise.all([
      this.prisma.evalRun.count(),
      this.prisma.evalResult.count(),
      this.prisma.evalResult.count({ where: { verdict: 'PASS' } }),
      this.prisma.evalResult.aggregate({ _avg: { score: true } }),
    ]);

    return {
      totalRuns,
      totalEvaluations: totalResults,
      averageScore: Number((score._avg.score ?? 0).toFixed(2)),
      passRate:
        totalResults === 0
          ? 0
          : Number((passedResults / totalResults).toFixed(2)),
    };
  }

  private async createQueuedRun(
    input: StartEvalRunInput,
    dataset: EvalDatasetItemInput[] | undefined,
    policy: {
      id: string;
      projectId: string;
      name: string;
      passThreshold: number;
      maxRetries: number;
      metrics: Prisma.JsonValue;
    } | null,
  ) {
    this.validateAutomatedInput(input, dataset, policy);
    const cases = dataset!;
    const executionMode = input.executionMode!;
    const application =
      executionMode === 'ADAPTER'
        ? await this.prisma.aIApplication.findUnique({
            where: { id: input.applicationId! },
            select: {
              id: true,
              projectId: true,
              name: true,
              active: true,
            },
          })
        : null;

    if (executionMode === 'ADAPTER' && !application?.active) {
      throw new BadRequestException('Active AI application not found');
    }
    if (
      input.projectId &&
      application &&
      application.projectId !== input.projectId
    ) {
      throw new BadRequestException(
        'AI application must belong to the selected project',
      );
    }

    const projectId =
      input.projectId ?? application?.projectId ?? policy?.projectId;
    if (policy && projectId && policy.projectId !== projectId) {
      throw new BadRequestException(
        'Evaluation policy must belong to the selected project',
      );
    }

    const judgeModel = input.judgeModel ?? input.model ?? 'qwen3.5:4b';
    const timeoutMs = input.timeoutMs ?? 30_000;
    const sdkMaxAttempts = input.maxAttempts ?? 3;
    const judgeMaxAttempts = Math.min(
      Math.max((input.maxRetries ?? policy?.maxRetries ?? 1) + 1, 1),
      3,
    );

    const run = await this.prisma.$transaction(async (transaction) => {
      const createdRun = await transaction.evalRun.create({
        data: {
          projectId,
          policyId: policy?.id,
          applicationId: application?.id,
          policySnapshot: policy
            ? {
                name: policy.name,
                passThreshold: policy.passThreshold,
                maxRetries: policy.maxRetries,
                metrics: policy.metrics,
              }
            : undefined,
          name: input.name.trim(),
          agentName:
            input.agentName?.trim() ?? application?.name ?? 'provided-output',
          model: judgeModel,
          judgeModel,
          executionMode,
          status: 'QUEUED',
          passThreshold: input.passThreshold ?? policy?.passThreshold ?? 0.7,
          maxRetries: input.maxRetries ?? policy?.maxRetries ?? 1,
          totalCases: cases.length,
        },
      });

      for (const [caseIndex, item] of cases.entries()) {
        const referenceAnswer = item.expectedOutput?.trim();
        const evaluationMode = referenceAnswer
          ? 'REFERENCE_BASED'
          : 'RUBRIC_ONLY';
        const outputAnswer = item.output?.trim();
        const createdCase = await transaction.evalRunCase.create({
          data: {
            evalRunId: createdRun.id,
            caseIndex,
            externalCaseId: item.id,
            evaluationMode,
            status:
              executionMode === 'ADAPTER'
                ? 'WAITING_FOR_EXECUTION'
                : 'WAITING_FOR_JUDGE',
            input: {
              prompt: item.prompt.trim(),
              variables: item.variables ?? {},
              context: item.context ?? [],
            } as Prisma.InputJsonValue,
            expected: this.toJson({
              referenceAnswer,
              expectedBehavior: item.expectedBehavior,
              requiredConditions: item.requiredConditions,
              failConditions: item.failConditions,
              allowedVariations: item.allowedVariations,
            }),
            rubricSnapshot: {
              criteria: item.criteria ?? policy?.metrics ?? [],
            } as Prisma.InputJsonValue,
            outputAnswer:
              executionMode === 'PROVIDED_OUTPUT' ? outputAnswer : undefined,
            answerCompletedAt:
              executionMode === 'PROVIDED_OUTPUT' ? new Date() : undefined,
          },
        });

        if (executionMode === 'ADAPTER') {
          await transaction.sdkJob.create({
            data: {
              applicationId: application!.id,
              evalRunCaseId: createdCase.id,
              testCase: {
                id: item.id ?? createdCase.id,
                prompt: item.prompt.trim(),
                variables: item.variables ?? {},
                metadata: {
                  evalRunId: createdRun.id,
                  evalRunCaseId: createdCase.id,
                  caseIndex,
                },
              } as Prisma.InputJsonValue,
              timeoutMs,
              maxAttempts: sdkMaxAttempts,
            },
          });
        } else {
          await transaction.judgeJob.create({
            data: {
              evalRunCaseId: createdCase.id,
              maxAttempts: judgeMaxAttempts,
            },
          });
        }
      }

      return createdRun;
    });

    return this.findOne(run.id);
  }

  private validateAutomatedInput(
    input: StartEvalRunInput,
    dataset: EvalDatasetItemInput[] | undefined,
    policy: { metrics: Prisma.JsonValue } | null,
  ) {
    if (!input?.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    if (!['ADAPTER', 'PROVIDED_OUTPUT'].includes(input.executionMode ?? '')) {
      throw new BadRequestException(
        'executionMode must be ADAPTER or PROVIDED_OUTPUT',
      );
    }
    if (input.executionMode === 'ADAPTER' && !input.applicationId) {
      throw new BadRequestException(
        'applicationId is required for ADAPTER execution',
      );
    }
    if (!Array.isArray(dataset) || dataset.length === 0) {
      throw new BadRequestException(
        'dataset or at least one approved scenarioId is required',
      );
    }
    if (dataset.some((item) => !item.prompt?.trim())) {
      throw new BadRequestException('Every dataset item needs a prompt');
    }
    if (
      input.executionMode === 'PROVIDED_OUTPUT' &&
      dataset.some((item) => !item.output?.trim())
    ) {
      throw new BadRequestException(
        'Every PROVIDED_OUTPUT item needs a non-empty output',
      );
    }
    const hasPolicyCriteria =
      Array.isArray(policy?.metrics) && policy.metrics.length > 0;
    if (
      dataset.some(
        (item) =>
          !item.expectedOutput?.trim() &&
          !item.criteria?.length &&
          !item.expectedBehavior?.length &&
          !item.requiredConditions?.length &&
          !item.failConditions?.length &&
          !hasPolicyCriteria,
      )
    ) {
      throw new BadRequestException(
        'RUBRIC_ONLY items need criteria or expected behavior',
      );
    }
    const timeoutMs = input.timeoutMs ?? 30_000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 300_000
    ) {
      throw new BadRequestException(
        'timeoutMs must be an integer from 1000 to 300000',
      );
    }
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      throw new BadRequestException(
        'maxAttempts must be an integer from 1 to 5',
      );
    }
    this.validateSharedSettings(input);
  }

  private validateLegacyInput(
    input: StartEvalRunInput,
    dataset?: EvalDatasetItemInput[],
  ) {
    if (!input?.name?.trim() || !input?.agentName?.trim()) {
      throw new BadRequestException('name and agentName are required');
    }
    if (!Array.isArray(dataset) || dataset.length === 0) {
      throw new BadRequestException(
        'dataset or at least one approved scenarioId is required',
      );
    }
    if (dataset.some((item) => !item.prompt?.trim())) {
      throw new BadRequestException('Every dataset item needs a prompt');
    }
    this.validateSharedSettings(input);
  }

  private validateSharedSettings(input: StartEvalRunInput) {
    if (
      input.passThreshold !== undefined &&
      (input.passThreshold < 0 || input.passThreshold > 1)
    ) {
      throw new BadRequestException('passThreshold must be between 0 and 1');
    }
    if (
      input.maxRetries !== undefined &&
      (!Number.isInteger(input.maxRetries) ||
        input.maxRetries < 0 ||
        input.maxRetries > 2)
    ) {
      throw new BadRequestException(
        'maxRetries must be an integer from 0 to 2',
      );
    }
  }

  private toJson(value: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined),
    ) as Prisma.InputJsonValue;
  }

  private buildProgress(cases: { status: string }[]) {
    const count = (statuses: string[]) =>
      cases.filter((item) => statuses.includes(item.status)).length;
    return {
      total: cases.length,
      waitingForExecution: count(['WAITING_FOR_EXECUTION']),
      executing: count(['EXECUTING']),
      waitingForJudge: count(['ANSWER_COMPLETED', 'WAITING_FOR_JUDGE']),
      judging: count(['JUDGING']),
      completed: count(['COMPLETED']),
      reviewRequired: count(['REVIEW_REQUIRED']),
      failed: count(['EXECUTION_FAILED', 'JUDGE_FAILED']),
      cancelled: count(['CANCELLED']),
    };
  }
}
