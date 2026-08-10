import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SdkProtocolService } from './sdk-protocol.service';
import type {
  CompleteJobInput,
  CreateApplicationInput,
  CreateJobInput,
  FailJobInput,
  LeaseInput,
} from './sdk-protocol.service';

@Controller()
export class SdkProtocolController {
  constructor(private readonly sdkProtocolService: SdkProtocolService) {}

  /**
   * 프로젝트에 연결할 SDK 애플리케이션과 인증 키를 생성한다.
   * @param projectId - 애플리케이션을 연결할 프로젝트 식별자
   * @param input - 애플리케이션 이름과 설명
   * @returns 생성된 애플리케이션과 최초 한 번 노출되는 SDK 키
   */
  @Post('projects/:projectId/applications')
  createApplication(
    @Param('projectId') projectId: string,
    @Body() input: CreateApplicationInput,
  ) {
    return this.sdkProtocolService.createApplication(projectId, input);
  }

  /**
   * 프로젝트의 SDK 애플리케이션 목록을 조회한다.
   * @param projectId - 애플리케이션을 조회할 프로젝트 식별자
   * @returns 작업 개수가 포함된 SDK 애플리케이션 목록
   */
  @Get('projects/:projectId/applications')
  getApplications(@Param('projectId') projectId: string) {
    return this.sdkProtocolService.getApplications(projectId);
  }

  /**
   * 활성 작업이 없는 SDK 애플리케이션을 삭제한다.
   * @param applicationId - 삭제할 애플리케이션 식별자
   * @returns 삭제된 식별자와 성공 여부
   */
  @Delete('applications/:applicationId')
  deleteApplication(@Param('applicationId') applicationId: string) {
    return this.sdkProtocolService.deleteApplication(applicationId);
  }

  /**
   * 애플리케이션이 실행할 새 SDK 작업을 등록한다.
   * @param applicationId - 작업을 연결할 애플리케이션 식별자
   * @param input - 테스트 케이스와 실행 제한 설정
   * @returns 생성된 SDK 작업
   */
  @Post('applications/:applicationId/jobs')
  createJob(
    @Param('applicationId') applicationId: string,
    @Body() input: CreateJobInput,
  ) {
    return this.sdkProtocolService.createJob(applicationId, input);
  }

  /**
   * 애플리케이션의 SDK 작업과 현재 상태를 조회한다.
   * @param applicationId - 작업을 조회할 애플리케이션 식별자
   * @returns 애플리케이션의 최신순 SDK 작업 목록
   */
  @Get('applications/:applicationId/jobs')
  getJobs(@Param('applicationId') applicationId: string) {
    return this.sdkProtocolService.getJobs(applicationId);
  }

  /**
   * 인증된 SDK가 처리할 수 있는 다음 작업을 선점한다.
   * @param request - Bearer SDK 키가 포함된 HTTP 요청
   * @param response - 작업 부재 시 상태 코드를 설정할 HTTP 응답
   * @returns 선점된 작업 객체 또는 작업이 없으면 본문 없이 반환
   */
  @Post('sdk/v1/jobs/claim')
  @HttpCode(200)
  async claimJob(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const job = await this.sdkProtocolService.claimJob(
      this.getBearerToken(request),
    );
    if (!job) {
      response.status(204);
      return;
    }
    return { job };
  }

  /**
   * 선점한 작업의 리스를 검증하고 실행 상태로 전환한다.
   * @param jobId - 시작할 SDK 작업 식별자
   * @param request - Bearer SDK 키가 포함된 HTTP 요청
   * @param input - 소유권을 증명하는 리스 식별자
   * @returns 실행 상태로 전환된 작업 정보
   */
  @Post('sdk/v1/jobs/:jobId/start')
  startJob(
    @Param('jobId') jobId: string,
    @Req() request: Request,
    @Body() input: LeaseInput,
  ) {
    return this.sdkProtocolService.startJob(
      this.getBearerToken(request),
      jobId,
      input,
    );
  }

  /**
   * 실행 결과를 멱등하게 제출하고 후속 Judge 작업을 생성한다.
   * @param jobId - 완료할 SDK 작업 식별자
   * @param request - Bearer SDK 키가 포함된 HTTP 요청
   * @param idempotencyKey - 중복 완료 요청을 식별하는 키
   * @param input - 리스, 실행 출력 및 선택적 메타데이터
   * @returns 완료 처리된 SDK 작업 정보
   */
  @Post('sdk/v1/jobs/:jobId/complete')
  completeJob(
    @Param('jobId') jobId: string,
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CompleteJobInput,
  ) {
    return this.sdkProtocolService.completeJob(
      this.getBearerToken(request),
      jobId,
      idempotencyKey,
      input,
    );
  }

  /**
   * SDK 작업 실패를 기록하고 필요하면 재시도 대기 상태로 돌린다.
   * @param jobId - 실패 처리할 SDK 작업 식별자
   * @param request - Bearer SDK 키가 포함된 HTTP 요청
   * @param input - 리스와 구조화된 실행 오류
   * @returns 재시도 또는 실패 상태가 반영된 작업 정보
   */
  @Post('sdk/v1/jobs/:jobId/fail')
  failJob(
    @Param('jobId') jobId: string,
    @Req() request: Request,
    @Body() input: FailJobInput,
  ) {
    return this.sdkProtocolService.failJob(
      this.getBearerToken(request),
      jobId,
      input,
    );
  }

  /**
   * Authorization 헤더에서 Bearer 인증 토큰을 추출한다.
   * @param request - Authorization 헤더를 가진 HTTP 요청
   * @returns Bearer 토큰 문자열 또는 빈 문자열
   */
  private getBearerToken(request: Request) {
    const authorization = request.headers.authorization;
    return authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
  }
}
