import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';

export interface CreateProjectInput {
  name: string;
  domain: string;
  description?: string;
  context?: Record<string, unknown>;
}

export interface MetricInput {
  key: string;
  name: string;
  description: string;
  weight: number;
  required?: boolean;
}

export interface CreatePolicyInput {
  name: string;
  passThreshold?: number;
  maxRetries?: number;
  metrics: MetricInput[];
}

export interface GenerateScenariosInput {
  policyId?: string;
  count?: number;
  model?: string;
}

export interface CreateScenarioInput {
  title: string;
  category?: string;
  prompt: string;
  testOutput?: string;
  expectedOutput?: string;
  expectedBehavior?: string[];
  evaluationRubric?: Record<string, unknown>;
  riskLevel?: string;
}

export interface ReviewScenarioInput {
  status: 'APPROVED' | 'REJECTED';
  rejectionReason?: string;
}

export interface UpdateScenarioInput {
  title?: string;
  prompt?: string;
  testOutput?: string | null;
  expectedOutput?: string;
  expectedBehavior?: string[];
  evaluationRubric?: Record<string, unknown>;
  riskLevel?: string;
}

interface GeneratedScenario {
  title: string;
  category?: string;
  prompt: string;
  expectedOutput?: string;
  expectedBehavior?: string[];
  evaluationRubric?: Record<string, unknown>;
  riskLevel?: string;
  autoValidation?: Record<string, unknown>;
  status?: string;
}

@Injectable()
export class ProjectService {
  private readonly agentEngineUrl =
    process.env.AGENT_ENGINE_URL ?? 'http://127.0.0.1:8000';

  constructor(private readonly prisma: PrismaService) {}

  createProject(input: CreateProjectInput) {
    if (!input?.name?.trim() || !input?.domain?.trim()) {
      throw new BadRequestException('name and domain are required');
    }
    return this.prisma.project.create({
      data: {
        name: input.name.trim(),
        domain: input.domain.trim(),
        description: input.description?.trim(),
        context: input.context as Prisma.InputJsonValue | undefined,
      },
    });
  }

  getProjects() {
    return this.prisma.project.findMany({
      include: {
        _count: {
          select: { policies: true, scenarios: true, evalRuns: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteProject(projectId: string) {
    await this.requireProject(projectId);
    const activeRuns = await this.prisma.evalRun.count({
      where: {
        projectId,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
    });
    if (activeRuns > 0) {
      throw new ConflictException(
        'A project with queued or running evaluations cannot be deleted',
      );
    }
    await this.prisma.project.delete({ where: { id: projectId } });
    return { id: projectId, deleted: true };
  }

  async createPolicy(projectId: string, input: CreatePolicyInput) {
    await this.requireProject(projectId);
    this.validatePolicy(input);
    return this.prisma.evaluationPolicy.create({
      data: {
        projectId,
        name: input.name.trim(),
        passThreshold: input.passThreshold ?? 0.7,
        maxRetries: input.maxRetries ?? 1,
        metrics: input.metrics as unknown as Prisma.InputJsonValue,
      },
    });
  }

  getPolicies(projectId: string) {
    return this.prisma.evaluationPolicy.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deletePolicy(policyId: string) {
    const policy = await this.prisma.evaluationPolicy.findUnique({
      where: { id: policyId },
      select: { id: true },
    });
    if (!policy) {
      throw new NotFoundException('Evaluation policy not found');
    }
    await this.prisma.evaluationPolicy.delete({ where: { id: policyId } });
    return { id: policyId, deleted: true };
  }

  async createScenario(projectId: string, input: CreateScenarioInput) {
    await this.requireProject(projectId);
    if (!input?.title?.trim() || !input?.prompt?.trim()) {
      throw new BadRequestException('title and prompt are required');
    }
    return this.prisma.scenario.create({
      data: {
        projectId,
        title: input.title.trim(),
        category: input.category?.trim() || null,
        prompt: input.prompt.trim(),
        testOutput: input.testOutput?.trim() || null,
        expectedOutput: input.expectedOutput?.trim() || null,
        expectedBehavior: input.expectedBehavior,
        evaluationRubric: input.evaluationRubric as
          Prisma.InputJsonValue | undefined,
        riskLevel: input.riskLevel?.trim() || 'MEDIUM',
        status: 'DRAFT',
      },
    });
  }

  async generateScenarios(projectId: string, input: GenerateScenariosInput) {
    const project = await this.requireProject(projectId);
    const policy = input.policyId
      ? await this.prisma.evaluationPolicy.findFirst({
          where: { id: input.policyId, projectId },
        })
      : await this.prisma.evaluationPolicy.findFirst({
          where: { projectId },
          orderBy: { createdAt: 'desc' },
        });

    const response = await fetch(`${this.agentEngineUrl}/scenarios/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: project.domain,
        description: project.description,
        context: project.context ?? {},
        criteria: policy?.metrics ?? [],
        count: Math.min(Math.max(input.count ?? 5, 1), 10),
        model: input.model ?? 'qwen3.5:4b',
      }),
    });

    if (!response.ok) {
      throw new BadGatewayException(
        `Scenario engine returned ${response.status}: ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as {
      scenarios: GeneratedScenario[];
    };

    await this.prisma.scenario.createMany({
      data: payload.scenarios.map((scenario) => ({
        projectId,
        title: scenario.title,
        category: scenario.category,
        prompt: scenario.prompt,
        expectedOutput: scenario.expectedOutput,
        expectedBehavior: scenario.expectedBehavior,
        evaluationRubric: this.normalizeRubric(
          scenario.evaluationRubric,
          (policy?.metrics ?? []) as unknown as MetricInput[],
        ) as Prisma.InputJsonValue,
        riskLevel: scenario.riskLevel ?? 'MEDIUM',
        status: scenario.status ?? 'DRAFT',
        autoValidation: scenario.autoValidation as
          Prisma.InputJsonValue | undefined,
      })),
    });

    return this.getScenarios(projectId);
  }

  getScenarios(projectId: string) {
    return this.prisma.scenario.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async reviewScenario(scenarioId: string, input: ReviewScenarioInput) {
    if (!['APPROVED', 'REJECTED'].includes(input.status)) {
      throw new BadRequestException('status must be APPROVED or REJECTED');
    }
    return this.prisma.scenario.update({
      where: { id: scenarioId },
      data: {
        status: input.status,
        rejectionReason:
          input.status === 'REJECTED'
            ? (input.rejectionReason ?? '사람 검토에서 거절됨')
            : null,
        reviewedAt: new Date(),
      },
    });
  }

  async updateScenario(scenarioId: string, input: UpdateScenarioInput) {
    const scenario = await this.prisma.scenario.findUnique({
      where: { id: scenarioId },
    });
    if (!scenario) {
      throw new NotFoundException('Scenario not found');
    }
    if (input.prompt !== undefined && !input.prompt.trim()) {
      throw new BadRequestException('prompt cannot be empty');
    }
    return this.prisma.scenario.update({
      where: { id: scenarioId },
      data: {
        title: input.title?.trim(),
        prompt: input.prompt?.trim(),
        testOutput:
          input.testOutput === null ? null : input.testOutput?.trim() || null,
        expectedOutput: input.expectedOutput?.trim(),
        expectedBehavior: input.expectedBehavior,
        evaluationRubric: input.evaluationRubric as
          Prisma.InputJsonValue | undefined,
        riskLevel: input.riskLevel,
        // 사람이 내용을 수정하면 다시 승인하도록 한다.
        status: 'DRAFT',
        reviewedAt: null,
      },
    });
  }

  async deleteScenario(scenarioId: string) {
    const scenario = await this.prisma.scenario.findUnique({
      where: { id: scenarioId },
      select: { id: true },
    });
    if (!scenario) {
      throw new NotFoundException('Scenario not found');
    }
    await this.prisma.scenario.delete({ where: { id: scenarioId } });
    return { id: scenarioId, deleted: true };
  }

  private async requireProject(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    return project;
  }

  private validatePolicy(input: CreatePolicyInput) {
    if (!input?.name?.trim() || !Array.isArray(input.metrics)) {
      throw new BadRequestException('name and metrics are required');
    }
    if (input.metrics.length === 0) {
      throw new BadRequestException('At least one metric is required');
    }
    const weightSum = input.metrics.reduce(
      (sum, metric) => sum + Number(metric.weight),
      0,
    );
    if (Math.abs(weightSum - 1) > 0.001) {
      throw new BadRequestException('Metric weights must add up to 1');
    }
  }

  private normalizeRubric(
    value: Record<string, unknown> | undefined,
    policyMetrics: MetricInput[],
  ): Record<string, unknown> {
    const source = value ?? {};
    if (Array.isArray(source.metrics)) {
      return {
        metrics: source.metrics,
        requiredConditions: Array.isArray(source.requiredConditions)
          ? source.requiredConditions
          : [],
        failConditions: Array.isArray(source.failConditions)
          ? source.failConditions
          : [],
        allowedVariations: Array.isArray(source.allowedVariations)
          ? source.allowedVariations
          : [],
      };
    }

    const metrics = policyMetrics.flatMap((metric) => {
      const rawLevels = source[metric.key];
      if (!Array.isArray(rawLevels)) return [];
      return [
        {
          key: metric.key,
          name: metric.name,
          levels: rawLevels.map((level) => {
            const item = level as Record<string, unknown>;
            const criteria = item.criteria ?? item.description;
            return {
              score: Number(item.score ?? item.level ?? 0),
              criteria: typeof criteria === 'string' ? criteria : '',
            };
          }),
        },
      ];
    });

    return {
      metrics,
      requiredConditions: Array.isArray(source.requiredConditions)
        ? source.requiredConditions
        : [],
      failConditions: Array.isArray(source.failConditions)
        ? source.failConditions
        : [],
      allowedVariations: Array.isArray(source.allowedVariations)
        ? source.allowedVariations
        : [],
    };
  }
}
