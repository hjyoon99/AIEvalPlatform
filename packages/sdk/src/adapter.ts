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

  /**
   * 고객 AI 호출 함수를 프로토콜 워커 설정으로 변환해 어댑터를 초기화한다.
   * @param options - 플랫폼 접속 정보와 고객 AI 호출 함수
   */
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

  /**
   * 평가 작업을 계속 조회하고 실행하는 폴링 루프를 시작한다.
   * @returns 어댑터가 중지되어 폴링 루프가 끝나면 이행되는 Promise
   */
  start() {
    return this.worker.start();
  }

  /**
   * 실행 중인 폴링 루프에 중지를 요청한다.
   * @returns 값을 반환하지 않는다
   */
  stop() {
    this.worker.stop();
  }

  /**
   * 대기 중인 평가 작업을 한 번 조회해 가능한 경우 실행한다.
   * @returns 작업을 처리했으면 true, 대기 작업이 없으면 false
   */
  runOnce() {
    return this.worker.runOnce();
  }
}
