import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ProjectService } from './project.service';
import type {
  CreatePolicyInput,
  CreateProjectInput,
  CreateScenarioInput,
  GenerateScenariosInput,
  ReviewScenarioInput,
  UpdateScenarioInput,
} from './project.service';

@Controller()
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post('projects')
  createProject(@Body() input: CreateProjectInput) {
    return this.projectService.createProject(input);
  }

  @Get('projects')
  getProjects() {
    return this.projectService.getProjects();
  }

  @Delete('projects/:projectId')
  deleteProject(@Param('projectId') projectId: string) {
    return this.projectService.deleteProject(projectId);
  }

  @Post('projects/:projectId/policies')
  createPolicy(
    @Param('projectId') projectId: string,
    @Body() input: CreatePolicyInput,
  ) {
    return this.projectService.createPolicy(projectId, input);
  }

  @Get('projects/:projectId/policies')
  getPolicies(@Param('projectId') projectId: string) {
    return this.projectService.getPolicies(projectId);
  }

  @Delete('policies/:policyId')
  deletePolicy(@Param('policyId') policyId: string) {
    return this.projectService.deletePolicy(policyId);
  }

  @Post('projects/:projectId/scenarios')
  createScenario(
    @Param('projectId') projectId: string,
    @Body() input: CreateScenarioInput,
  ) {
    return this.projectService.createScenario(projectId, input);
  }

  @Post('projects/:projectId/scenarios/generate')
  generateScenarios(
    @Param('projectId') projectId: string,
    @Body() input: GenerateScenariosInput,
  ) {
    return this.projectService.generateScenarios(projectId, input);
  }

  @Get('projects/:projectId/scenarios')
  getScenarios(@Param('projectId') projectId: string) {
    return this.projectService.getScenarios(projectId);
  }

  @Patch('scenarios/:scenarioId/review')
  reviewScenario(
    @Param('scenarioId') scenarioId: string,
    @Body() input: ReviewScenarioInput,
  ) {
    return this.projectService.reviewScenario(scenarioId, input);
  }

  @Patch('scenarios/:scenarioId')
  updateScenario(
    @Param('scenarioId') scenarioId: string,
    @Body() input: UpdateScenarioInput,
  ) {
    return this.projectService.updateScenario(scenarioId, input);
  }

  @Delete('scenarios/:scenarioId')
  deleteScenario(@Param('scenarioId') scenarioId: string) {
    return this.projectService.deleteScenario(scenarioId);
  }
}
