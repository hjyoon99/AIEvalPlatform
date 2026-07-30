import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { EvalService } from './eval.service';
import type { StartEvalRunInput } from './eval.service';

@Controller('eval-runs')
export class EvalController {
  constructor(private readonly evalService: EvalService) {}

  @Post()
  create(@Body() input: StartEvalRunInput) {
    return this.evalService.createAndRun(input);
  }

  @Get()
  findAll() {
    return this.evalService.findAll();
  }

  @Get('summary')
  getSummary() {
    return this.evalService.getSummary();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.evalService.findOne(id);
  }
}
