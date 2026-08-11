import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import type {
  EvalDatasetItemInput,
  StartEvalRunInput,
} from './dto/create-eval-run.dto';

export interface EvalPolicyRecord {
  id: string;
  projectId: string;
  name: string;
  passThreshold: number;
  maxRetries: number;
  metrics: Prisma.JsonValue;
}

interface CreateQueuedRunParams {
  input: StartEvalRunInput;
  cases: EvalDatasetItemInput[];
  policy: EvalPolicyRecord | null;
  application: {
    id: string;
    projectId: string;
    name: string;
    active: boolean;
  } | null;
  projectId?: string;
  agentPrompts?: Record<string, unknown>;
  judgeModel: string;
  timeoutMs: number;
  sdkMaxAttempts: number;
  judgeMaxAttempts: number;
}

/** 평가 실행, 케이스, 결과 및 관련 작업의 영속화를 전담한다. */
@Injectable()
export class EvalRepository {
  constructor(private readonly prisma: PrismaService) {}

  findPolicy(policyId: string) {
    return this.prisma.evaluationPolicy.findUnique({ where: { id: policyId } });
  }

  findApprovedScenarios(scenarioIds: string[], projectId?: string) {
    return this.prisma.scenario.findMany({
      where: {
        id: { in: scenarioIds },
        status: 'APPROVED',
        ...(projectId ? { projectId } : {}),
      },
    });
  }

  findRuns() {
    return this.prisma.evalRun.findMany({
      include: {
        cases: {
          select: { status: true },
          orderBy: { caseIndex: 'asc' },
        },
        results: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
  }

  findRun(id: string) {
    return this.prisma.evalRun.findUnique({
      where: { id },
      include: {
        application: {
          select: { id: true, name: true, environment: true, active: true },
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
        results: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  findRunStatus(id: string) {
    return this.prisma.evalRun.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
  }

  deleteRun(id: string) {
    return this.prisma.evalRun.delete({ where: { id } });
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
      totalResults,
      passedResults,
      averageScore: score._avg.score,
    };
  }

  findApplication(applicationId: string) {
    return this.prisma.aIApplication.findUnique({
      where: { id: applicationId },
      select: { id: true, projectId: true, name: true, active: true },
    });
  }

  async createQueuedRun(params: CreateQueuedRunParams) {
    const {
      input,
      cases,
      policy,
      application,
      projectId,
      agentPrompts,
      judgeModel,
      timeoutMs,
      sdkMaxAttempts,
      judgeMaxAttempts,
    } = params;
    const executionMode = input.executionMode;

    return this.prisma.$transaction(async (transaction) => {
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
          model:
            input.targetModel?.trim() ||
            input.agentName?.trim() ||
            application?.name ||
            'provided-output',
          judgeModel,
          judgeConfig: agentPrompts
            ? ({ agentPrompts } as Prisma.InputJsonValue)
            : undefined,
          executionMode,
          status: 'QUEUED',
          passThreshold: input.passThreshold ?? policy?.passThreshold ?? 0.7,
          maxRetries: input.maxRetries ?? policy?.maxRetries ?? 1,
          totalCases: cases.length,
        },
      });

      for (const [caseIndex, item] of cases.entries()) {
        const referenceAnswer = item.expectedOutput?.trim();
        const outputAnswer = item.output?.trim();
        const createdCase = await transaction.evalRunCase.create({
          data: {
            evalRunId: createdRun.id,
            caseIndex,
            externalCaseId: item.id,
            evaluationMode: referenceAnswer ? 'REFERENCE_BASED' : 'RUBRIC_ONLY',
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
  }

  findProjectAgentPrompts(projectId: string) {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      select: { agentPrompts: true },
    });
  }

  private toJson(value: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined),
    ) as Prisma.InputJsonValue;
  }
}
