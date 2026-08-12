import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

/**
 * EvalRun 진행 상태 변경을 같은 프로세스 안의 구독자(SSE 컨트롤러)에게
 * 알리는 경량 이벤트 버스다. Judge Worker가 별도 프로세스로 독립 배포되면
 * 이 구현은 Postgres LISTEN/NOTIFY 또는 Redis pub/sub으로 교체되어야 한다.
 */
@Injectable()
export class EvalRunEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // 워커 동시성이 늘어나면 짧은 시간에 여러 케이스가 동시 완료되며
    // 다수의 SSE 구독자가 몰릴 수 있어 기본 리스너 상한을 넉넉히 둔다.
    this.emitter.setMaxListeners(100);
  }

  /**
   * 지정된 평가 실행의 진행 상태가 바뀌었음을 구독자에게 알린다.
   * @param evalRunId - 상태가 변경된 평가 실행 식별자
   * @returns 값을 반환하지 않는다
   */
  emitProgress(evalRunId: string) {
    this.emitter.emit('progress', evalRunId);
  }

  /**
   * 진행 상태 변경 이벤트를 구독한다.
   * @param listener - 평가 실행 식별자를 받는 콜백
   * @returns 호출 시 구독을 해지하는 함수
   */
  onProgress(listener: (evalRunId: string) => void): () => void {
    this.emitter.on('progress', listener);
    return () => this.emitter.off('progress', listener);
  }
}
