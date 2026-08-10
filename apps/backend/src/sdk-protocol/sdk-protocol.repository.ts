import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type AIApplication, type SdkJob } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';

/** SDK 애플리케이션 생성 시 사용할 이름과 설명이다. */
export interface CreateApplicationInput {
  name: string;
  environment?: string;
}

/** 독립 SDK 작업의 테스트 케이스와 실행 제한 설정이다. */
export interface CreateJobInput {
  testCase: Record<string, unknown>;
  timeoutMs?: number;
  maxAttempts?: number;
}

/** 선점된 작업을 변경할 때 소유권을 증명하는 리스 식별자다. */
export interface LeaseInput {
  leaseId: string;
}

/** SDK 실행 완료 시 제출하는 출력과 선택적 메타데이터다. */
export interface CompleteJobInput extends LeaseInput {
  output: string;
  metadata?: Record<string, unknown>;
}

/** SDK 실행 실패 시 제출하는 구조화된 오류 정보다. */
export interface FailJobInput extends LeaseInput {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

@Injectable()
export class SdkProtocolRepository {
  private readonly minimumLeaseDurationMs = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 프로젝트 존재 여부를 확인하고 해시된 SDK 키를 가진 애플리케이션을 만든다.
   * @param projectId - 연결할 프로젝트 식별자
   * @param input - 애플리케이션 이름과 선택적 설명
   * @returns 생성된 애플리케이션과 원본 SDK 키
   */
  async createApplication(projectId: string, input: CreateApplicationInput) {
    if (!input?.name?.trim()) {
      throw new BadRequestException('application name is required');
    }
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const sdkKey = `aieval_${randomBytes(24).toString('base64url')}`;
    const application = await this.prisma.aIApplication.create({
      data: {
        projectId,
        name: input.name.trim(),
        environment: input.environment?.trim() || 'development',
        sdkKeyHash: this.hashKey(sdkKey),
      },
      select: this.applicationSelect,
    });

    return { application, sdkKey };
  }

  /**
   * SDK 키 원문을 제외한 프로젝트 애플리케이션 목록과 작업 수를 반환한다.
   * @param projectId - 애플리케이션을 조회할 프로젝트 식별자
   * @returns 애플리케이션과 관련 작업 개수 목록
   */
  getApplications(projectId: string) {
    return this.prisma.aIApplication.findMany({
      where: { projectId },
      select: {
        ...this.applicationSelect,
        _count: {
          select: { jobs: true },
        },
        jobs: {
          select: {
            status: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 진행 중 작업이 없는 애플리케이션만 삭제한다.
   * @param applicationId - 삭제할 애플리케이션 식별자
   * @returns 삭제된 식별자와 성공 여부
   */
  async deleteApplication(applicationId: string) {
    const application = await this.prisma.aIApplication.findUnique({
      where: { id: applicationId },
      select: { id: true },
    });
    if (!application) {
      throw new NotFoundException('AI application not found');
    }
    const activeJobs = await this.prisma.sdkJob.count({
      where: {
        applicationId,
        status: { in: ['PENDING', 'CLAIMED', 'RUNNING'] },
        evalRunCaseId: { not: null },
      },
    });
    if (activeJobs > 0) {
      throw new ConflictException(
        'An application with active evaluation jobs cannot be deleted',
      );
    }
    await this.prisma.aIApplication.delete({
      where: { id: applicationId },
    });
    return { id: applicationId, deleted: true };
  }

  /**
   * 테스트 케이스와 제한값을 검증해 독립 실행 SDK 작업을 생성한다.
   * @param applicationId - 작업을 연결할 애플리케이션 식별자
   * @param input - 테스트 케이스, 제한 시간 및 최대 시도 횟수
   * @returns 생성된 대기 상태의 SDK 작업
   */
  async createJob(applicationId: string, input: CreateJobInput) {
    if (!input?.testCase || typeof input.testCase !== 'object') {
      throw new BadRequestException('testCase is required');
    }
    const timeoutMs = input.timeoutMs ?? 30_000;
    const maxAttempts = input.maxAttempts ?? 3;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 300_000
    ) {
      throw new BadRequestException(
        'timeoutMs must be an integer from 1000 to 300000',
      );
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      throw new BadRequestException(
        'maxAttempts must be an integer from 1 to 5',
      );
    }

    const application = await this.prisma.aIApplication.findUnique({
      where: { id: applicationId },
      select: { id: true, active: true },
    });
    if (!application?.active) {
      throw new NotFoundException('Active AI application not found');
    }

    return this.prisma.sdkJob.create({
      data: {
        applicationId,
        testCase: input.testCase as Prisma.InputJsonValue,
        timeoutMs,
        maxAttempts,
      },
    });
  }

  /**
   * 애플리케이션 존재 여부를 확인하고 작업 목록을 최신순으로 반환한다.
   * @param applicationId - 작업을 조회할 애플리케이션 식별자
   * @returns 최신순 SDK 작업 목록
   */
  async getJobs(applicationId: string) {
    const application = await this.prisma.aIApplication.findUnique({
      where: { id: applicationId },
      select: { id: true },
    });
    if (!application) {
      throw new NotFoundException('AI application not found');
    }

    return this.prisma.sdkJob.findMany({
      where: { applicationId },
      select: {
        id: true,
        applicationId: true,
        testCase: true,
        status: true,
        attempt: true,
        maxAttempts: true,
        timeoutMs: true,
        output: true,
        error: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * SDK를 인증하고 만료 작업을 회수한 뒤 실행 가능한 작업 하나를 선점한다.
   * @param sdkKey - 애플리케이션 인증에 사용할 원본 SDK 키
   * @returns 클라이언트용 선점 작업 또는 대기 작업이 없으면 null
   */
  async claimJob(sdkKey: string) {
    const application = await this.authenticate(sdkKey);
    const now = new Date();

    return this.prisma.$transaction(async (transaction) => {
      const expiredJobs = await transaction.sdkJob.findMany({
        where: {
          applicationId: application.id,
          status: { in: ['CLAIMED', 'RUNNING'] },
          leaseExpiresAt: { lt: now },
        },
        select: { evalRunCaseId: true },
      });
      await transaction.sdkJob.updateMany({
        where: {
          applicationId: application.id,
          status: { in: ['CLAIMED', 'RUNNING'] },
          leaseExpiresAt: { lt: now },
        },
        data: {
          status: 'PENDING',
          leaseId: null,
          leaseExpiresAt: null,
          startedAt: null,
        },
      });
      const expiredCaseIds = expiredJobs.flatMap((job) =>
        job.evalRunCaseId ? [job.evalRunCaseId] : [],
      );
      if (expiredCaseIds.length > 0) {
        await transaction.evalRunCase.updateMany({
          where: { id: { in: expiredCaseIds } },
          data: {
            status: 'WAITING_FOR_EXECUTION',
            executionStartedAt: null,
          },
        });
      }

      let candidate: SdkJob | null = null;
      while (!candidate) {
        const next = await transaction.sdkJob.findFirst({
          where: {
            applicationId: application.id,
            status: 'PENDING',
          },
          orderBy: { createdAt: 'asc' },
        });
        if (!next) {
          return null;
        }
        if (next.attempt >= next.maxAttempts) {
          await transaction.sdkJob.update({
            where: { id: next.id },
            data: {
              status: 'FAILED',
              completedAt: now,
              error: {
                code: 'MAX_ATTEMPTS_EXCEEDED',
                message: 'Maximum execution attempts exceeded',
                retryable: false,
              },
            },
          });
          if (next.evalRunCaseId) {
            const failedCase = await transaction.evalRunCase.update({
              where: { id: next.evalRunCaseId },
              data: {
                status: 'EXECUTION_FAILED',
                executionError: {
                  code: 'MAX_ATTEMPTS_EXCEEDED',
                  message: 'Maximum execution attempts exceeded',
                  retryable: false,
                },
                completedAt: now,
              },
              select: { evalRunId: true },
            });
            await this.refreshExecutionFailureSummary(
              transaction,
              failedCase.evalRunId,
              now,
            );
          }
          continue;
        }
        candidate = next;
      }

      const leaseId = randomUUID();
      const leaseDurationMs = Math.max(
        this.minimumLeaseDurationMs,
        candidate.timeoutMs + 30_000,
      );
      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
      const claimed = await transaction.sdkJob.updateMany({
        where: {
          id: candidate.id,
          status: 'PENDING',
        },
        data: {
          status: 'CLAIMED',
          attempt: { increment: 1 },
          leaseId,
          leaseExpiresAt,
        },
      });
      if (claimed.count !== 1) {
        return null;
      }

      const job = await transaction.sdkJob.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      return this.toClaimedJob(job);
    });
  }

  /**
   * 유효한 리스를 가진 선점 작업을 실행 중 상태로 전환한다.
   * @param sdkKey - 애플리케이션 인증에 사용할 SDK 키
   * @param jobId - 시작할 작업 식별자
   * @param input - 작업 소유권을 증명하는 리스 정보
   * @returns 실행 상태와 시작 시각이 반영된 작업
   */
  async startJob(sdkKey: string, jobId: string, input: LeaseInput) {
    const application = await this.authenticate(sdkKey);
    const job = await this.requireLeasedJob(application, jobId, input.leaseId);
    if (job.status === 'RUNNING') {
      return { status: job.status };
    }
    if (job.status !== 'CLAIMED') {
      throw new ConflictException(`job cannot start from ${job.status}`);
    }
    const startedAt = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const started = await transaction.sdkJob.update({
        where: { id: job.id },
        data: { status: 'RUNNING', startedAt },
        select: { id: true, status: true, startedAt: true },
      });
      if (job.evalRunCaseId) {
        const runCase = await transaction.evalRunCase.update({
          where: { id: job.evalRunCaseId },
          data: {
            status: 'EXECUTING',
            executionStartedAt: startedAt,
            executionError: Prisma.DbNull,
          },
          select: { evalRunId: true },
        });
        await transaction.evalRun.updateMany({
          where: { id: runCase.evalRunId, status: 'QUEUED' },
          data: { status: 'RUNNING', startedAt },
        });
      }
      return started;
    });
  }

  /**
   * SDK 출력을 멱등하게 저장하고 연결된 평가 케이스를 Judge 대기로 넘긴다.
   * @param sdkKey - 애플리케이션 인증에 사용할 SDK 키
   * @param jobId - 완료할 작업 식별자
   * @param idempotencyKey - 중복 완료 요청을 판별할 고유 키
   * @param input - 리스, 출력 및 선택적 실행 메타데이터
   * @returns 완료된 작업 또는 동일 요청으로 이미 완료된 작업
   */
  async completeJob(
    sdkKey: string,
    jobId: string,
    idempotencyKey: string | undefined,
    input: CompleteJobInput,
  ) {
    const application = await this.authenticate(sdkKey);
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    if (!input?.output || typeof input.output !== 'string') {
      throw new BadRequestException('output is required');
    }

    const existing = await this.prisma.sdkJob.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true, completedAt: true },
    });
    if (existing) {
      if (existing.id !== jobId) {
        throw new ConflictException('Idempotency-Key is already in use');
      }
      return existing;
    }

    const job = await this.requireLeasedJob(application, jobId, input.leaseId);
    if (job.status !== 'RUNNING') {
      throw new ConflictException(`job cannot complete from ${job.status}`);
    }

    const completedAt = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const completed = await transaction.sdkJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          idempotencyKey,
          output: {
            text: input.output,
            metadata: input.metadata ?? {},
          } as Prisma.InputJsonValue,
          completedAt,
          leaseId: null,
          leaseExpiresAt: null,
        },
        select: { id: true, status: true, completedAt: true },
      });

      if (job.evalRunCaseId) {
        const runCase = await transaction.evalRunCase.update({
          where: { id: job.evalRunCaseId },
          data: {
            status: 'WAITING_FOR_JUDGE',
            outputAnswer: input.output,
            executionMetadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
            executionError: Prisma.DbNull,
            answerCompletedAt: completedAt,
          },
          select: {
            evalRun: {
              select: { maxRetries: true },
            },
          },
        });
        await transaction.judgeJob.upsert({
          where: { evalRunCaseId: job.evalRunCaseId },
          update: {},
          create: {
            evalRunCaseId: job.evalRunCaseId,
            maxAttempts: Math.min(
              Math.max(runCase.evalRun.maxRetries + 1, 1),
              3,
            ),
          },
        });
      }

      return completed;
    });
  }

  /**
   * 실행 오류를 기록하고 재시도 정책에 따라 작업을 재큐잉하거나 실패로 확정한다.
   * @param sdkKey - 애플리케이션 인증에 사용할 SDK 키
   * @param jobId - 실패 처리할 작업 식별자
   * @param input - 리스와 오류 코드·메시지·재시도 가능 여부
   * @returns 재시도 또는 최종 실패 상태가 반영된 작업
   */
  async failJob(sdkKey: string, jobId: string, input: FailJobInput) {
    const application = await this.authenticate(sdkKey);
    if (!input?.error?.code || !input.error.message) {
      throw new BadRequestException('error code and message are required');
    }
    const job = await this.requireLeasedJob(application, jobId, input.leaseId);
    if (!['CLAIMED', 'RUNNING'].includes(job.status)) {
      throw new ConflictException(`job cannot fail from ${job.status}`);
    }

    const shouldRetry =
      input.error.retryable === true && job.attempt < job.maxAttempts;
    const failedAt = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const failed = await transaction.sdkJob.update({
        where: { id: job.id },
        data: {
          status: shouldRetry ? 'PENDING' : 'FAILED',
          error: input.error as Prisma.InputJsonValue,
          completedAt: shouldRetry ? null : failedAt,
          startedAt: shouldRetry ? null : job.startedAt,
          leaseId: null,
          leaseExpiresAt: null,
        },
        select: {
          id: true,
          status: true,
          attempt: true,
          maxAttempts: true,
          completedAt: true,
        },
      });

      if (job.evalRunCaseId) {
        const runCase = await transaction.evalRunCase.update({
          where: { id: job.evalRunCaseId },
          data: {
            status: shouldRetry ? 'WAITING_FOR_EXECUTION' : 'EXECUTION_FAILED',
            executionError: input.error as Prisma.InputJsonValue,
            executionStartedAt: shouldRetry ? null : undefined,
            completedAt: shouldRetry ? null : failedAt,
          },
          select: { evalRunId: true },
        });
        if (!shouldRetry) {
          await this.refreshExecutionFailureSummary(
            transaction,
            runCase.evalRunId,
            failedAt,
          );
        }
      }

      return failed;
    });
  }

  /**
   * SDK 키 해시로 활성 애플리케이션을 인증한다.
   * @param sdkKey - 인증할 원본 SDK 키
   * @returns 인증된 활성 애플리케이션
   */
  private async authenticate(sdkKey: string) {
    if (!sdkKey) {
      throw new UnauthorizedException('Bearer SDK key is required');
    }
    const application = await this.prisma.aIApplication.findUnique({
      where: { sdkKeyHash: this.hashKey(sdkKey) },
    });
    if (!application?.active) {
      throw new UnauthorizedException('Invalid or inactive SDK key');
    }
    return application;
  }

  /**
   * 애플리케이션·작업·리스가 일치하고 리스가 만료되지 않았는지 검증한다.
   * @param application - 인증된 SDK 애플리케이션
   * @param jobId - 검증할 작업 식별자
   * @param leaseId - 작업 소유권을 증명할 리스 식별자
   * @returns 유효한 리스가 연결된 SDK 작업
   */
  private async requireLeasedJob(
    application: AIApplication,
    jobId: string,
    leaseId: string,
  ) {
    if (!leaseId) {
      throw new BadRequestException('leaseId is required');
    }
    const job = await this.prisma.sdkJob.findFirst({
      where: { id: jobId, applicationId: application.id },
    });
    if (!job) {
      throw new NotFoundException('SDK job not found');
    }
    if (
      job.leaseId !== leaseId ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= new Date()
    ) {
      throw new ConflictException('Job lease is invalid or expired');
    }
    return job;
  }

  /**
   * DB 작업을 SDK 클라이언트에 노출할 선점 작업 형태로 변환한다.
   * @param job - 변환할 데이터베이스 SDK 작업
   * @returns 리스와 테스트 케이스를 포함한 클라이언트용 작업
   */
  private toClaimedJob(job: SdkJob) {
    return {
      id: job.id,
      attempt: job.attempt,
      timeoutMs: job.timeoutMs,
      leaseId: job.leaseId,
      leaseExpiresAt: job.leaseExpiresAt,
      testCase: job.testCase,
    };
  }

  /**
   * SDK 키를 저장 및 비교하기 위한 SHA-256 해시를 생성한다.
   * @param value - 해시할 원본 SDK 키
   * @returns 16진수 SHA-256 해시 문자열
   */
  private hashKey(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  /**
   * 실행 실패 이후 평가 케이스 집계를 다시 계산해 상위 실행 상태를 갱신한다.
   * @param transaction - 집계와 갱신에 사용할 Prisma 트랜잭션
   * @param evalRunId - 갱신할 평가 실행 식별자
   * @param completedAt - 완료 시각으로 사용할 기준 시각
   * @returns 평가 실행 요약 갱신이 끝나면 이행되는 Promise
   */
  private async refreshExecutionFailureSummary(
    transaction: Prisma.TransactionClient,
    evalRunId: string,
    completedAt: Date,
  ) {
    const [totalCases, failedCases] = await Promise.all([
      transaction.evalRunCase.count({ where: { evalRunId } }),
      transaction.evalRunCase.count({
        where: { evalRunId, status: 'EXECUTION_FAILED' },
      }),
    ]);
    await transaction.evalRun.update({
      where: { id: evalRunId },
      data: {
        failedCases,
        status:
          totalCases > 0 && failedCases === totalCases ? 'FAILED' : 'RUNNING',
        completedAt:
          totalCases > 0 && failedCases === totalCases ? completedAt : null,
      },
    });
  }

  private readonly applicationSelect = {
    id: true,
    projectId: true,
    name: true,
    environment: true,
    active: true,
    createdAt: true,
    updatedAt: true,
  } satisfies Prisma.AIApplicationSelect;
}
