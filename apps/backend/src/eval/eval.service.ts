import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';

export interface EvalDatasetItemInput {
  prompt: string;
  output?: string;
  expectedOutput?: string;
  criteria?: Record<string, unknown>[];
}

export interface StartEvalRunInput {
  projectId?: string;
  policyId?: string;
  scenarioIds?: string[];
  name: string;
  agentName: string;
  model?: string;
  passThreshold?: number;
  maxRetries?: number;
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

    this.validateInput(input, dataset);

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
        agentName: input.agentName.trim(),
        model: input.model ?? 'qwen3.5:4b',
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

  findAll() {
    return this.prisma.evalRun.findMany({
      include: {
        results: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
  }

  async findOne(id: string) {
    const run = await this.prisma.evalRun.findUnique({
      where: { id },
      include: {
        results: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!run) {
      throw new NotFoundException('Evaluation run not found');
    }
    return run;
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

  private validateInput(
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
}
