import { Prisma } from '@prisma/client';
import type {
  EvalDatasetItemInput,
  StartEvalRunInput,
} from './dto/create-eval-run.dto';

/** 평가 실행 생성에 필요한 필드만 추린 평가 정책 읽기 모델이다. */
export interface EvalPolicyRecord {
  id: string;
  projectId: string;
  name: string;
  passThreshold: number;
  maxRetries: number;
  metrics: Prisma.JsonValue;
}

/** `EvalRepository.createQueuedRun`에 전달되는 파라미터다. */
export interface CreateQueuedRunParams {
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
