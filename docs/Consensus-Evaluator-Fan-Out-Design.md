# Consensus Evaluator Fan-Out / 집계 / 저장 설계 (Epic #37 / #41 / #42 / #43)

`#41`(consensus_evaluator 노드 구현, 병렬 fan-out), `#42`(aggregate_consensus 집계 로직), `#43`(EvalResult.evaluation에 컨센서스 상세 저장)를 구현하며 나눈 논의, 발견한 문제와 해결 과정을 정리한다. 선행 문서: `docs/Supervisor-Escalation-Signal-Design.md`(`#38`/`#40`), `docs/ADR-Consensus-Judge-Models.md`(`#39`).

## 1. 배경과 범위

`#37` 에픽 다이어그램상 `judge1/judge2/judge3`(독립 병렬, 서로의 결과를 보지 않음) 단계를 구현하는 게 `#41`이다. 완료 조건은 "3개 모델이 병렬로 실행되고 각각 독립된 점수를 반환합니다."

이슈 원문을 보면 fan-out 대상은 `SupervisorAgent`가 아니라 **`EvaluatorAgent`**다("Send API로 3개 모델에 대해 독립 병렬 EvaluatorAgent 실행") — 최종 판정 합의(`aggregate_consensus`)는 `#42`가 담당하고, `#41`은 순수하게 "3개 모델이 각자 독립적으로 다시 채점한다"는 fan-out 메커니즘만 만든다.

## 2. 설계 논의 — 구현 전에 정한 것들

### 2.1 트리거 지점

기존 `_supervisor_node`의 종결 분기(`#40`에서 `escalated_so_far`를 최종 `escalation`에 반영하는 지점)에서, `END`로 바로 가는 대신 컨센서스로 fan-out하도록 분기를 추가했다. RETRY와 달리 컨센서스는 "1차 판정은 이미 확정된 채로, 검증용 재채점을 추가로 붙이는 것"이라 `verdict`(PASS/FAIL)는 그대로 두고 `escalation`만 확인해서 분기한다.

### 2.2 모델 3종

`#39` ADR에서 확정한 `qwen3.5:4b`, `llama3.2:3b`, `mistral:7b`를 `CONSENSUS_MODELS` 상수로 하드코딩했다(`app/workflows/evaluation_graph.py`). 향후 EvalRun 설정으로 옮길 여지를 주석으로 남겨뒀다.

### 2.3 `supervisor_feedback` 누출 — 논의 중 발견한 문제

기존 `_evaluate` 노드는 RETRY 재진입 시 `state["supervisor_feedback"]`(1차 Supervisor가 남긴 재평가 사유)을 `EvaluatorAgent`에 같이 넘긴다. 설계 논의 중에, 이걸 컨센서스 3개 모델에도 그대로 넘기면 **1차 판정의 근거가 컨센서스 모델에게 새어 들어가서, "서로의 결과를 보지 않는다"는 `#37` 원칙(anchoring 방지)이 깨진다**는 걸 짚었다.

**결정: `consensus_evaluator`는 `supervisor_feedback`을 의도적으로 전달하지 않는다.** `prompt`/`output`/`expected_output`/`criteria`/`groundedness_result`/`tool_call_result`는 동일하게 넘기되, `supervisor_feedback`만 뺐다. 테스트로 고정했다(§4).

### 2.4 병렬 결과 수집 — `Annotated[..., operator.add]`

`EvaluationState`는 원래 전부 "덮어쓰기" 필드였다. 3개 인스턴스가 동시에 같은 상태 키에 쓰면 마지막 하나만 남고 나머지 둘이 사라진다. 그래서 `consensus_results: Annotated[List[Dict[str, Any]], operator.add]`로 선언해, 각 인스턴스가 원소 1개짜리 리스트를 반환해도 LangGraph가 자동으로 이어붙이게 했다. `EvaluationState`에서 리듀서가 다른 유일한 필드다.

### 2.5 격리 — 인스턴스별로 완전히 새 `EvaluatorAgent`

`#41` 완료 조건에 명시된 "인스턴스 간 완전한 격리"를 위해, `consensus_evaluator` 노드는 매 fan-out 호출마다 `consensus_evaluator_factory(model)`로 새 `EvaluatorAgent`를 만든다. 기존 `verifier`/`evaluator`/`supervisor`/`groundedness`/`tool_call`처럼 하나의 공유 인스턴스를 재사용하지 않는다 — 팩토리를 `EvaluationWorkflow.__init__`에 주입 가능하게 해서(기본값은 `EvaluatorAgent` 클래스 자체), 테스트에서는 실제 Ollama 없이 가짜 팩토리로 교체할 수 있게 했다(§3.1의 회귀와 직결).

### 2.6 fan-out 이후는 일단 `END`

`#42`(aggregate_consensus)가 아직 없어서, `consensus_evaluator`는 hub-and-spoke 패턴(`supervisor`로 복귀) 밖에 있는 별도 노드로 만들고 실행 후 곧장 `END`로 보낸다. 최종 판정(`supervision`)은 여전히 1차 Supervisor의 것을 그대로 쓰고, `consensus_results`는 결과에 같이 담기기만 한다 — `#42`가 이 사이에 집계 단계로 들어올 자리를 남겨둔다.

## 3. 구현 중 발견한 문제와 해결

### 3.1 기본 테스트 스위트가 조용히 실제 Ollama를 호출하기 시작함

구현 직후 `pytest tests/`(기본, Ollama 불필요해야 함)를 돌렸는데 0.2초짜리 스위트가 **33초**로 늘어났다. `--durations`로 확인하니 `test_escalation_during_retry_survives_to_final_verdict`(`#40`에서 작성, `#41`과 무관한 목적의 테스트) 하나가 30초를 잡아먹고 있었다.

**원인:** 이 테스트는 `EvaluationWorkflow(...)`를 만들 때 `consensus_evaluator_factory`를 넘기지 않았다. 이 테스트의 `FakeSupervisor(escalate_on_retry=True)`가 누적 escalation을 발생시키는데, 팩토리를 안 넘기면 기본값인 **진짜 `EvaluatorAgent`**가 쓰여서 `CONSENSUS_MODELS` 3개에 실제 Ollama 호출이 나갔다. `#41`을 붙이기 전까지는 이 테스트가 escalation까지만 확인하고 끝났는데, `#41`이 그 뒤에 실제 네트워크 호출을 매다는 부작용을 조용히 만든 것이다.

**해결:** 이 테스트에 `consensus_evaluator_factory=FakeConsensusFactory()`를 추가해 원래 목적(escalation 신호 보존 확인)에만 집중하도록 고쳤다. 재발 방지를 위해 `FakeConsensusFactory`의 docstring에 이 회귀 사실을 명시해뒀다 — 앞으로 `escalate_on_retry`/`escalate_final`을 쓰는 테스트를 새로 작성할 때 주의하라는 신호다.

```python
# 수정 전 (실제 Ollama 3번 호출, 30초+)
workflow = EvaluationWorkflow(
    verifier=verifier, evaluator=evaluator, supervisor=supervisor,
    groundedness=FakeGroundedness(), tool_call=FakeToolCall(),
)

# 수정 후 (가짜 팩토리, 0.01초)
workflow = EvaluationWorkflow(
    verifier=verifier, evaluator=evaluator, supervisor=supervisor,
    groundedness=FakeGroundedness(), tool_call=FakeToolCall(),
    consensus_evaluator_factory=FakeConsensusFactory(),
)
```

## 4. 테스트

`apps/agent-engine/tests/test_evaluation_graph.py`에 추가(전부 Ollama 불필요, 기본 스위트):

| 테스트 | 검증하는 가설 |
|---|---|
| `test_consensus_fan_out_produces_tagged_result_per_model` | escalation이 뜨면 `CONSENSUS_MODELS` 개수만큼 fan-out되고, 각 결과가 모델명으로 태깅된 채 `consensus_results`에 전부 모인다(`operator.add` 리듀서 유실 없음 확인) |
| `test_consensus_evaluator_instances_are_isolated` | 각 fan-out 인스턴스가 서로 다른 객체(다른 `id()`)를 쓴다 — 완료 조건 "인스턴스 간 완전한 격리" 직접 검증 |
| `test_consensus_evaluator_does_not_receive_supervisor_feedback` | RETRY를 거쳐 `supervisor_feedback`이 상태에 있어도, `consensus_evaluator`가 받은 kwargs엔 없다(§2.3) |
| `test_no_consensus_fan_out_when_not_escalated` | 대조군 — escalation이 안 뜨면 `consensus_evaluator`가 아예 호출 안 됨(비용 낭비 방지) |
| `test_workers_only_connect_through_supervisor`(기존 확장) | `consensus_evaluator`가 hub-and-spoke 워커 집합 밖에 있고, `supervisor → consensus_evaluator` 토폴로지가 실제 컴파일된 그래프에 그대로 있는지 정적 엣지로 확인(`#42` 이후엔 `→ aggregate_consensus → END`로 이어짐, §7) |

통합 테스트(`@pytest.mark.integration`, 로컬 Ollama 필요) 1개 추가:

- `test_consensus_evaluator_node_works_with_real_default_factory` — `consensus_evaluator_factory`를 생략(기본값 = 진짜 `EvaluatorAgent`)하고 `qwen3.5:4b`로 노드를 직접 호출, 실제 구조화 출력이 정상적으로 태깅되어 돌아오는지 확인. 세 모델 각각의 구조화 출력 준수율 자체는 `#39` 벤치마크(`docs/ADR-Consensus-Judge-Models.md`)에서 이미 확인했으므로, 여기서는 그래프 노드 배선이 실제 에이전트와도 맞물려 동작하는지만 대표로 확인한다.

**결과:** 기본 스위트 29개 통과(0.27초), 통합 스위트 10개 통과(29초, 그중 신규 1개는 실제 Ollama 호출 포함).

## 5. 실행 방법

```bash
cd apps/agent-engine
source venv/bin/activate

# 기본 테스트만 (Ollama 불필요)
pytest tests/test_evaluation_graph.py -v

# 통합 테스트까지 포함 (로컬 Ollama + qwen3.5:4b 필요)
pytest tests/test_evaluation_graph.py -m integration -v
```

## 6. `#42` — aggregate_consensus 집계 로직

### 6.1 설계

이슈 문구가 구체적이라 논의는 짧게 마쳤다. `consensus_evaluator → aggregate_consensus → END`로 그래프를 연결(기존 `consensus_evaluator → END`를 대체)했다 — LangGraph가 fan-out된 `CONSENSUS_MODELS` 개수만큼의 `consensus_evaluator` 인스턴스가 전부 끝날 때까지 기다렸다가(fan-in) `aggregate_consensus`를 정확히 한 번만 호출해주므로, 별도의 대기/집계 동기화 로직이 필요 없었다.

집계는 두 신호를 분리해서 본다.

1. **점수 spread**(`max - min`)와 **중앙값**. `CONSENSUS_SPREAD_THRESHOLD = 0.3`(이슈 원문 잠정치) 이하면 수렴됨.
2. **`fail_disagreement`**: `triggeredFailConditions`/`missingRequiredConditions`가 있다/없다 자체가 모델 간에 갈리는 경우. `#37` 설계 원칙("필수/실패조건 판정 불일치는 평균으로 해결할 수 없는 의미 해석의 차이이므로 무조건 사람 검토로 보낸다")에 따라 **spread보다 우선순위가 높다** — spread가 낮아도 fail_disagreement면 무조건 `FAIL_DISAGREEMENT`로 분류한다.

세 시나리오는 `CONVERGED`(수렴) / `SPREAD_TOO_HIGH`(수렴 안 됨) / `FAIL_DISAGREEMENT`(의미 불일치, 항상 사람 검토)로 `consensus_summary`(새 상태 필드)에 저장된다. 순수 코드 집계라 LLM 호출이 전혀 없다.

`aggregate_consensus`는 LLM 호출이 없는 순수 함수(`_aggregate_consensus_results`)를 감싼 노드라, `#38`/`#40`의 `_force_escalation_if_ambiguous`/`_apply_retry_exhaustion`과 같은 패턴(그래프 노드 안에 로직을 두지 않고 별도 테스트 가능한 함수로 추출)을 그대로 따랐다.

### 6.2 구현 중 발견한 문제 — 같은 부동소수점 버그가 여기도 있었음

`#38`에서 `BORDERLINE_SCORE_MARGIN` 비교식에 있었던 것과 똑같은 문제가 여기도 있었다. 테스트를 작성하며 점수 `[0.85, 0.9, 0.8]`의 spread를 확인했는데, 파이썬에서 `0.9 - 0.8`이 `0.09999999999999998`로 나왔다(단정 실패로 발견). 더 심각한 건 `[0.9, 0.6]`처럼 **정확히 threshold(0.3)에 걸치는 경계값**에서 `0.9 - 0.6 = 0.30000000000000004`가 나와 `> 0.3` 비교를 잘못 통과시킬 수 있다는 점 — 의도상 경계값은 `CONVERGED`(수렴)로 봐야 하는데, 부동소수점 오차 때문에 `SPREAD_TOO_HIGH`로 잘못 분류될 뻔했다.

**해결**: `#38`과 동일한 패턴으로 아주 작은 오차(`1e-9`)만큼 여유를 두고 비교하도록 고쳤다.

```python
elif spread > CONSENSUS_SPREAD_THRESHOLD + 1e-9:
    verdict = "SPREAD_TOO_HIGH"
```

## 7. `#42` 테스트

`apps/agent-engine/tests/test_evaluation_graph.py`에 추가(전부 Ollama 불필요):

| 테스트 | 검증하는 가설 |
|---|---|
| `test_aggregate_consensus_converges_when_spread_is_low` | 시나리오 1 — spread 낮음 → `CONVERGED` |
| `test_aggregate_consensus_flags_spread_too_high` | 시나리오 2 — spread 높음 → `SPREAD_TOO_HIGH` |
| `test_aggregate_consensus_fail_disagreement_takes_priority_over_spread` | 시나리오 3 — spread는 낮아도(경계 안) fail_disagreement면 `FAIL_DISAGREEMENT`가 우선 |
| `test_aggregate_consensus_no_disagreement_when_all_models_agree_on_fail` | 대조군 — 3개 모델이 전부 동일하게 실패 조건을 발견하면 disagreement가 아니다 |
| `test_aggregate_consensus_runs_after_fan_in_with_per_model_scores` | 그래프 통합 — fan-out(3개, 서로 다른 점수) → fan-in → `aggregate_consensus` 1회 실행 → `consensus_summary`가 최종 결과에 정확히 반영 |
| `test_workers_only_connect_through_supervisor`(재확장) | `aggregate_consensus`가 `consensus_evaluator`에서만 들어오고 곧장 `END`로 나가는지, `supervisor`로 되먹임되지 않는지 정적 엣지로 확인 |

**결과:** 기본 스위트 34개 통과(0.42초), 통합 스위트 10개 통과(33초, `#42`는 LLM 호출이 없어 통합 테스트 추가 없음).

## 8. 실행 방법

```bash
cd apps/agent-engine
source venv/bin/activate

# 기본 테스트만 (Ollama 불필요)
pytest tests/test_evaluation_graph.py -v

# 통합 테스트까지 포함 (로컬 Ollama + qwen3.5:4b 필요)
pytest tests/test_evaluation_graph.py -m integration -v
```

## 9. `#41`/`#42` 완료 시점의 미해결 연결고리

`#42`까지는 그래프 내부 상태(`consensus_results`/`consensus_summary`)까지만 채웠다. `app/main.py`의 `run_evaluation_pipeline`이 `graph_result`에서 `verification`/`evaluation`/`supervision`/`retry_count`만 꺼내 `result_payload`를 만들었기 때문에, fan-out·집계가 그래프 안에서는 잘 동작해도 `/agents/evaluate/sync` 응답에도 Backend의 `EvalResult`에도 저장되지 않고 그래프 실행이 끝나는 순간 버려졌다. `#43`이 이 연결을 뚫었다(§10).

## 10. `#43` — EvalResult.evaluation에 컨센서스 상세 저장

### 10.1 설계

`§9`의 연결고리를 뚫는 작업이다. `app/main.py`의 `run_evaluation_pipeline`에서, `graph_result`(`consensus_results`/`consensus_summary`)를 `eval_result`(`evaluation` JSONB가 될 딕셔너리)에 병합하는 순수 함수 `_attach_consensus_detail`을 추가했다 — `#38`/`#40`/`#42`와 같은 패턴(그래프/파이프라인 로직에서 테스트 가능한 순수 함수를 분리)을 그대로 따랐다.

이슈가 요구하는 필드 이름과 내부 값 사이에 **극성이 반대인 것이 하나 있다**: 내부적으로는 `failDisagreement`(불일치 여부, `True`=불일치)로 계산해왔는데, 이슈가 요구하는 필드명은 `failConditionAgreement`(합의 여부, `True`=합의)다. 그대로 복사하면 의미가 정반대로 저장되므로, `not consensus_summary["failDisagreement"]`로 뒤집어서 옮겼다.

```python
"consensusDetail": {
    "models": [r["model"] for r in consensus_results],
    "scores": [r["score"] for r in consensus_results],
    "spread": consensus_summary["spread"],
    "failConditionAgreement": not consensus_summary["failDisagreement"],  # 극성 반전
    "verdict": consensus_summary["verdict"],
}
```

`models`/`scores`를 같은 `consensus_results` 순회에서 한 번에 만들기 때문에, `Send` fan-out의 병렬 실행 순서가 실행마다 달라져도(LangGraph가 그 순서를 보장하지 않음) 인덱스가 서로 어긋나는 문제는 없다 — 두 배열이 항상 같은 소스 리스트에서, 같은 순서로 파생되기 때문이다.

Backend는 이미 `evaluation?: Record<string, unknown>`으로 느슨하게 타입돼 있어서, TS 쪽 변경 없이 새 필드가 그대로 `EvalResult.evaluation` JSONB까지 통과한다.

### 10.2 Dashboard까지 같이 처리하기로 함

이슈 자체는 Dashboard `ResultExplorerCard` 표시를 "선택 사항, 후속 이슈로 분리 가능"으로 명시했지만, 나중에 잊어버릴 수 있다는 이유로 같은 세션에서 같이 처리하고 커밋만 분리하기로 했다.

`apps/dashboard/src/App.tsx`의 `ResultExplorerCard`(정확히 이슈가 언급한 그 이름의 컴포넌트)에:

- `explorer-score` 영역에 `CONSENSUS` 배지 추가(컨센서스가 적용된 케이스만)
- 기존 Verifier(01)/Evaluator(02)/Supervisor(03) 3단계 `AgentStep` 뒤에, 컨센서스가 적용된 케이스에 한해 4번째 `AgentStep`("Consensus")을 추가 — 모델별 점수를 `metric-chips`로, spread/판정 근거를 `reason`으로, `failConditionAgreement`를 `footer`로 표시
- `verdict`(`CONVERGED`/`SPREAD_TOO_HIGH`/`FAIL_DISAGREEMENT`)에 따라 배지/카드 색을 pass/warn/fail 톤으로 매핑
- `.agent-timeline`의 `grid-template-columns`을 `repeat(3, ...)` 고정에서 `repeat(auto-fit, minmax(220px, 1fr))`로 바꿔, 3장/4장 모두 레이아웃이 안 깨지게 함

### 10.3 검증 — 실제로 Dashboard까지 띄워서 확인

`tsc -b`만으로는 "타입이 맞다"만 증명하지, "실제로 이렇게 보인다"는 증명하지 못한다. 그래서:

1. 로컬 Postgres의 실제 `EvalResult` 행 하나를 **임시로** 패치해 `consensusApplied: true`와 `consensusDetail`(3개 모델, spread 0.85, `FAIL_DISAGREEMENT`)을 채워 넣었다.
2. Backend(`pnpm --filter backend start:dev`)와 Dashboard(`pnpm --filter dashboard dev`)를 로컬로 띄웠다.
3. `chromium-cli`가 이 환경에 없어서, Playwright(`npx playwright`, 스크래치패드에 임시 설치, 시스템 Google Chrome을 `channel: 'chrome'`로 구동)로 대체해 헤드리스 브라우저를 직접 구동했다.
4. 실제 화면에서 `CASE 03`에 `CONSENSUS` 배지와 4번째 "Consensus" 카드(모델별 점수 칩, 빨간 톤 = FAIL_DISAGREEMENT, "필수/실패조건 판정: 모델 간 불일치 — 사람 검토 필요" 문구)가 정상적으로 렌더링되는 걸 스크린샷으로 확인했다. 3장짜리 케이스(CASE 01, 02)는 레이아웃이 그대로 유지됐다.
5. 콘솔에 404 로그가 하나 있었지만, 모든 네트워크 응답을 캡처해 대조해봐도 대응하는 실패 요청이 없었다 — 이번 변경이 새 리소스 URL을 참조하지 않으므로(순수 React/CSS 변경) 무관한 항목으로 판단했다.
6. **검증 후 원상복구**: 패치했던 `EvalResult.evaluation`을 원래 값으로 정확히 되돌렸다(바이트 단위로 diff 확인). 로컬 dev 서버도 종료했다.

### 10.4 테스트

`apps/agent-engine/tests/test_main.py`(신규, Ollama 불필요):

| 테스트 | 검증하는 가설 |
|---|---|
| `test_no_consensus_detail_when_not_applied` | 컨센서스 미적용 시 `consensusApplied=False`, `consensusDetail=None`, 기존 키 보존 |
| `test_no_consensus_detail_when_consensus_results_is_none` | `consensus_results`가 `None`으로 와도(초기 상태) 예외 없이 처리 |
| `test_consensus_detail_maps_fields_and_inverts_fail_disagreement_polarity` | `failDisagreement=False` → `failConditionAgreement=True`로 정확히 뒤집힘 |
| `test_consensus_detail_inverts_polarity_the_other_direction_too` | 대조군 — `failDisagreement=True` → `failConditionAgreement=False`(반대 방향도 확인, 한쪽만 우연히 맞는 부호 실수 방지) |

**결과:** 기본 스위트 38개 통과(0.40초). Dashboard는 `tsc -b` 통과 + 위 §10.3의 실제 브라우저 검증.

## 11. 다음 단계

`#37` 에픽의 `#38`~`#43`이 전부 끝났다. 남은 건 `#37` 다이어그램상 "Epic E"(REVIEW_REQUIRED 라우팅, confidence/spread 임계값 실측 캘리브레이션 등) — 아직 이슈 자체가 없다.
