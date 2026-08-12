import { Module } from '@nestjs/common';
import { EvalController } from './eval.controller';
import { EvalService } from './eval.service';
import { JudgeWorkerService } from './judge-worker.service';
import { EvalRepository } from './eval.repository';
import { JudgeWorkerRepository } from './judge-worker.repository';
import { EvalRunEvents } from './eval-run.events';

@Module({
  controllers: [EvalController],
  providers: [
    EvalService,
    JudgeWorkerService,
    EvalRepository,
    JudgeWorkerRepository,
    EvalRunEvents,
  ],
})
export class EvalModule {}
