import { Injectable } from '@nestjs/common';
import {
  SdkProtocolRepository,
  type CompleteJobInput,
  type CreateApplicationInput,
  type CreateJobInput,
  type FailJobInput,
  type LeaseInput,
} from './sdk-protocol.repository';

export type {
  CompleteJobInput,
  CreateApplicationInput,
  CreateJobInput,
  FailJobInput,
  LeaseInput,
} from './sdk-protocol.repository';

/** SDK 프로토콜 유스케이스를 Repository에 위임하는 애플리케이션 서비스다. */
@Injectable()
export class SdkProtocolService {
  constructor(private readonly repository: SdkProtocolRepository) {}

  /**
   * 프로젝트에 SDK 애플리케이션을 생성한다.
   * @param projectId - 대상 프로젝트 식별자
   * @param input - 애플리케이션 생성 정보
   * @returns 생성된 애플리케이션과 SDK 키
   */
  createApplication(projectId: string, input: CreateApplicationInput) {
    return this.repository.createApplication(projectId, input);
  }

  /**
   * 프로젝트의 SDK 애플리케이션을 조회한다.
   * @param projectId - 대상 프로젝트 식별자
   * @returns SDK 애플리케이션 목록
   */
  getApplications(projectId: string) {
    return this.repository.getApplications(projectId);
  }

  /**
   * SDK 애플리케이션을 삭제한다.
   * @param applicationId - 삭제할 애플리케이션 식별자
   * @returns 삭제 결과
   */
  deleteApplication(applicationId: string) {
    return this.repository.deleteApplication(applicationId);
  }

  /**
   * SDK가 실행할 작업을 생성한다.
   * @param applicationId - 대상 애플리케이션 식별자
   * @param input - 테스트 케이스와 실행 설정
   * @returns 생성된 SDK 작업
   */
  createJob(applicationId: string, input: CreateJobInput) {
    return this.repository.createJob(applicationId, input);
  }

  /**
   * 애플리케이션의 SDK 작업을 조회한다.
   * @param applicationId - 대상 애플리케이션 식별자
   * @returns SDK 작업 목록
   */
  getJobs(applicationId: string) {
    return this.repository.getJobs(applicationId);
  }

  /**
   * SDK 키로 인증해 다음 작업을 선점한다.
   * @param sdkKey - 애플리케이션 인증 키
   * @returns 선점된 작업 또는 null
   */
  claimJob(sdkKey: string) {
    return this.repository.claimJob(sdkKey);
  }

  /**
   * 선점된 작업을 실행 상태로 전환한다.
   * @param sdkKey - 애플리케이션 인증 키
   * @param jobId - 시작할 작업 식별자
   * @param input - 리스 정보
   * @returns 실행 상태가 반영된 작업
   */
  startJob(sdkKey: string, jobId: string, input: LeaseInput) {
    return this.repository.startJob(sdkKey, jobId, input);
  }

  /**
   * SDK 실행 결과를 멱등하게 완료 처리한다.
   * @param sdkKey - 애플리케이션 인증 키
   * @param jobId - 완료할 작업 식별자
   * @param idempotencyKey - 중복 요청 방지 키
   * @param input - 리스와 실행 결과
   * @returns 완료 처리된 작업
   */
  completeJob(
    sdkKey: string,
    jobId: string,
    idempotencyKey: string | undefined,
    input: CompleteJobInput,
  ) {
    return this.repository.completeJob(sdkKey, jobId, idempotencyKey, input);
  }

  /**
   * SDK 실행 실패를 기록한다.
   * @param sdkKey - 애플리케이션 인증 키
   * @param jobId - 실패한 작업 식별자
   * @param input - 리스와 실행 오류
   * @returns 재시도 또는 실패 상태가 반영된 작업
   */
  failJob(sdkKey: string, jobId: string, input: FailJobInput) {
    return this.repository.failJob(sdkKey, jobId, input);
  }
}
