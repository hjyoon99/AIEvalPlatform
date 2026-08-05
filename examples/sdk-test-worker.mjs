import { createEvaluationAdapter } from '../packages/sdk/dist/index.js';

const adapter = createEvaluationAdapter({
    baseUrl: process.env.AIEVAL_BASE_URL ?? 'http://localhost:3000/api/v1',
    sdkKey: process.env.AIEVAL_SDK_KEY,
    pollIntervalMs: 1000,

    async invoke(testCase, context) {
        console.log('받은 TestCase:', testCase);
        console.log('실행 정보:', {
            jobId: context.jobId,
            attempt: context.attempt,
            timeoutMs: context.timeoutMs,
        });

        // 기업의 실제 AI 대신 사용하는 Mock 응답
        await new Promise((resolve) => setTimeout(resolve, 500));

        return {
            output: '기본 환불 기간은 수령 후 7일입니다. 예외 처리 가능 여부는 주문 정보를 확인한 뒤 안내드리겠습니다.',
            metadata: {
                model: 'mock-company-agent-v1',
                modelVersion: '1.0.0',
                traceId: `mock-${context.jobId}`,
            },
        };
    },

    onError(error) {
        console.error('SDK Worker 오류:', error);
    },
});

console.log('평가 어댑터가 Job을 기다리는 중입니다.');
await adapter.start();
