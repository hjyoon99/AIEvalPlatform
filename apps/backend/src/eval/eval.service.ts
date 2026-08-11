import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EvalRepository, type EvalPolicyRecord } from './eval.repository';

/** 평가할 단일 질의·응답과 기대 조건 및 채점 기준이다. */
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
  /** 답변 유형 분류(RAG/도구호출/일반)에 쓰이는 부가 정보. 생략 시 "일반" 유형으로 처리된다. */
  metadata?: {
    retrievedDocuments?: unknown[];
    toolCalls?: unknown[];
  };
}

/** 평가 실행 생성 방식, 모델, 정책, 데이터셋을 정의하는 요청 계약이다. */
export interface StartEvalRunInput {
  projectId?: string;
  policyId?: string;
  scenarioIds?: string[];
  applicationId?: string;
  executionMode: 'ADAPTER' | 'PROVIDED_OUTPUT';
  name: string;
  agentName?: string;
  targetModel?: string;
  judgeModel?: string;
  passThreshold?: number;
  maxRetries?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  dataset?: EvalDatasetItemInput[];
}

@Injectable()
export class EvalService {
  constructor(private readonly repository: EvalRepository) {}

  /**
   * 요청 모드에 따라 답변 실행 또는 Judge 작업을 큐에 등록한다.
   * @param input - 실행 방식, 프로젝트, 정책, 모델 및 데이터셋 설정
   * @returns 생성된 평가 실행과 케이스별 진행 정보
   */
  async createAndRun(input: StartEvalRunInput) {
    const policy = input.policyId
      ? await this.repository.findPolicy(input.policyId)
      : null;
    if (input.policyId && !policy) {
      throw new BadRequestException('Evaluation policy not found');
    }
    let dataset = input.dataset;
    if ((!dataset || dataset.length === 0) && input.scenarioIds?.length) {
      const scenarios = await this.repository.findApprovedScenarios(
        input.scenarioIds,
        input.projectId,
      );
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

    return this.createQueuedRun(input, dataset, policy);
  }

  /**
   * 평가 실행 목록에 케이스별 진행 상태 집계를 포함해 반환한다.
   * @returns 최신순 평가 실행과 진행률 목록
   */
  async findAll() {
    const runs = await this.repository.findRuns();
    return runs.map((run) => ({
      ...run,
      progress: this.buildProgress(run.cases),
    }));
  }

  /**
   * 평가 실행의 케이스, 결과, 진행률을 함께 조회한다.
   * @param id - 조회할 평가 실행 식별자
   * @returns 케이스, 결과 및 진행률이 포함된 평가 실행
   */
  async findOne(id: string) {
    const run = await this.repository.findRun(id);

    if (!run) {
      throw new NotFoundException('Evaluation run not found');
    }
    return {
      ...run,
      progress: this.buildProgress(run.cases),
    };
  }

  /**
   * 대기·실행 중이 아닌 평가 실행만 삭제한다.
   * @param id - 삭제할 평가 실행 식별자
   * @returns 삭제된 식별자와 성공 여부
   */
  async remove(id: string) {
    const run = await this.repository.findRunStatus(id);
    if (!run) {
      throw new NotFoundException('Evaluation run not found');
    }
    if (['QUEUED', 'RUNNING'].includes(run.status)) {
      throw new BadRequestException(
        'A queued or running evaluation cannot be deleted',
      );
    }
    await this.repository.deleteRun(id);
    return { id, deleted: true };
  }

  /**
   * 전체 실행 수, 상태 분포, 평균 점수 등 대시보드 요약을 계산한다.
   * @returns 실행·결과 개수, 통과율 및 평균 점수
   */
  async getSummary() {
    const { totalRuns, totalResults, passedResults, averageScore } =
      await this.repository.getSummary();

    return {
      totalRuns,
      totalEvaluations: totalResults,
      averageScore: Number((averageScore ?? 0).toFixed(2)),
      passRate:
        totalResults === 0
          ? 0
          : Number((passedResults / totalResults).toFixed(2)),
    };
  }

  /**
   * 자동화 평가 입력을 검증하고 실행 케이스 및 실행·Judge 작업을 원자적으로 생성한다.
   * @param input - 자동화 평가 실행 설정
   * @param dataset - 평가할 질의·응답 및 채점 기준 목록
   * @param policy - 적용할 평가 정책 또는 null
   * @returns 생성된 평가 실행의 상세 정보
   */
  private async createQueuedRun(
    input: StartEvalRunInput,
    dataset: EvalDatasetItemInput[] | undefined,
    policy: EvalPolicyRecord | null,
  ) {
    this.validateAutomatedInput(input, dataset, policy);
    const cases = dataset!;
    const executionMode = input.executionMode;
    const application =
      executionMode === 'ADAPTER'
        ? await this.repository.findApplication(input.applicationId!)
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

    const judgeModel = input.judgeModel?.trim() || 'qwen3.5:4b';
    const agentPrompts = await this.getProjectAgentPrompts(projectId);
    const timeoutMs = input.timeoutMs ?? 30_000;
    const sdkMaxAttempts = input.maxAttempts ?? 3;
    const judgeMaxAttempts = Math.min(
      Math.max((input.maxRetries ?? policy?.maxRetries ?? 1) + 1, 1),
      3,
    );

    const run = await this.repository.createQueuedRun({
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
    });

    return this.findOne(run.id);
  }

  /**
   * 어댑터/제공 응답 모드의 데이터셋과 실행 제한값을 검증한다.
   * @param input - 검증할 자동화 실행 설정
   * @param dataset - 검증할 평가 데이터셋
   * @param policy - 기준 존재 여부를 확인할 평가 정책
   * @returns 유효하면 값을 반환하지 않는다
   */
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

  /**
   * 프로젝트 JSON 설정에서 유효한 에이전트 프롬프트만 읽어 온다.
   * @param projectId - 프롬프트를 조회할 선택적 프로젝트 식별자
   * @returns 유효한 에이전트 프롬프트 또는 undefined
   */
  private async getProjectAgentPrompts(projectId?: string) {
    if (!projectId) return undefined;
    const project = await this.repository.findProjectAgentPrompts(projectId);
    const value = project?.agentPrompts;
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return undefined;
    }
    const prompts = Object.fromEntries(
      Object.entries(value).filter(
        ([key, prompt]) =>
          ['verifier', 'evaluator', 'supervisor'].includes(key) &&
          typeof prompt === 'string' &&
          prompt.trim(),
      ),
    );
    return Object.keys(prompts).length > 0 ? prompts : undefined;
  }

  /**
   * 모든 실행 방식이 공유하는 통과 임계치와 재시도 횟수 범위를 검사한다.
   * @param input - 공통 실행 설정을 가진 평가 요청
   * @returns 유효하면 값을 반환하지 않는다
   */
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

  /**
   * 케이스 상태 배열을 UI용 진행 단계별 개수로 집계한다.
   * @param cases - 상태를 가진 평가 케이스 목록
   * @returns 전체 개수와 단계별 케이스 개수
   */
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
