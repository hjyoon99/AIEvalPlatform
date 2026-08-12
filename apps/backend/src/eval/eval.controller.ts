import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { EvalService } from './eval.service';
import type { StartEvalRunInput } from './dto/create-eval-run.dto';

@Controller('eval-runs')
export class EvalController {
  constructor(private readonly evalService: EvalService) {}

  /**
   * 평가 실행을 생성하고 요청 방식에 맞춰 즉시 실행하거나 큐에 등록한다.
   * @param input - 평가 실행 방식, 모델, 정책 및 데이터셋 정보
   * @returns 생성되어 실행 또는 큐 등록된 평가 실행 정보
   */
  @Post()
  create(@Body() input: StartEvalRunInput) {
    return this.evalService.createAndRun(input);
  }

  /**
   * 최근 평가 실행 목록과 집계 정보를 조회한다.
   * @returns 진행 상태가 포함된 평가 실행 목록
   */
  @Get()
  findAll() {
    return this.evalService.findAll();
  }

  /**
   * 전체 평가 실행의 상태 및 점수 요약을 반환한다.
   * @returns 전체 실행 및 결과의 집계 정보
   */
  @Get('summary')
  getSummary() {
    return this.evalService.getSummary();
  }

  /**
   * 식별자에 해당하는 평가 실행과 세부 결과를 조회한다.
   * @param id - 조회할 평가 실행 식별자
   * @returns 평가 케이스, 결과 및 진행률이 포함된 실행 정보
   */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.evalService.findOne(id);
  }

  /**
   * 진행 중이지 않은 평가 실행을 삭제한다.
   * @param id - 삭제할 평가 실행 식별자
   * @returns 삭제된 실행 식별자와 삭제 성공 여부
   */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.evalService.remove(id);
  }
}
