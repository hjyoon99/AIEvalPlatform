import { Module } from '@nestjs/common';
import { EvalController } from './eval.controller';
import { EvalService } from './eval.service';
import { JudgeWorkerService } from './judge-worker.service';

@Module({
  controllers: [EvalController],
  providers: [EvalService, JudgeWorkerService],
})
export class EvalModule {}
