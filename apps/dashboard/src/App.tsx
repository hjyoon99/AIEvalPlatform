import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

const API_URL =
  import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

type DatasetItem = {
  prompt: string;
  output: string;
  expectedOutput: string;
};

type EvalResult = {
  id: string;
  inputPrompt: string;
  outputAnswer: string;
  expectedOutput?: string;
  score: number;
  verdict: 'PASS' | 'FAIL' | 'RETRY';
  reason?: string;
  verification?: {
    isValid?: boolean;
    reason?: string;
    error?: string;
  };
  evaluation?: {
    score?: number;
    passed?: boolean;
    metrics?: {
      faithfulness?: number;
      answerRelevance?: number;
      reason?: string;
      error?: string;
      criteria?: {
        key: string;
        name: string;
        score: number;
        weight: number;
        required?: boolean;
        reason?: string;
      }[];
    };
  };
  supervision?: {
    verdict?: string;
    confidence?: number;
    reason?: string;
    issues?: string[];
    recommendedAction?: string;
  };
  retryCount: number;
  durationMs?: number;
};

type EvalRun = {
  id: string;
  name: string;
  agentName: string;
  model: string;
  status: string;
  passThreshold: number;
  maxRetries: number;
  createdAt: string;
  results: EvalResult[];
};

type Summary = {
  totalRuns: number;
  totalEvaluations: number;
  averageScore: number;
  passRate: number;
};

type Project = {
  id: string;
  name: string;
  domain: string;
  description?: string;
};

type Metric = {
  key: string;
  name: string;
  description: string;
  weight: number;
  required?: boolean;
};

type Policy = {
  id: string;
  projectId: string;
  name: string;
  passThreshold: number;
  maxRetries: number;
  metrics: Metric[];
};

type Scenario = {
  id: string;
  title: string;
  category?: string;
  prompt: string;
  testOutput?: string;
  expectedOutput?: string;
  expectedBehavior?: string[];
  evaluationRubric?: ScenarioRubric;
  riskLevel: string;
  status: string;
  autoValidation?: {
    valid?: boolean;
    score?: number;
    reason?: string;
    issues?: string[];
  };
};

type RubricLevel = {
  score: number;
  criteria?: string;
  description?: string;
};

type ScenarioRubricMetric = {
  key: string;
  name: string;
  levels: RubricLevel[];
};

type ScenarioRubric = {
  metrics?: ScenarioRubricMetric[];
  requiredConditions?: string[];
  failConditions?: string[];
  allowedVariations?: string[];
};

type AIApplication = {
  id: string;
  projectId: string;
  name: string;
  environment: string;
  active: boolean;
  createdAt: string;
  _count: {
    jobs: number;
  };
  jobs: {
    status: string;
    updatedAt: string;
  }[];
};

type SdkJob = {
  id: string;
  applicationId: string;
  testCase: {
    id?: string;
    prompt?: string;
    variables?: Record<string, unknown>;
  };
  status: string;
  attempt: number;
  maxAttempts: number;
  timeoutMs: number;
  output?: {
    text?: string;
    metadata?: Record<string, unknown>;
  };
  error?: {
    code?: string;
    message?: string;
  };
  createdAt: string;
  updatedAt: string;
};

const initialDataset: DatasetItem[] = [
  {
    prompt: '대한민국의 수도는 어디인가요?',
    output: '대한민국의 수도는 서울입니다.',
    expectedOutput: '대한민국의 수도는 서울입니다.',
  },
  {
    prompt: '물의 화학식을 알려주세요.',
    output: '물의 화학식은 CO2입니다.',
    expectedOutput: '물의 화학식은 H2O입니다.',
  },
];

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function App() {
  const [activeView, setActiveView] = useState<
    'runs' | 'scenarios' | 'policies' | 'adapters'
  >('runs');
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyId, setPolicyId] = useState('');
  const [summary, setSummary] = useState<Summary>({
    totalRuns: 0,
    totalEvaluations: 0,
    averageScore: 0,
    passRate: 0,
  });
  const [name, setName] = useState('기본 품질 점검');
  const [agentName, setAgentName] = useState('customer-support-agent');
  const [model, setModel] = useState('qwen3.5:4b');
  const [passThreshold, setPassThreshold] = useState(0.7);
  const [maxRetries, setMaxRetries] = useState(1);
  const [dataset, setDataset] = useState(initialDataset);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState('');

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0],
    [runs, selectedRunId],
  );

  const loadDashboard = useCallback(async () => {
    try {
      const [runsResponse, summaryResponse, projectsResponse] = await Promise.all([
        fetch(`${API_URL}/eval-runs`),
        fetch(`${API_URL}/eval-runs/summary`),
        fetch(`${API_URL}/projects`),
      ]);
      if (!runsResponse.ok || !summaryResponse.ok || !projectsResponse.ok) {
        throw new Error('대시보드 데이터를 불러오지 못했습니다.');
      }
      const nextRuns = (await runsResponse.json()) as EvalRun[];
      setRuns(nextRuns);
      setSummary((await summaryResponse.json()) as Summary);
      const nextProjects = (await projectsResponse.json()) as Project[];
      setProjects(nextProjects);
      if (!projectId && nextProjects[0]) {
        setProjectId(nextProjects[0].id);
      }
      setError('');
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'NestJS API 연결을 확인해주세요.',
      );
    }
  }, [projectId]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!projectId) {
      setPolicies([]);
      setPolicyId('');
      return;
    }
    void fetch(`${API_URL}/projects/${projectId}/policies`)
      .then((response) => response.json() as Promise<Policy[]>)
      .then((nextPolicies) => {
        setPolicies(nextPolicies);
        setPolicyId((current) =>
          nextPolicies.some((policy) => policy.id === current)
            ? current
            : nextPolicies[0]?.id ?? '',
        );
      });
  }, [projectId]);

  const updateDataset = (
    index: number,
    field: keyof DatasetItem,
    value: string,
  ) => {
    setDataset((items) =>
      items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    );
  };

  const addDatasetItem = () => {
    setDataset((items) => [
      ...items,
      { prompt: '', output: '', expectedOutput: '' },
    ]);
  };

  const removeDatasetItem = (index: number) => {
    setDataset((items) => items.filter((_, itemIndex) => itemIndex !== index));
  };

  const submitRun = async (event: FormEvent) => {
    event.preventDefault();
    setIsRunning(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/eval-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          projectId: projectId || undefined,
          policyId: policyId || undefined,
          agentName,
          model,
          passThreshold: policyId ? undefined : passThreshold,
          maxRetries: policyId ? undefined : maxRetries,
          dataset: dataset.map((item) => ({
            prompt: item.prompt,
            output: item.output || undefined,
            expectedOutput: item.expectedOutput || undefined,
          })),
        }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message ?? '평가 실행에 실패했습니다.');
      }

      const run = (await response.json()) as EvalRun;
      setSelectedRunId(run.id);
      await loadDashboard();
    } catch (runError) {
      setError(
        runError instanceof Error ? runError.message : '평가 실행에 실패했습니다.',
      );
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark">E</div>
        <nav aria-label="주 메뉴">
          <button
            className={`nav-item ${activeView === 'runs' ? 'active' : ''}`}
            aria-label="평가 실행"
            onClick={() => setActiveView('runs')}
          >
            <span>⌁</span>
          </button>
          <button
            className={`nav-item ${activeView === 'scenarios' ? 'active' : ''}`}
            aria-label="시나리오"
            onClick={() => setActiveView('scenarios')}
          >
            <span>◫</span>
          </button>
          <button
            className={`nav-item ${activeView === 'policies' ? 'active' : ''}`}
            aria-label="평가 정책"
            onClick={() => setActiveView('policies')}
          >
            <span>⚙</span>
          </button>
          <button
            className={`nav-item ${activeView === 'adapters' ? 'active' : ''}`}
            aria-label="평가 어댑터"
            onClick={() => setActiveView('adapters')}
          >
            <span>⇄</span>
          </button>
        </nav>
        <div className="sidebar-status" title="Ollama local">
          <span />
        </div>
      </aside>

      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">AI QUALITY CONTROL</p>
            <h1>Evaluation workspace</h1>
            <p>에이전트 답변을 실행하고, 검증하고, 감독합니다.</p>
          </div>
          <div className="engine-pill">
            <span />
            qwen3.5:4b · local
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}

        {activeView === 'runs' && (
          <>
        <section className="summary-grid" aria-label="평가 요약">
          <SummaryCard
            label="Total runs"
            value={summary.totalRuns.toString()}
            accent="indigo"
          />
          <SummaryCard
            label="Evaluations"
            value={summary.totalEvaluations.toString()}
            accent="sky"
          />
          <SummaryCard
            label="Average score"
            value={`${Math.round(summary.averageScore * 100)}%`}
            accent="amber"
          />
          <SummaryCard
            label="Pass rate"
            value={`${Math.round(summary.passRate * 100)}%`}
            accent="mint"
          />
        </section>

        <div className="workspace-grid">
          <section className="panel run-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">NEW RUN</p>
                <h2>평가 실행</h2>
              </div>
              <span className="step-badge">Supervisor graph</span>
            </div>

            <form onSubmit={submitRun}>
              <div className="form-row">
                <label>
                  실행 이름
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                </label>
                <label>
                  대상 에이전트
                  <input
                    value={agentName}
                    onChange={(event) => setAgentName(event.target.value)}
                    required
                  />
                </label>
              </div>

              <div className="form-row policy-row">
                <label>
                  평가 모델
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  />
                </label>
                <label>
                  통과 기준
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={passThreshold}
                    onChange={(event) =>
                      setPassThreshold(Number(event.target.value))
                    }
                  />
                </label>
                <label>
                  최대 재평가
                  <input
                    type="number"
                    min="0"
                    max="2"
                    value={maxRetries}
                    onChange={(event) =>
                      setMaxRetries(Number(event.target.value))
                    }
                  />
                </label>
              </div>

              <div className="form-row">
                <label>
                  프로젝트
                  <select
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                  >
                    <option value="">프로젝트 미지정</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  저장된 평가 정책
                  <select
                    value={policyId}
                    onChange={(event) => setPolicyId(event.target.value)}
                    disabled={!projectId}
                  >
                    <option value="">직접 설정 사용</option>
                    {policies.map((policy) => (
                      <option key={policy.id} value={policy.id}>
                        {policy.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="dataset-heading">
                <div>
                  <h3>Test dataset</h3>
                  <p>외부 AI의 질문·답변·기대 답변을 입력하세요.</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={addDatasetItem}
                >
                  + 항목 추가
                </button>
              </div>

              <div className="dataset-list">
                {dataset.map((item, index) => (
                  <article className="dataset-item" key={index}>
                    <div className="dataset-index">
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      {dataset.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeDatasetItem(index)}
                          aria-label={`${index + 1}번 항목 삭제`}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <label>
                      Prompt
                      <textarea
                        value={item.prompt}
                        onChange={(event) =>
                          updateDataset(index, 'prompt', event.target.value)
                        }
                        required
                      />
                    </label>
                    <label>
                      AI output
                      <textarea
                        value={item.output}
                        onChange={(event) =>
                          updateDataset(index, 'output', event.target.value)
                        }
                        placeholder="비워두면 테스트 Agent가 생성합니다."
                      />
                    </label>
                    <label>
                      Expected
                      <textarea
                        value={item.expectedOutput}
                        onChange={(event) =>
                          updateDataset(
                            index,
                            'expectedOutput',
                            event.target.value,
                          )
                        }
                      />
                    </label>
                  </article>
                ))}
              </div>

              <button className="primary-button" disabled={isRunning}>
                {isRunning ? 'Supervisor가 평가 중…' : '평가 실행하기 →'}
              </button>
            </form>
          </section>

          <aside className="right-column">
            <section className="panel recent-panel">
              <div className="panel-heading compact">
                <div>
                  <p className="eyebrow">HISTORY</p>
                  <h2>최근 실행</h2>
                </div>
                <button className="icon-button" onClick={() => void loadDashboard()}>
                  ↻
                </button>
              </div>
              <div className="run-list">
                {runs.length === 0 && (
                  <div className="empty-state">아직 평가 실행이 없습니다.</div>
                )}
                {runs.map((run) => {
                  const passed = run.results.filter(
                    (result) => result.verdict === 'PASS',
                  ).length;
                  return (
                    <button
                      key={run.id}
                      className={`run-row ${
                        selectedRun?.id === run.id ? 'selected' : ''
                      }`}
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      <span
                        className={`status-dot ${run.status.toLowerCase()}`}
                      />
                      <span className="run-copy">
                        <strong>{run.name}</strong>
                        <small>
                          {run.agentName} · {formatDate(run.createdAt)}
                        </small>
                      </span>
                      <span className="run-score">
                        {passed}/{run.results.length}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

          </aside>
        </div>

        <section className="panel result-explorer">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">RESULT EXPLORER</p>
              <h2>{selectedRun?.name ?? '실행 결과'}</h2>
              <p className="section-description">
                원본 답변과 각 평가 에이전트의 구조화된 판정 근거를 확인합니다.
              </p>
            </div>
            {selectedRun && (
              <span className="step-badge">
                {selectedRun.results.length} test cases
              </span>
            )}
          </div>

          <div className="result-explorer-list">
            {!selectedRun && (
              <div className="empty-state">평가를 실행해 결과를 확인하세요.</div>
            )}
            {selectedRun?.results.map((result, index) => (
              <ResultExplorerCard
                result={result}
                index={index}
                key={result.id}
              />
            ))}
          </div>
        </section>
          </>
        )}

        {activeView === 'scenarios' && (
          <ScenarioWorkspace
            projects={projects}
            onProjectsChanged={loadDashboard}
            onRunCreated={async (runId) => {
              setSelectedRunId(runId);
              await loadDashboard();
              setActiveView('runs');
            }}
          />
        )}

        {activeView === 'policies' && (
          <PolicyWorkspace
            projects={projects}
            onProjectsChanged={loadDashboard}
          />
        )}

        {activeView === 'adapters' && (
          <AdapterWorkspace
            projects={projects}
            onProjectsChanged={loadDashboard}
          />
        )}
      </main>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <article className={`summary-card ${accent}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <i />
    </article>
  );
}

function VerdictBadge({ verdict }: { verdict: EvalResult['verdict'] }) {
  return <span className={`verdict ${verdict.toLowerCase()}`}>{verdict}</span>;
}

function ResultExplorerCard({
  result,
  index,
}: {
  result: EvalResult;
  index: number;
}) {
  const evaluationReason =
    result.evaluation?.metrics?.reason ?? '평가 근거가 저장되지 않았습니다.';
  const dynamicMetrics = result.evaluation?.metrics?.criteria?.map((metric) => ({
    label: metric.name,
    value: metric.score,
  }));

  return (
    <article className="explorer-card">
      <div className="explorer-summary">
        <div>
          <span className="case-label">
            CASE {String(index + 1).padStart(2, '0')}
          </span>
          <h3>{result.inputPrompt}</h3>
        </div>
        <div className="explorer-score">
          <strong>{Math.round(result.score * 100)}</strong>
          <span>quality score</span>
          <VerdictBadge verdict={result.verdict} />
        </div>
      </div>

      <div className="answer-comparison">
        <div>
          <span>AI OUTPUT</span>
          <p>{result.outputAnswer}</p>
        </div>
        <div>
          <span>EXPECTED</span>
          <p>{result.expectedOutput ?? '기대 답변 미지정'}</p>
        </div>
      </div>

      <div className="agent-timeline">
        <AgentStep
          number="01"
          name="Verifier"
          role="형식·유효성 검증"
          status={result.verification?.isValid ? 'VALID' : 'INVALID'}
          tone={result.verification?.isValid ? 'pass' : 'fail'}
          reason={
            result.verification?.reason ??
            '검증 에이전트의 판정 근거가 저장되지 않았습니다.'
          }
        />
        <AgentStep
          number="02"
          name="Evaluator"
          role="품질 지표 채점"
          status={`${Math.round(result.score * 100)} SCORE`}
          tone={result.score >= 0.7 ? 'pass' : 'warn'}
          reason={evaluationReason}
          metrics={
            dynamicMetrics?.length
              ? dynamicMetrics
              : [
                  {
                    label: '정확성',
                    value: result.evaluation?.metrics?.faithfulness,
                  },
                  {
                    label: '관련성',
                    value: result.evaluation?.metrics?.answerRelevance,
                  },
                ]
          }
        />
        <AgentStep
          number="03"
          name="Supervisor"
          role="최종 QA 판정"
          status={result.supervision?.verdict ?? result.verdict}
          tone={result.verdict === 'PASS' ? 'pass' : 'fail'}
          reason={
            result.supervision?.reason ??
            result.reason ??
            'Supervisor 판정 근거가 없습니다.'
          }
          footer={
            result.supervision?.confidence !== undefined
              ? `Confidence ${Math.round(result.supervision.confidence * 100)}% · Retry ${result.retryCount}`
              : `Retry ${result.retryCount}`
          }
        />
      </div>
    </article>
  );
}

function AgentStep({
  number,
  name,
  role,
  status,
  tone,
  reason,
  metrics,
  footer,
}: {
  number: string;
  name: string;
  role: string;
  status: string;
  tone: 'pass' | 'fail' | 'warn';
  reason: string;
  metrics?: { label: string; value?: number }[];
  footer?: string;
}) {
  return (
    <section className={`agent-step ${tone}`}>
      <div className="agent-step-header">
        <span className="agent-number">{number}</span>
        <div>
          <strong>{name}</strong>
          <small>{role}</small>
        </div>
        <span className="agent-status">{status}</span>
      </div>
      {metrics && (
        <div className="metric-chips">
          {metrics.map((metric) => (
            <span key={metric.label}>
              {metric.label}{' '}
              <strong>
                {metric.value === undefined
                  ? '—'
                  : `${Math.round(metric.value * 100)}%`}
              </strong>
            </span>
          ))}
        </div>
      )}
      <p>{reason}</p>
      {footer && <footer>{footer}</footer>}
    </section>
  );
}

function ProjectCreator({
  onCreated,
}: {
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('고객상담 AI');
  const [domain, setDomain] = useState('e-commerce customer support');
  const [description, setDescription] = useState(
    '배송, 교환, 환불 문의에 답변하는 고객상담 챗봇',
  );

  const create = async () => {
    const response = await fetch(`${API_URL}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, domain, description }),
    });
    if (!response.ok) throw new Error('프로젝트 생성에 실패했습니다.');
    await onCreated();
  };

  return (
    <section className="panel workspace-section">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">PROJECT SETUP</p>
          <h2>먼저 평가 프로젝트를 만들어주세요</h2>
        </div>
      </div>
      <div className="project-create-grid">
        <label>
          프로젝트 이름
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          도메인
          <input
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <label>
          설명
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <button className="primary-button inline" onClick={() => void create()}>
          프로젝트 생성
        </button>
      </div>
    </section>
  );
}

function AdapterWorkspace({
  projects,
  onProjectsChanged,
}: {
  projects: Project[];
  onProjectsChanged: () => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [applications, setApplications] = useState<AIApplication[]>([]);
  const [applicationId, setApplicationId] = useState('');
  const [jobs, setJobs] = useState<SdkJob[]>([]);
  const [applicationName, setApplicationName] = useState(
    'customer-support-adapter',
  );
  const [environment, setEnvironment] = useState('development');
  const [issuedSdkKey, setIssuedSdkKey] = useState('');
  const [prompt, setPrompt] = useState('주문을 취소할 수 있나요?');
  const [variablesJson, setVariablesJson] = useState('{}');
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (!projectId && projects[0]) {
      setProjectId(projects[0].id);
    }
  }, [projectId, projects]);

  const loadApplications = useCallback(async () => {
    if (!projectId) {
      setApplications([]);
      setApplicationId('');
      return;
    }
    const response = await fetch(
      `${API_URL}/projects/${projectId}/applications`,
    );
    if (!response.ok) {
      throw new Error('어댑터 목록을 불러오지 못했습니다.');
    }
    const nextApplications = (await response.json()) as AIApplication[];
    setApplications(nextApplications);
    setApplicationId((current) =>
      nextApplications.some((application) => application.id === current)
        ? current
        : nextApplications[0]?.id ?? '',
    );
  }, [projectId]);

  const loadJobs = useCallback(async () => {
    if (!applicationId) {
      setJobs([]);
      return;
    }
    const response = await fetch(
      `${API_URL}/applications/${applicationId}/jobs`,
    );
    if (!response.ok) {
      throw new Error('Job 목록을 불러오지 못했습니다.');
    }
    setJobs((await response.json()) as SdkJob[]);
  }, [applicationId]);

  useEffect(() => {
    void loadApplications().catch((loadError) => {
      setLocalError(
        loadError instanceof Error
          ? loadError.message
          : '어댑터 목록 조회에 실패했습니다.',
      );
    });
  }, [loadApplications]);

  useEffect(() => {
    void loadJobs().catch((loadError) => {
      setLocalError(
        loadError instanceof Error
          ? loadError.message
          : 'Job 목록 조회에 실패했습니다.',
      );
    });
    if (!applicationId) return;
    const timer = window.setInterval(() => {
      void loadJobs();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [applicationId, loadJobs]);

  if (projects.length === 0) {
    return <ProjectCreator onCreated={onProjectsChanged} />;
  }

  const createApplication = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId) return;
    setBusy(true);
    setLocalError('');
    try {
      const response = await fetch(
        `${API_URL}/projects/${projectId}/applications`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: applicationName,
            environment,
          }),
        },
      );
      const body = (await response.json()) as {
        application?: AIApplication;
        sdkKey?: string;
        message?: string;
      };
      if (!response.ok || !body.application || !body.sdkKey) {
        throw new Error(body.message ?? '어댑터 등록에 실패했습니다.');
      }
      setIssuedSdkKey(body.sdkKey);
      await loadApplications();
      setApplicationId(body.application.id);
    } catch (createError) {
      setLocalError(
        createError instanceof Error
          ? createError.message
          : '어댑터 등록에 실패했습니다.',
      );
    } finally {
      setBusy(false);
    }
  };

  const createJob = async (event: FormEvent) => {
    event.preventDefault();
    if (!applicationId) return;
    setBusy(true);
    setLocalError('');
    try {
      let variables: Record<string, unknown>;
      try {
        variables = JSON.parse(variablesJson) as Record<string, unknown>;
      } catch {
        throw new Error('Variables는 올바른 JSON 객체여야 합니다.');
      }
      if (
        !variables ||
        Array.isArray(variables) ||
        typeof variables !== 'object'
      ) {
        throw new Error('Variables는 JSON 객체여야 합니다.');
      }

      const response = await fetch(
        `${API_URL}/applications/${applicationId}/jobs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            testCase: {
              id: `dashboard-${Date.now()}`,
              prompt,
              variables,
            },
            timeoutMs,
            maxAttempts: 3,
          }),
        },
      );
      const body = (await response.json()) as {
        message?: string;
      };
      if (!response.ok) {
        throw new Error(body.message ?? '테스트 Job 생성에 실패했습니다.');
      }
      await Promise.all([loadJobs(), loadApplications()]);
    } catch (jobError) {
      setLocalError(
        jobError instanceof Error
          ? jobError.message
          : '테스트 Job 생성에 실패했습니다.',
      );
    } finally {
      setBusy(false);
    }
  };

  const selectedApplication = applications.find(
    (application) => application.id === applicationId,
  );

  return (
    <div className="adapter-layout">
      <section className="panel workspace-section">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">LOCAL ADAPTER</p>
            <h2>평가 어댑터</h2>
            <p className="section-description">
              기존 고객 AI를 수정하지 않고 별도 프로세스로 연결합니다.
            </p>
          </div>
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setIssuedSdkKey('');
            }}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        {localError && <div className="error-banner inline">{localError}</div>}

        <div className="adapter-section">
          <div>
            <p className="eyebrow">STEP 1</p>
            <h3>어댑터 등록</h3>
          </div>
          <form className="adapter-create-form" onSubmit={createApplication}>
            <label>
              이름
              <input
                value={applicationName}
                onChange={(event) => setApplicationName(event.target.value)}
                required
              />
            </label>
            <label>
              환경
              <select
                value={environment}
                onChange={(event) => setEnvironment(event.target.value)}
              >
                <option value="development">development</option>
                <option value="staging">staging</option>
                <option value="production">production</option>
              </select>
            </label>
            <button
              className="primary-button inline"
              disabled={busy || !projectId}
            >
              등록 및 SDK Key 발급
            </button>
          </form>

          {issuedSdkKey && (
            <div className="sdk-key-callout">
              <div>
                <strong>SDK Key는 지금 한 번만 표시됩니다.</strong>
                <code>{issuedSdkKey}</code>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void navigator.clipboard.writeText(issuedSdkKey)}
              >
                복사
              </button>
            </div>
          )}
        </div>

        <div className="adapter-section">
          <div>
            <p className="eyebrow">STEP 2</p>
            <h3>연결 코드</h3>
          </div>
          <pre className="adapter-code">
            <code>{`const adapter = createEvaluationAdapter({
  baseUrl: '${API_URL}',
  sdkKey: process.env.AIEVAL_SDK_KEY,
  async invoke(testCase, context) {
    const response = await fetch(process.env.CUSTOMER_AI_URL, {
      method: 'POST',
      signal: context.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: testCase.prompt })
    });
    const data = await response.json();
    return { output: data.answer };
  }
});

await adapter.start();`}</code>
          </pre>
        </div>

        <div className="adapter-section">
          <div>
            <p className="eyebrow">STEP 3</p>
            <h3>연결 테스트</h3>
          </div>
          <form className="adapter-job-form" onSubmit={createJob}>
            <label>
              평가 대상
              <select
                value={applicationId}
                onChange={(event) => setApplicationId(event.target.value)}
                disabled={applications.length === 0}
              >
                {applications.length === 0 && (
                  <option value="">먼저 어댑터를 등록하세요</option>
                )}
                {applications.map((application) => (
                  <option key={application.id} value={application.id}>
                    {application.name} · {application.environment}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Timeout(ms)
              <input
                type="number"
                min="1000"
                max="300000"
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(Number(event.target.value))}
              />
            </label>
            <label className="adapter-wide">
              Prompt
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                required
              />
            </label>
            <label className="adapter-wide">
              Variables (JSON)
              <textarea
                className="code-input"
                value={variablesJson}
                onChange={(event) => setVariablesJson(event.target.value)}
              />
            </label>
            <button
              className="primary-button"
              disabled={busy || !applicationId}
            >
              테스트 Job 보내기
            </button>
          </form>
        </div>
      </section>

      <aside className="panel adapter-status-panel">
        <div className="panel-heading compact">
          <div>
            <p className="eyebrow">EXECUTION</p>
            <h2>어댑터 상태</h2>
          </div>
          <button
            className="icon-button"
            onClick={() => void Promise.all([loadApplications(), loadJobs()])}
          >
            ↻
          </button>
        </div>

        {selectedApplication ? (
          <div className="adapter-summary">
            <div className="adapter-title">
              <span
                className={`status-dot ${
                  jobs.some((job) =>
                    ['CLAIMED', 'RUNNING'].includes(job.status),
                  )
                    ? 'running'
                    : 'completed'
                }`}
              />
              <div>
                <strong>{selectedApplication.name}</strong>
                <small>
                  {selectedApplication.environment} ·{' '}
                  {selectedApplication._count.jobs} jobs
                </small>
              </div>
            </div>
            <p>
              Worker 온라인 여부는 heartbeat가 추가되기 전까지 실행 중인 Job으로
              판단합니다.
            </p>
          </div>
        ) : (
          <div className="empty-state">등록된 어댑터가 없습니다.</div>
        )}

        <div className="adapter-job-list">
          {jobs.length === 0 && applicationId && (
            <div className="empty-state">아직 실행한 Job이 없습니다.</div>
          )}
          {jobs.map((job) => (
            <article key={job.id}>
              <header>
                <span className={`job-status ${job.status.toLowerCase()}`}>
                  {job.status}
                </span>
                <small>{formatDate(job.createdAt)}</small>
              </header>
              <strong>{job.testCase.prompt ?? 'Prompt 없음'}</strong>
              <p>
                attempt {job.attempt}/{job.maxAttempts} · timeout{' '}
                {job.timeoutMs}ms
              </p>
              {job.output?.text && (
                <div className="job-output">{job.output.text}</div>
              )}
              {job.error?.message && (
                <div className="job-error">
                  {job.error.code}: {job.error.message}
                </div>
              )}
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}

function ScenarioWorkspace({
  projects,
  onProjectsChanged,
  onRunCreated,
}: {
  projects: Project[];
  onProjectsChanged: () => Promise<void>;
  onRunCreated: (runId: string) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyId, setPolicyId] = useState('');
  const [count, setCount] = useState(3);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(
    null,
  );

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  const load = useCallback(async () => {
    if (!projectId) return;
    const [scenarioResponse, policyResponse] = await Promise.all([
      fetch(`${API_URL}/projects/${projectId}/scenarios`),
      fetch(`${API_URL}/projects/${projectId}/policies`),
    ]);
    setScenarios((await scenarioResponse.json()) as Scenario[]);
    const nextPolicies = (await policyResponse.json()) as Policy[];
    setPolicies(nextPolicies);
    setPolicyId((current) => current || nextPolicies[0]?.id || '');
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (projects.length === 0) {
    return <ProjectCreator onCreated={onProjectsChanged} />;
  }

  const generate = async () => {
    setLoading(true);
    try {
      await fetch(`${API_URL}/projects/${projectId}/scenarios/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policyId: policyId || undefined, count }),
      });
      await load();
    } finally {
      setLoading(false);
    }
  };

  const review = async (scenarioId: string, status: string) => {
    await fetch(`${API_URL}/scenarios/${scenarioId}/review`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    await load();
  };

  const runApprovedScenarios = async () => {
    const approvedIds = scenarios
      .filter((scenario) => scenario.status === 'APPROVED')
      .map((scenario) => scenario.id);
    if (approvedIds.length === 0) {
      setError('먼저 테스트할 시나리오를 한 개 이상 승인해주세요.');
      return;
    }
    setTesting(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/eval-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `승인 시나리오 테스트 · ${new Date().toLocaleDateString('ko-KR')}`,
          projectId,
          policyId: policyId || undefined,
          scenarioIds: approvedIds,
          agentName: 'scenario-test-agent',
          model: 'qwen3.5:4b',
        }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message ?? '시나리오 테스트에 실패했습니다.');
      }
      const run = (await response.json()) as EvalRun;
      await onRunCreated(run.id);
    } catch (runError) {
      setError(
        runError instanceof Error
          ? runError.message
          : '시나리오 테스트에 실패했습니다.',
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="panel workspace-section">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SCENARIO LAB</p>
          <h2>시나리오 생성 및 사람 검토</h2>
          <p className="section-description">
            AI가 생성·자동검증한 시나리오를 승인해야 품질 테스트에 사용할 수 있습니다.
          </p>
        </div>
        <div className="scenario-actions">
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <select value={policyId} onChange={(event) => setPolicyId(event.target.value)}>
            <option value="">정책 미지정</option>
            {policies.map((policy) => (
              <option key={policy.id} value={policy.id}>{policy.name}</option>
            ))}
          </select>
          <input
            type="number"
            min="1"
            max="10"
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
          />
          <button className="primary-button inline" onClick={() => void generate()} disabled={loading}>
            {loading ? '생성·검증 중…' : 'AI 시나리오 생성'}
          </button>
          <button
            className="primary-button inline"
            onClick={() => void runApprovedScenarios()}
            disabled={testing}
          >
            {testing ? '품질 테스트 중…' : '승인 시나리오 테스트'}
          </button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="scenario-grid">
        {scenarios.length === 0 && <div className="empty-state">생성된 시나리오가 없습니다.</div>}
        {scenarios.map((scenario) => (
          <article
            className="scenario-card"
            key={scenario.id}
            onClick={() => setSelectedScenario(scenario)}
            role="button"
            tabIndex={0}
          >
            <div className="scenario-meta">
              <span>{scenario.category || 'GENERAL'}</span>
              <span className={`scenario-status ${scenario.status.toLowerCase()}`}>
                {scenario.status}
              </span>
            </div>
            <h3>{scenario.title}</h3>
            <p>{scenario.prompt}</p>
            <div className="expected-box">
              <span>EXPECTED</span>
              {scenario.expectedOutput || '기대 답변 미지정'}
            </div>
            <div className="auto-validation">
              <strong>
                Auto verification {Math.round((scenario.autoValidation?.score ?? 0) * 100)}%
              </strong>
              <p>{scenario.autoValidation?.reason ?? '자동검증 정보 없음'}</p>
            </div>
            <span className="rubric-link">클릭하여 채점 루브릭 확인·수정 →</span>
            <div className="review-actions">
              <button onClick={(event) => { event.stopPropagation(); void review(scenario.id, 'REJECTED'); }}>거절</button>
              <button className="approve" onClick={(event) => { event.stopPropagation(); void review(scenario.id, 'APPROVED'); }}>승인</button>
            </div>
          </article>
        ))}
      </div>
      {selectedScenario && (
        <ScenarioRubricModal
          scenario={selectedScenario}
          onClose={() => setSelectedScenario(null)}
          onSaved={async () => {
            setSelectedScenario(null);
            await load();
          }}
        />
      )}
    </section>
  );
}

function ScenarioRubricModal({
  scenario,
  onClose,
  onSaved,
}: {
  scenario: Scenario;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [expectedOutput, setExpectedOutput] = useState(
    scenario.expectedOutput ?? '',
  );
  const [testOutput, setTestOutput] = useState(scenario.testOutput ?? '');
  const [rubric, setRubric] = useState<ScenarioRubric>(
    scenario.evaluationRubric ?? {},
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const updateList = (
    field: 'requiredConditions' | 'failConditions' | 'allowedVariations',
    value: string,
  ) => {
    setRubric((current) => ({
      ...current,
      [field]: value
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean),
    }));
  };

  const updateLevel = (
    metricIndex: number,
    levelIndex: number,
    value: string,
  ) => {
    setRubric((current) => ({
      ...current,
      metrics: (current.metrics ?? []).map((metric, currentMetricIndex) =>
        currentMetricIndex !== metricIndex
          ? metric
          : {
              ...metric,
              levels: metric.levels.map((level, currentLevelIndex) =>
                currentLevelIndex === levelIndex
                  ? { ...level, criteria: value, description: undefined }
                  : level,
              ),
            },
      ),
    }));
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/scenarios/${scenario.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testOutput: testOutput || null,
          expectedOutput,
          evaluationRubric: rubric,
        }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message ?? '루브릭 저장에 실패했습니다.');
      }
      await onSaved();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : '루브릭 저장에 실패했습니다.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="rubric-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rubric-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">SCENARIO RUBRIC</p>
            <h2 id="rubric-title">{scenario.title}</h2>
            <p>AI가 생성한 초안입니다. 수정 후 저장하면 다시 승인이 필요합니다.</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="닫기">×</button>
        </header>

        <div className="rubric-modal-body">
          <label>
            테스트용 AI OUTPUT
            <small>
              비어 있으면 내부 Ollama가 생성하고, 입력하면 이 답변을 그대로 평가합니다.
            </small>
            <textarea
              rows={5}
              placeholder="직접 평가할 AI 답변을 입력하세요. 기본값은 빈칸입니다."
              value={testOutput}
              onChange={(event) => setTestOutput(event.target.value)}
            />
          </label>
          <label>
            기대 답변
            <textarea
              rows={5}
              value={expectedOutput}
              onChange={(event) => setExpectedOutput(event.target.value)}
            />
          </label>

          <div className="rubric-metrics">
            {(rubric.metrics ?? []).length === 0 && (
              <div className="empty-state">
                기존 시나리오에는 AI 루브릭이 없습니다. 새로 생성한 시나리오부터 자동으로 포함됩니다.
              </div>
            )}
            {(rubric.metrics ?? []).map((metric, metricIndex) => (
              <article key={`${metric.key}-${metricIndex}`}>
                <div className="rubric-metric-title">
                  <strong>{metric.name}</strong>
                  <code>{metric.key}</code>
                </div>
                <div className="rubric-levels">
                  {metric.levels.map((level, levelIndex) => (
                    <label key={`${level.score}-${levelIndex}`}>
                      <span>{Math.round(level.score * 100)}점</span>
                      <textarea
                        rows={2}
                        value={level.criteria ?? level.description ?? ''}
                        onChange={(event) =>
                          updateLevel(metricIndex, levelIndex, event.target.value)
                        }
                      />
                    </label>
                  ))}
                </div>
              </article>
            ))}
          </div>

          <div className="rubric-condition-grid">
            <label>
              필수 조건 <small>한 줄에 하나</small>
              <textarea
                rows={5}
                value={(rubric.requiredConditions ?? []).join('\n')}
                onChange={(event) =>
                  updateList('requiredConditions', event.target.value)
                }
              />
            </label>
            <label>
              즉시 실패 조건 <small>한 줄에 하나</small>
              <textarea
                rows={5}
                value={(rubric.failConditions ?? []).join('\n')}
                onChange={(event) =>
                  updateList('failConditions', event.target.value)
                }
              />
            </label>
            <label>
              허용 가능한 표현·답변 범위 <small>한 줄에 하나</small>
              <textarea
                rows={5}
                value={(rubric.allowedVariations ?? []).join('\n')}
                onChange={(event) =>
                  updateList('allowedVariations', event.target.value)
                }
              />
            </label>
          </div>
          {error && <div className="error-banner">{error}</div>}
        </div>

        <footer>
          <button onClick={onClose}>취소</button>
          <button className="primary-button inline" onClick={() => void save()} disabled={saving}>
            {saving ? '저장 중…' : '수정 내용 저장'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function PolicyWorkspace({
  projects,
  onProjectsChanged,
}: {
  projects: Project[];
  onProjectsChanged: () => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [name, setName] = useState('고객상담 품질 정책');
  const [threshold, setThreshold] = useState(0.8);
  const [metrics, setMetrics] = useState<Metric[]>([
    { key: 'accuracy', name: '정책 정확성', description: '도메인 정책과 사실이 일치하는지 평가', weight: 0.5, required: true },
    { key: 'resolution', name: '문제 해결력', description: '다음 행동을 명확히 안내하는지 평가', weight: 0.3 },
    { key: 'tone', name: '응대 어조', description: '친절하고 정중한 표현인지 평가', weight: 0.2 },
  ]);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  const load = useCallback(async () => {
    if (!projectId) return;
    const response = await fetch(`${API_URL}/projects/${projectId}/policies`);
    setPolicies((await response.json()) as Policy[]);
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  if (projects.length === 0) {
    return <ProjectCreator onCreated={onProjectsChanged} />;
  }

  const save = async () => {
    await fetch(`${API_URL}/projects/${projectId}/policies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, passThreshold: threshold, maxRetries: 1, metrics }),
    });
    await load();
  };

  const updateMetric = (index: number, field: keyof Metric, value: string | number | boolean) => {
    setMetrics((items) => items.map((item, itemIndex) =>
      itemIndex === index ? { ...item, [field]: value } : item,
    ));
  };

  return (
    <div className="policy-layout">
      <section className="panel workspace-section">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">EVALUATION POLICY</p>
            <h2>도메인별 평가 지표</h2>
          </div>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </div>
        <div className="policy-form">
          <div className="form-row">
            <label>정책 이름<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>통과 기준<input type="number" min="0" max="1" step="0.05" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></label>
          </div>
          <div className="metric-editor">
            {metrics.map((metric, index) => (
              <div className="metric-row" key={metric.key}>
                <input value={metric.name} onChange={(event) => updateMetric(index, 'name', event.target.value)} />
                <input value={metric.description} onChange={(event) => updateMetric(index, 'description', event.target.value)} />
                <input type="number" min="0" max="1" step="0.1" value={metric.weight} onChange={(event) => updateMetric(index, 'weight', Number(event.target.value))} />
                <label className="required-check"><input type="checkbox" checked={metric.required ?? false} onChange={(event) => updateMetric(index, 'required', event.target.checked)} />필수</label>
              </div>
            ))}
          </div>
          <button className="primary-button" onClick={() => void save()}>평가 정책 저장</button>
        </div>
      </section>
      <section className="panel saved-policies">
        <div className="panel-heading compact"><div><p className="eyebrow">SAVED</p><h2>저장된 정책</h2></div></div>
        {policies.map((policy) => (
          <article key={policy.id}>
            <strong>{policy.name}</strong>
            <span>통과 {Math.round(policy.passThreshold * 100)}%</span>
            <small>{policy.metrics.length} metrics</small>
          </article>
        ))}
      </section>
    </div>
  );
}

export default App;
