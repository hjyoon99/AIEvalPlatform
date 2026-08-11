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
