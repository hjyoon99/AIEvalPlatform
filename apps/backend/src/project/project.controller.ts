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
  AgentPromptsInput,
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

  /**
   * 새 평가 프로젝트를 생성한다.
   * @param input - 프로젝트 이름, 도메인 및 선택적 문맥 정보
   * @returns 생성된 프로젝트 정보
   */
  @Post('projects')
  createProject(@Body() input: CreateProjectInput) {
    return this.projectService.createProject(input);
  }

  /**
   * 프로젝트 목록과 각 프로젝트의 자원 개수를 조회한다.
   * @returns 관련 자원 개수가 포함된 프로젝트 목록
   */
  @Get('projects')
  getProjects() {
    return this.projectService.getProjects();
  }

  /**
   * 프로젝트에 적용되는 평가 에이전트 프롬프트를 조회한다.
   * @param projectId - 조회할 프로젝트 식별자
   * @returns 기본값과 저장값이 병합된 에이전트별 프롬프트
   */
  @Get('projects/:projectId/agent-prompts')
  getAgentPrompts(@Param('projectId') projectId: string) {
    return this.projectService.getAgentPrompts(projectId);
  }

  /**
   * 프로젝트의 평가 에이전트 프롬프트를 검증해 저장한다.
   * @param projectId - 프롬프트를 변경할 프로젝트 식별자
   * @param input - 검증·평가·감독 에이전트의 프롬프트
   * @returns 정규화되어 저장된 에이전트별 프롬프트
   */
  @Patch('projects/:projectId/agent-prompts')
  updateAgentPrompts(
    @Param('projectId') projectId: string,
    @Body() input: AgentPromptsInput,
  ) {
    return this.projectService.updateAgentPrompts(projectId, input);
  }

  /**
   * 활성 평가가 없는 프로젝트를 삭제한다.
   * @param projectId - 삭제할 프로젝트 식별자
   * @returns 삭제된 프로젝트 식별자와 삭제 성공 여부
   */
  @Delete('projects/:projectId')
  deleteProject(@Param('projectId') projectId: string) {
    return this.projectService.deleteProject(projectId);
  }

  /**
   * 프로젝트에 평가 정책을 추가한다.
   * @param projectId - 정책을 추가할 프로젝트 식별자
   * @param input - 정책 이름, 판정 기준, 재시도 및 평가 지표
   * @returns 생성된 평가 정책 정보
   */
  @Post('projects/:projectId/policies')
  createPolicy(
    @Param('projectId') projectId: string,
    @Body() input: CreatePolicyInput,
  ) {
    return this.projectService.createPolicy(projectId, input);
  }

  /**
   * 프로젝트의 평가 정책 목록을 조회한다.
   * @param projectId - 정책을 조회할 프로젝트 식별자
   * @returns 프로젝트의 평가 정책 목록
   */
  @Get('projects/:projectId/policies')
  getPolicies(@Param('projectId') projectId: string) {
    return this.projectService.getPolicies(projectId);
  }

  /**
   * 지정한 평가 정책을 삭제한다.
   * @param policyId - 삭제할 평가 정책 식별자
   * @returns 삭제된 정책 식별자와 삭제 성공 여부
   */
  @Delete('policies/:policyId')
  deletePolicy(@Param('policyId') policyId: string) {
    return this.projectService.deletePolicy(policyId);
  }

  /**
   * 프로젝트에 수동 테스트 시나리오를 추가한다.
   * @param projectId - 시나리오를 추가할 프로젝트 식별자
   * @param input - 테스트 입력, 기대 결과 및 평가 기준
   * @returns 생성된 테스트 시나리오 정보
   */
  @Post('projects/:projectId/scenarios')
  createScenario(
    @Param('projectId') projectId: string,
    @Body() input: CreateScenarioInput,
  ) {
    return this.projectService.createScenario(projectId, input);
  }

  /**
   * Agent Engine을 이용해 프로젝트용 테스트 시나리오를 생성한다.
   * @param projectId - 시나리오를 생성할 프로젝트 식별자
   * @param input - 적용 정책, 생성 개수 및 모델 설정
   * @returns 생성되어 저장된 테스트 시나리오 목록
   */
  @Post('projects/:projectId/scenarios/generate')
  generateScenarios(
    @Param('projectId') projectId: string,
    @Body() input: GenerateScenariosInput,
  ) {
    return this.projectService.generateScenarios(projectId, input);
  }

  /**
   * 프로젝트의 테스트 시나리오 목록을 조회한다.
   * @param projectId - 시나리오를 조회할 프로젝트 식별자
   * @returns 프로젝트의 테스트 시나리오 목록
   */
  @Get('projects/:projectId/scenarios')
  getScenarios(@Param('projectId') projectId: string) {
    return this.projectService.getScenarios(projectId);
  }

  /**
   * 생성된 시나리오의 승인 또는 반려 상태를 기록한다.
   * @param scenarioId - 검수할 시나리오 식별자
   * @param input - 승인·반려 상태와 선택적 반려 사유
   * @returns 검수 상태가 반영된 시나리오 정보
   */
  @Patch('scenarios/:scenarioId/review')
  reviewScenario(
    @Param('scenarioId') scenarioId: string,
    @Body() input: ReviewScenarioInput,
  ) {
    return this.projectService.reviewScenario(scenarioId, input);
  }

  /**
   * 시나리오의 편집 가능한 내용을 갱신한다.
   * @param scenarioId - 수정할 시나리오 식별자
   * @param input - 부분 변경할 시나리오 필드
   * @returns 수정된 시나리오 정보
   */
  @Patch('scenarios/:scenarioId')
  updateScenario(
    @Param('scenarioId') scenarioId: string,
    @Body() input: UpdateScenarioInput,
  ) {
    return this.projectService.updateScenario(scenarioId, input);
  }

  /**
   * 지정한 테스트 시나리오를 삭제한다.
   * @param scenarioId - 삭제할 시나리오 식별자
   * @returns 삭제된 시나리오 식별자와 삭제 성공 여부
   */
  @Delete('scenarios/:scenarioId')
  deleteScenario(@Param('scenarioId') scenarioId: string) {
    return this.projectService.deleteScenario(scenarioId);
  }
}
