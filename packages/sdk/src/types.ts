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

export interface ClaimedJob {
  id: string;
  attempt: number;
  timeoutMs: number;
  leaseId: string;
  leaseExpiresAt: string;
  testCase: TestCase;
}

export interface ExecutionContext {
  jobId: string;
  attempt: number;
  timeoutMs: number;
  signal: AbortSignal;
}

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

export interface ExecutionError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface EvaluationWorkerOptions {
  baseUrl: string;
  sdkKey: string;
  execute(
    testCase: TestCase,
    context: ExecutionContext,
  ): Promise<ExecutionResult>;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface EvaluationAdapterOptions {
  baseUrl: string;
  sdkKey: string;
  invoke(
    testCase: TestCase,
    context: ExecutionContext,
  ): Promise<ExecutionResult>;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}
