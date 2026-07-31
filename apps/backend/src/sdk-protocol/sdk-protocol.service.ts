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

export interface CreateApplicationInput {
  name: string;
  environment?: string;
}

export interface CreateJobInput {
  testCase: Record<string, unknown>;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface LeaseInput {
  leaseId: string;
}

export interface CompleteJobInput extends LeaseInput {
  output: string;
  metadata?: Record<string, unknown>;
}

export interface FailJobInput extends LeaseInput {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

@Injectable()
export class SdkProtocolService {
  private readonly minimumLeaseDurationMs = 60_000;

  constructor(private readonly prisma: PrismaService) {}

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

  async claimJob(sdkKey: string) {
    const application = await this.authenticate(sdkKey);
    const now = new Date();

    return this.prisma.$transaction(async (transaction) => {
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

  async startJob(sdkKey: string, jobId: string, input: LeaseInput) {
    const application = await this.authenticate(sdkKey);
    const job = await this.requireLeasedJob(application, jobId, input.leaseId);
    if (job.status === 'RUNNING') {
      return { status: job.status };
    }
    if (job.status !== 'CLAIMED') {
      throw new ConflictException(`job cannot start from ${job.status}`);
    }
    return this.prisma.sdkJob.update({
      where: { id: job.id },
      data: { status: 'RUNNING', startedAt: new Date() },
      select: { id: true, status: true, startedAt: true },
    });
  }

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

    return this.prisma.sdkJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        idempotencyKey,
        output: {
          text: input.output,
          metadata: input.metadata ?? {},
        } as Prisma.InputJsonValue,
        completedAt: new Date(),
        leaseId: null,
        leaseExpiresAt: null,
      },
      select: { id: true, status: true, completedAt: true },
    });
  }

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
    return this.prisma.sdkJob.update({
      where: { id: job.id },
      data: {
        status: shouldRetry ? 'PENDING' : 'FAILED',
        error: input.error as Prisma.InputJsonValue,
        completedAt: shouldRetry ? null : new Date(),
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
  }

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

  private hashKey(value: string) {
    return createHash('sha256').update(value).digest('hex');
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
