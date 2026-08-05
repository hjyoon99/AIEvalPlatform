import type {
  ClaimedJob,
  EvaluationWorkerOptions,
  ExecutionError,
  ExecutionResult,
} from './types.js';

export class EvaluationWorker {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private running = false;

  constructor(private readonly options: EvaluationWorkerOptions) {
    if (!options.baseUrl || !options.sdkKey) {
      throw new Error('baseUrl and sdkKey are required');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

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

  stop() {
    this.running = false;
  }

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

  private fail(job: ClaimedJob, error: ExecutionError) {
    return this.request(`/sdk/v1/jobs/${job.id}/fail`, {
      method: 'POST',
      body: { leaseId: job.leaseId, error },
    });
  }

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

  private headers(extra: Record<string, string> = {}) {
    return {
      Authorization: `Bearer ${this.options.sdkKey}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  private async assertOk(response: Response) {
    if (response.ok) return;
    const message = await response.text();
    throw new Error(
      `AIEval protocol request failed (${response.status}): ${message}`,
    );
  }

  private validateResult(result: ExecutionResult) {
    if (!result || typeof result.output !== 'string' || !result.output.trim()) {
      throw {
        code: 'INVALID_RESPONSE',
        message: 'Adapter handler must return a non-empty output string',
        retryable: false,
      } satisfies ExecutionError;
    }
  }

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

  private isExecutionError(value: unknown): value is ExecutionError {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<ExecutionError>;
    return (
      typeof candidate.code === 'string' &&
      typeof candidate.message === 'string'
    );
  }

  private delay(milliseconds: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}
