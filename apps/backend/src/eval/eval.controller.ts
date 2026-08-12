import {
  Body,
  Controller,
  Delete,
  Get,
  MessageEvent,
  Param,
  Post,
  Sse,
} from '@nestjs/common';
import { fromEventPattern, map, merge, Observable, of, takeWhile } from 'rxjs';
import { switchMap, filter } from 'rxjs/operators';
import { EvalService } from './eval.service';
import { EvalRunEvents } from './eval-run.events';
import type { StartEvalRunInput } from './dto/create-eval-run.dto';

/** 이 상태에 도달하면 더 이상 진행률이 바뀌지 않으므로 SSE 스트림을 닫는다. */
const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
]);

@Controller('eval-runs')
export class EvalController {
  constructor(
    private readonly evalService: EvalService,
    private readonly events: EvalRunEvents,
  ) {}

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
   * 평가 실행의 진행 상태 변경을 Server-Sent Events로 스트리밍한다.
   *
   * 연결 시점에 현재 스냅샷을 먼저 한 번 보내고(폴링 GET과 동일한 응답 모양),
   * 이후 케이스가 완료·실패될 때마다 갱신된 스냅샷을 다시 보낸다. 실행이
   * 종결 상태(COMPLETED/COMPLETED_WITH_ERRORS/FAILED/CANCELLED)에 도달하면
   * 마지막 이벤트를 보낸 뒤 스트림을 스스로 닫는다.
   * @param id - 구독할 평가 실행 식별자
   * @returns 진행 상태 스냅샷을 방출하는 Observable. 존재하지 않는 id면
   *   스트림을 열기 전에 404를 던진다.
   */
  @Sse(':id/events')
  async streamProgress(
    @Param('id') id: string,
  ): Promise<Observable<MessageEvent>> {
    // SSE 헤더가 나가기 전에 존재 여부를 확인해, 없는 id면 평범한 404로 응답한다.
    const initial = await this.evalService.findOne(id);

    const progress$ = fromEventPattern<string>(
      (handler) => this.events.onProgress(handler),
      (_handler, unsubscribe: () => void) => unsubscribe(),
    ).pipe(
      filter((evalRunId) => evalRunId === id),
      switchMap(() => this.evalService.findOne(id)),
    );

    return merge(of(initial), progress$).pipe(
      map((run): MessageEvent => ({ data: run })),
      takeWhile(
        (event) =>
          !TERMINAL_STATUSES.has((event.data as { status: string }).status),
        true,
      ),
    );
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
