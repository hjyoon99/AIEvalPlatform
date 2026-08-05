import { createServer } from 'node:http';

const port = Number(process.env.MOCK_AGENT_ENGINE_PORT ?? 18000);
const host = process.env.MOCK_AGENT_ENGINE_HOST ?? '127.0.0.1';

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    return json(response, 200, { status: 'ok', service: 'mock-agent-engine' });
  }
  if (
    request.method !== 'POST' ||
    request.url !== '/agents/evaluate/sync'
  ) {
    return json(response, 404, { message: 'Not found' });
  }

  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const item = payload.dataset?.[0];
      if (!item?.prompt || !item?.output) {
        return json(response, 400, { message: 'dataset item is required' });
      }
      if (item.prompt.includes('시스템 오류')) {
        return json(response, 503, { message: 'Mock Agent Engine failure' });
      }

      const verdict = item.prompt.includes('검토')
        ? 'RETRY'
        : item.prompt.includes('실패')
          ? 'FAIL'
          : 'PASS';
      const score = verdict === 'PASS' ? 0.92 : verdict === 'RETRY' ? 0.65 : 0.2;
      const metricScores =
        verdict === 'PASS'
          ? {
              correctness: 0.94,
              relevance: 0.9,
              completeness: 0.86,
              groundedness: 0.93,
              safety: 1,
            }
          : verdict === 'RETRY'
            ? {
                correctness: 0.68,
                relevance: 0.72,
                completeness: 0.58,
                groundedness: 0.66,
                safety: 0.95,
              }
            : {
                correctness: 0.2,
                relevance: 0.28,
                completeness: 0.18,
                groundedness: 0.22,
                safety: 0.8,
              };
      const criteria = [
        mockMetric(
          'correctness',
          '정확성',
          metricScores.correctness,
          '사실 및 기준 답변과의 일치 정도',
        ),
        mockMetric(
          'relevance',
          '관련성',
          metricScores.relevance,
          '질문의 의도에 직접 답한 정도',
        ),
        mockMetric(
          'completeness',
          '완전성',
          metricScores.completeness,
          '필요한 내용을 빠짐없이 포함한 정도',
        ),
        mockMetric(
          'groundedness',
          '근거 충실성',
          metricScores.groundedness,
          '제공된 근거와 기준을 벗어나지 않은 정도',
        ),
        mockMetric(
          'safety',
          '안전성',
          metricScores.safety,
          '위험하거나 금지된 내용을 피한 정도',
        ),
      ];
      return json(response, 200, {
        runId: payload.runId,
        results: [
          {
            prompt: item.prompt,
            output: item.output,
            expectedOutput: item.expectedOutput,
            score,
            verdict,
            retryCount: 0,
            verification: {
              isValid: true,
              reason: 'Mock 형식 검증 통과',
            },
            evaluation: {
              score,
              metrics: {
                faithfulness: metricScores.groundedness,
                answerRelevance: metricScores.relevance,
                criteria,
                reason: 'Mock Judge 평가 결과',
              },
            },
            metrics: {
              criteria,
              reason: 'Mock Judge 평가 결과',
            },
            supervision: {
              verdict,
              confidence: 0.95,
              reason: `Mock Supervisor ${verdict} 판정`,
            },
          },
        ],
      });
    } catch (error) {
      return json(response, 400, {
        message: error instanceof Error ? error.message : 'Invalid JSON',
      });
    }
  });
});

server.listen(port, host, () => {
  console.log(`Mock Agent Engine listening on http://${host}:${port}`);
});

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function mockMetric(key, name, score, description) {
  return {
    key,
    name,
    score,
    weight: 0.2,
    required: key === 'correctness' || key === 'safety',
    reason: `Mock ${description} 평가 결과: ${Math.round(score * 100)}점`,
  };
}
