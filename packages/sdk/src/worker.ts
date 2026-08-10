import type {
  ClaimedJob,
  EvaluationWorkerOptions,
  ExecutionError,
  ExecutionResult,
} from './types.js';

/** 평가 작업의 선점, 고객 AI 실행, 완료·실패 보고를 담당하는 프로토콜 워커다. */
export class EvaluationWorker {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private running = false;

  /**
   * 필수 접속 정보를 검증하고 워커의 폴링 설정을 초기화한다.
   * @param options - 플랫폼 접속 정보, 실행 함수 및 오류 처리 설정
   */
  constructor(private readonly options: EvaluationWorkerOptions) {
    if (!options.baseUrl || !options.sdkKey) {
      throw new Error('baseUrl and sdkKey are required');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  /**
   * 중지 요청이 올 때까지 평가 작업을 조회하고 실행하는 폴링 루프를 유지한다.
   * @returns 워커가 중지되어 폴링 루프가 끝나면 이행되는 Promise
   */
  async start() {
    if (this.running) return;
    this.running = true;
    while (this.running) {
      try {
        const handled = await this.runOnce();
        if (!handled) {
          await this.delay(this.pollIntervalMs);
        }
      } catch (error) {
        this.options.onError?.(error);
        if (this.running) {
          await this.delay(this.pollIntervalMs);
        }
      }
    }
  }

  /**
   * 현재 폴링 루프가 다음 반복 전에 종료되도록 실행 상태를 변경한다.
   * @returns 값을 반환하지 않는다
   */
  stop() {
    this.running = false;
  }

  /**
   * 작업 하나를 선점해 시작하고 고객 AI의 결과 또는 실패를 플랫폼에 보고한다.
   * @returns 작업을 처리했으면 true, 선점할 작업이 없으면 false
   */
  async runOnce() {
    const job = await this.claim();
    if (!job) return false;

    await this.request(`/sdk/v1/jobs/${job.id}/start`, {
      method: 'POST',
      body: { leaseId: job.leaseId },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), job.timeoutMs);
    const startedAt = Date.now();
    let result: ExecutionResult;

    try {
      result = await this.options.execute(job.testCase, {
        jobId: job.id,
        attempt: job.attempt,
        timeoutMs: job.timeoutMs,
        signal: controller.signal,
      });
      this.validateResult(result);
    } catch (error) {
      await this.fail(job, this.normalizeError(error));
      return true;
    } finally {
      clearTimeout(timeout);
    }

    await this.complete(job, {
      ...result,
      metadata: {
        latencyMs: Date.now() - startedAt,
        ...result.metadata,
      },
    });
    return true;
  }

  /**
   * 플랫폼에 다음 평가 작업의 리스를 요청한다.
   * @returns 선점된 작업 또는 대기 중인 작업이 없으면 null
   */
  private async claim(): Promise<ClaimedJob | null> {
    const response = await fetch(`${this.baseUrl}/sdk/v1/jobs/claim`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (response.status === 204) return null;
    await this.assertOk(response);
    const payload = (await response.json()) as { job: ClaimedJob };
    return payload.job;
  }

  /**
   * 실행 결과를 시도별 멱등성 키와 함께 플랫폼에 제출한다.
   * @param job - 완료할 선점 작업과 리스 정보
   * @param result - 고객 AI의 출력과 실행 메타데이터
   * @returns 플랫폼의 완료 응답으로 이행되는 Promise
   */
  private complete(job: ClaimedJob, result: ExecutionResult) {
    return this.request(`/sdk/v1/jobs/${job.id}/complete`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': `${job.id}-attempt-${job.attempt}`,
      },
      body: {
        leaseId: job.leaseId,
        output: result.output,
        metadata: result.metadata,
      },
    });
  }

  /**
   * 고객 AI 실행 중 발생한 구조화된 오류를 플랫폼에 보고한다.
   * @param job - 실패한 선점 작업과 리스 정보
   * @param error - 코드와 메시지를 포함한 실행 오류
   * @returns 플랫폼의 실패 처리 응답으로 이행되는 Promise
   */
  private fail(job: ClaimedJob, error: ExecutionError) {
    return this.request(`/sdk/v1/jobs/${job.id}/fail`, {
      method: 'POST',
      body: { leaseId: job.leaseId, error },
    });
  }

  /**
   * 인증 및 JSON 처리가 적용된 SDK 프로토콜 HTTP 요청을 보낸다.
   * @param path - 기본 URL 뒤에 붙일 프로토콜 API 경로
   * @param init - HTTP 메서드, 추가 헤더 및 선택적 요청 본문
   * @returns 응답 JSON 또는 본문이 없는 응답이면 undefined
   */
  private async request(
    path: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: unknown;
    },
  ) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: this.headers(init.headers),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    await this.assertOk(response);
    return response.status === 204 ? undefined : response.json();
  }

  /**
   * SDK 인증과 JSON 콘텐츠 유형을 포함한 요청 헤더를 구성한다.
   * @param extra - 기본 헤더에 병합할 추가 헤더
   * @returns 프로토콜 요청에 사용할 HTTP 헤더 객체
   */
  private headers(extra: Record<string, string> = {}) {
    return {
      Authorization: `Bearer ${this.options.sdkKey}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  /**
   * HTTP 응답의 성공 여부를 확인하고 실패 본문을 포함한 오류를 발생시킨다.
   * @param response - 성공 여부를 검사할 Fetch API 응답
   * @returns 성공 응답이면 값을 반환하지 않는 Promise
   */
  private async assertOk(response: Response) {
    if (response.ok) return;
    const message = await response.text();
    throw new Error(
      `AIEval protocol request failed (${response.status}): ${message}`,
    );
  }

  /**
   * 고객 AI 실행 결과에 비어 있지 않은 문자열 출력이 있는지 검증한다.
   * @param result - 검증할 고객 AI 실행 결과
   * @returns 유효하면 값을 반환하지 않는다
   */
  private validateResult(result: ExecutionResult) {
    if (!result || typeof result.output !== 'string' || !result.output.trim()) {
      throw {
        code: 'INVALID_RESPONSE',
        message: 'Adapter handler must return a non-empty output string',
        retryable: false,
      } satisfies ExecutionError;
    }
  }

  /**
   * 임의의 예외를 플랫폼에 전송할 표준 실행 오류로 변환한다.
   * @param error - 고객 AI 실행 중 발생한 임의의 오류 값
   * @returns 코드, 메시지 및 재시도 여부를 가진 실행 오류
   */
  private normalizeError(error: unknown): ExecutionError {
    if (error instanceof Error) {
      return {
        code: error.name === 'AbortError' ? 'TARGET_TIMEOUT' : 'EXECUTION_ERROR',
        message: error.message,
        retryable: error.name === 'AbortError',
      };
    }
    if (this.isExecutionError(error)) return error;
    return {
      code: 'EXECUTION_ERROR',
      message: 'Unknown application execution error',
      retryable: false,
    };
  }

  /**
   * 값이 코드와 메시지를 가진 ExecutionError 구조인지 판별한다.
   * @param value - 검사할 임의의 값
   * @returns ExecutionError 구조를 만족하면 true
   */
  private isExecutionError(value: unknown): value is ExecutionError {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<ExecutionError>;
    return (
      typeof candidate.code === 'string' &&
      typeof candidate.message === 'string'
    );
  }

  /**
   * 폴링 재시도 전에 지정된 시간 동안 비동기로 대기한다.
   * @param milliseconds - 대기할 밀리초
   * @returns 대기 시간이 지나면 이행되는 Promise
   */
  private delay(milliseconds: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}
