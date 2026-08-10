import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';

/** 프로젝트, 정책, 시나리오 영속화를 전담한다. */
@Injectable()
export class ProjectRepository {
  constructor(private readonly prisma: PrismaService) {}

  createProject(data: Prisma.ProjectCreateInput) {
    return this.prisma.project.create({ data });
  }

  findProjects() {
    return this.prisma.project.findMany({
      include: {
        _count: {
          select: { policies: true, scenarios: true, evalRuns: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  findProject(projectId: string) {
    return this.prisma.project.findUnique({ where: { id: projectId } });
  }

  updateAgentPrompts(projectId: string, agentPrompts: Prisma.InputJsonValue) {
    return this.prisma.project.update({
      where: { id: projectId },
      data: { agentPrompts },
    });
  }

  countActiveRuns(projectId: string) {
    return this.prisma.evalRun.count({
      where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
  }

  deleteProject(projectId: string) {
    return this.prisma.project.delete({ where: { id: projectId } });
  }

  createPolicy(data: Prisma.EvaluationPolicyUncheckedCreateInput) {
    return this.prisma.evaluationPolicy.create({ data });
  }

  findPolicies(projectId: string) {
    return this.prisma.evaluationPolicy.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  findPolicy(policyId: string) {
    return this.prisma.evaluationPolicy.findUnique({
      where: { id: policyId },
      select: { id: true },
    });
  }

  findPolicyForGeneration(projectId: string, policyId?: string) {
    return policyId
      ? this.prisma.evaluationPolicy.findFirst({
          where: { id: policyId, projectId },
        })
      : this.prisma.evaluationPolicy.findFirst({
          where: { projectId },
          orderBy: { createdAt: 'desc' },
        });
  }

  deletePolicy(policyId: string) {
    return this.prisma.evaluationPolicy.delete({ where: { id: policyId } });
  }

  createScenario(data: Prisma.ScenarioUncheckedCreateInput) {
    return this.prisma.scenario.create({ data });
  }

  createScenarios(data: Prisma.ScenarioCreateManyInput[]) {
    return this.prisma.scenario.createMany({ data });
  }

  findScenarios(projectId: string) {
    return this.prisma.scenario.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  reviewScenario(scenarioId: string, data: Prisma.ScenarioUpdateInput) {
    return this.prisma.scenario.update({ where: { id: scenarioId }, data });
  }

  findScenario(scenarioId: string) {
    return this.prisma.scenario.findUnique({ where: { id: scenarioId } });
  }

  updateScenario(scenarioId: string, data: Prisma.ScenarioUpdateInput) {
    return this.prisma.scenario.update({ where: { id: scenarioId }, data });
  }

  deleteScenario(scenarioId: string) {
    return this.prisma.scenario.delete({ where: { id: scenarioId } });
  }
}
