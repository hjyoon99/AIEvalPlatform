import { Module } from '@nestjs/common';
import { EvalController } from './eval.controller';
import { EvalService } from './eval.service';
import { JudgeWorkerService } from './judge-worker.service';
import { EvalRepository } from './eval.repository';
import { JudgeWorkerRepository } from './judge-worker.repository';

@Module({
  controllers: [EvalController],
  providers: [
    EvalService,
    JudgeWorkerService,
    EvalRepository,
    JudgeWorkerRepository,
  ],
})
export class EvalModule {}
