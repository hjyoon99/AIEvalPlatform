import { EvaluationWorker } from './worker.js';
import type {
  EvaluationAdapterOptions,
  EvaluationWorkerOptions,
} from './types.js';

/**
 * 고객 AI와 평가 플랫폼 사이에서 별도 프로세스로 실행되는 어댑터다.
 *
 * 프로토콜 실행은 EvaluationWorker에 위임하고, 고객별 코드는 invoke에만
 * 남도록 공개 API의 용어를 어댑터 역할에 맞춘다.
 */
export class EvaluationAdapter {
  private readonly worker: EvaluationWorker;

  constructor(options: EvaluationAdapterOptions) {
    const workerOptions: EvaluationWorkerOptions = {
      baseUrl: options.baseUrl,
      sdkKey: options.sdkKey,
      pollIntervalMs: options.pollIntervalMs,
      onError: options.onError,
      execute: options.invoke,
    };
    this.worker = new EvaluationWorker(workerOptions);
  }

  start() {
    return this.worker.start();
  }

  stop() {
    this.worker.stop();
  }

  runOnce() {
    return this.worker.runOnce();
  }
}
