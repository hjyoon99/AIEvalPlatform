import {
  Body,
  Controller,
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

  @Post('projects/:projectId/applications')
  createApplication(
    @Param('projectId') projectId: string,
    @Body() input: CreateApplicationInput,
  ) {
    return this.sdkProtocolService.createApplication(projectId, input);
  }

  @Get('projects/:projectId/applications')
  getApplications(@Param('projectId') projectId: string) {
    return this.sdkProtocolService.getApplications(projectId);
  }

  @Post('applications/:applicationId/jobs')
  createJob(
    @Param('applicationId') applicationId: string,
    @Body() input: CreateJobInput,
  ) {
    return this.sdkProtocolService.createJob(applicationId, input);
  }

  @Get('applications/:applicationId/jobs')
  getJobs(@Param('applicationId') applicationId: string) {
    return this.sdkProtocolService.getJobs(applicationId);
  }

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

  private getBearerToken(request: Request) {
    const authorization = request.headers.authorization;
    return authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
  }
}
