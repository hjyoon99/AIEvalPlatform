export { EvaluationAdapter } from './adapter.js';
export { EvaluationWorker } from './worker.js';
export type {
  ClaimedJob,
  EvaluationAdapterOptions,
  EvaluationWorkerOptions,
  ExecutionContext,
  ExecutionError,
  ExecutionResult,
  TestCase,
} from './types.js';

import { EvaluationAdapter } from './adapter.js';
import { EvaluationWorker } from './worker.js';
import type {
  EvaluationAdapterOptions,
  EvaluationWorkerOptions,
} from './types.js';

export function createEvaluationAdapter(options: EvaluationAdapterOptions) {
  return new EvaluationAdapter(options);
}

/**
 * @deprecated 새 연동에서는 createEvaluationAdapter를 사용한다.
 * 기존 Worker 연동의 하위 호환성을 위해 유지한다.
 */
export function createEvaluationWorker(options: EvaluationWorkerOptions) {
  return new EvaluationWorker(options);
}
