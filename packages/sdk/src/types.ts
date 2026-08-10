/** 고객 AI에 전달할 질의와 기대 조건 및 시나리오 메타데이터다. */
export interface TestCase {
  id?: string;
  scenarioId?: string;
  prompt: string;
  variables?: Record<string, unknown>;
  expected?: {
    output?: string;
    behavior?: string[];
    requiredConditions?: string[];
    failConditions?: string[];
    allowedVariations?: string[];
  };
  metadata?: {
    category?: string;
    riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
    [key: string]: unknown;
  };
}

/** 플랫폼에서 선점해 SDK가 실행해야 하는 평가 작업이다. */
export interface ClaimedJob {
  id: string;
  attempt: number;
  timeoutMs: number;
  leaseId: string;
  leaseExpiresAt: string;
  testCase: TestCase;
}

/** 고객 AI 호출 중 작업 식별, 시도 횟수, 제한 시간을 제공하는 실행 문맥이다. */
export interface ExecutionContext {
  jobId: string;
  attempt: number;
  timeoutMs: number;
  signal: AbortSignal;
}

/** 고객 AI가 생성한 응답과 선택적인 관측 메타데이터다. */
export interface ExecutionResult {
  output: string;
  metadata?: {
    model?: string;
    modelVersion?: string;
    latencyMs?: number;
    tokenUsage?: {
      input?: number;
      output?: number;
    };
    retrievedDocuments?: unknown[];
    toolCalls?: unknown[];
    traceId?: string;
    [key: string]: unknown;
  };
}

/** 작업 실패를 플랫폼에 보고하기 위한 구조화된 오류다. */
export interface ExecutionError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

/** 저수준 프로토콜 워커의 접속 정보, 실행 함수 및 폴링 설정이다. */
export interface EvaluationWorkerOptions {
  baseUrl: string;
  sdkKey: string;
  /**
   * 선점된 테스트 케이스를 고객 AI에서 실행한다.
   * @param testCase - 고객 AI에 전달할 평가 테스트 케이스
   * @param context - 작업 및 취소 신호가 포함된 실행 문맥
   * @returns 고객 AI의 출력과 선택적 실행 메타데이터
   */
  execute(
    testCase: TestCase,
    context: ExecutionContext,
  ): Promise<ExecutionResult>;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

/** 고객 중심 용어로 구성한 평가 어댑터의 접속 및 호출 설정이다. */
export interface EvaluationAdapterOptions {
  baseUrl: string;
  sdkKey: string;
  /**
   * 평가 테스트 케이스로 고객 AI를 호출한다.
   * @param testCase - 고객 AI에 전달할 평가 테스트 케이스
   * @param context - 작업 및 취소 신호가 포함된 실행 문맥
   * @returns 고객 AI의 출력과 선택적 실행 메타데이터
   */
  invoke(
    testCase: TestCase,
    context: ExecutionContext,
  ): Promise<ExecutionResult>;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}
