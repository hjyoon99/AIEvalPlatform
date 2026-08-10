import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JudgeWorkerRepository } from './judge-worker.repository';

/** Judge 워커 생명주기를 관리하고 처리를 Repository에 위임한다. */
@Injectable()
export class JudgeWorkerService implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly repository: JudgeWorkerRepository) {}

  /**
   * 애플리케이션 시작 시 Judge 작업 폴링을 시작한다.
   * @returns 값을 반환하지 않는다
   */
  onModuleInit() {
    return this.repository.start();
  }

  /**
   * 애플리케이션 종료 시 Judge 작업 폴링을 중지한다.
   * @returns 값을 반환하지 않는다
   */
  onModuleDestroy() {
    return this.repository.stop();
  }

  /**
   * 대기 중인 Judge 작업 하나를 처리한다.
   * @returns 작업을 처리했으면 true, 없으면 false
   */
  runOnce() {
    return this.repository.runOnce();
  }
}
