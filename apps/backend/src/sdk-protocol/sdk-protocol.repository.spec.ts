import { ConflictException } from '@nestjs/common';
import type { PrismaService } from 'prisma/prisma.service';
import { SdkProtocolRepository } from './sdk-protocol.repository';

/**
 * lease 재할당 레이스 컨디션 회귀 테스트.
 *
 * requireLeasedJob은 트랜잭션 진입 "전"에 lease를 한 번 검증할 뿐이라, 검증과
 * 실제 상태 전이 쓰기 사이에 다른 워커가 같은 job을 재할당받으면(만료 스윕 →
 * 재claim) 늦게 도착한 요청이 새 워커의 상태를 덮어쓸 수 있었다. 이를 막기 위해
 * startJob/completeJob/failJob의 상태 전이 쓰기를 leaseId+status 조건부
 * updateMany(CAS)로 바꿨다 — 이 스펙은 그 CAS가 실제로 걸려 있는지,
 * 그리고 실패 시 하위 부수효과(evalRunCase/judgeJob 갱신)가 전혀 실행되지
 * 않는지를 검증한다.
 */
describe('SdkProtocolRepository - lease CAS on state transitions', () => {
  const future = new Date(Date.now() + 60_000);

  function buildRepository(
    job: Record<string, unknown>,
    updateManyCount: number,
  ) {
    const transactionClient = {
      sdkJob: {
        updateMany: jest.fn().mockResolvedValue({ count: updateManyCount }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: job.id,
          status: job.status,
          startedAt: (job.startedAt as Date | null) ?? null,
          completedAt: null,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
        }),
      },
      evalRunCase: {
        update: jest.fn().mockResolvedValue({
          evalRun: { maxRetries: 1 },
          evalRunId: 'run-1',
        }),
        count: jest.fn().mockResolvedValue(0),
      },
      evalRun: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      judgeJob: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };

    const prisma = {
      aIApplication: {
        findUnique: jest.fn().mockResolvedValue({ id: 'app-1', active: true }),
      },
      sdkJob: {
        findFirst: jest.fn().mockResolvedValue(job),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(
        (callback: (tx: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    };

    const repository = new SdkProtocolRepository(
      prisma as unknown as PrismaService,
    );
    return { repository, transactionClient, prisma };
  }

  describe('startJob', () => {
    const claimedJob = {
      id: 'job-1',
      status: 'CLAIMED',
      leaseId: 'lease-A',
      leaseExpiresAt: future,
      evalRunCaseId: 'case-1',
      attempt: 1,
      maxAttempts: 3,
      startedAt: null,
    };

    it('CAS 실패(count 0)면 Conflict를 던지고 evalRunCase는 건드리지 않는다', async () => {
      const { repository, transactionClient } = buildRepository(claimedJob, 0);

      await expect(
        repository.startJob('sdk-key', 'job-1', { leaseId: 'lease-A' }),
      ).rejects.toThrow(ConflictException);

      expect(transactionClient.sdkJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-1', leaseId: 'lease-A', status: 'CLAIMED' },
        data: expect.objectContaining({ status: 'RUNNING' }) as unknown,
      });
      expect(transactionClient.evalRunCase.update).not.toHaveBeenCalled();
    });

    it('CAS 성공(count 1)이면 정상적으로 RUNNING으로 전이하고 evalRunCase도 갱신한다', async () => {
      const { repository, transactionClient } = buildRepository(claimedJob, 1);

      await expect(
        repository.startJob('sdk-key', 'job-1', { leaseId: 'lease-A' }),
      ).resolves.toEqual(expect.objectContaining({ id: 'job-1' }));
      expect(transactionClient.evalRunCase.update).toHaveBeenCalledTimes(1);
      expect(transactionClient.evalRun.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('completeJob', () => {
    const runningJob = {
      id: 'job-2',
      status: 'RUNNING',
      leaseId: 'lease-B',
      leaseExpiresAt: future,
      evalRunCaseId: 'case-2',
      attempt: 1,
      maxAttempts: 3,
      startedAt: new Date(),
    };

    it('재할당으로 lease가 이미 넘어간 뒤 뒤늦게 도착한 완료 응답은 CAS에서 거부되고 부수효과가 실행되지 않는다', async () => {
      const { repository, transactionClient } = buildRepository(runningJob, 0);

      await expect(
        repository.completeJob('sdk-key', 'job-2', 'job-2-attempt-1', {
          leaseId: 'lease-B',
          output: 'stale answer from the reassigned worker',
        }),
      ).rejects.toThrow(ConflictException);

      expect(transactionClient.sdkJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-2', leaseId: 'lease-B', status: 'RUNNING' },
        data: expect.objectContaining({ status: 'COMPLETED' }) as unknown,
      });
      expect(transactionClient.evalRunCase.update).not.toHaveBeenCalled();
      expect(transactionClient.judgeJob.upsert).not.toHaveBeenCalled();
    });

    it('CAS 성공이면 완료 처리와 judgeJob 생성까지 정상 수행된다', async () => {
      const { repository, transactionClient } = buildRepository(runningJob, 1);

      await expect(
        repository.completeJob('sdk-key', 'job-2', 'job-2-attempt-1', {
          leaseId: 'lease-B',
          output: 'final answer',
        }),
      ).resolves.toEqual(expect.objectContaining({ id: 'job-2' }));
      expect(transactionClient.evalRunCase.update).toHaveBeenCalledTimes(1);
      expect(transactionClient.judgeJob.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('failJob', () => {
    const runningJob = {
      id: 'job-3',
      status: 'RUNNING',
      leaseId: 'lease-C',
      leaseExpiresAt: future,
      evalRunCaseId: 'case-3',
      attempt: 1,
      maxAttempts: 3,
      startedAt: new Date(),
    };

    it('CAS 실패(count 0)면 Conflict를 던지고 evalRunCase는 건드리지 않는다', async () => {
      const { repository, transactionClient } = buildRepository(runningJob, 0);

      await expect(
        repository.failJob('sdk-key', 'job-3', {
          leaseId: 'lease-C',
          error: { code: 'EXECUTION_ERROR', message: 'boom' },
        }),
      ).rejects.toThrow(ConflictException);

      expect(transactionClient.sdkJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-3', leaseId: 'lease-C', status: 'RUNNING' },
        data: expect.objectContaining({ status: 'FAILED' }) as unknown,
      });
      expect(transactionClient.evalRunCase.update).not.toHaveBeenCalled();
    });

    it('CAS 성공이면 재시도 불가 오류는 FAILED로 확정한다', async () => {
      const { repository, transactionClient } = buildRepository(runningJob, 1);

      await expect(
        repository.failJob('sdk-key', 'job-3', {
          leaseId: 'lease-C',
          error: {
            code: 'EXECUTION_ERROR',
            message: 'boom',
            retryable: false,
          },
        }),
      ).resolves.toEqual(expect.objectContaining({ id: 'job-3' }));
      expect(transactionClient.evalRunCase.update).toHaveBeenCalledTimes(1);
    });
  });

  it('DB에 저장된 leaseId와 다른 리스로 요청하면 트랜잭션 진입 전에 거부된다', async () => {
    const { repository } = buildRepository(
      {
        id: 'job-4',
        status: 'RUNNING',
        leaseId: 'lease-current-owner',
        leaseExpiresAt: future,
        evalRunCaseId: null,
        attempt: 1,
        maxAttempts: 3,
        startedAt: new Date(),
      },
      1,
    );

    await expect(
      repository.completeJob('sdk-key', 'job-4', 'job-4-attempt-1', {
        leaseId: 'lease-stale-worker',
        output: 'too late',
      }),
    ).rejects.toThrow(ConflictException);
  });
});
