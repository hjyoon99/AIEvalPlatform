# Consensus Evaluator Fan-Out 설계 (Epic #37 / #41)

`#41`(consensus_evaluator 노드 구현, 병렬 fan-out)을 구현하며 나눈 논의, 발견한 문제와 해결 과정을 정리한다. 선행 문서: `docs/Supervisor-Escalation-Signal-Design.md`(`#38`/`#40`), `docs/ADR-Consensus-Judge-Models.md`(`#39`).

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
| `test_workers_only_connect_through_supervisor`(기존 확장) | `consensus_evaluator`가 hub-and-spoke 워커 집합 밖에 있고, `supervisor → consensus_evaluator → END` 토폴로지가 실제 컴파일된 그래프에 그대로 있는지 정적 엣지로 확인 |

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

## 6. 다음 단계 — 그리고 지금 빠져있는 연결고리

`#41`은 fan-out 메커니즘과 그래프 상태 안에서의 결과 수집까지만 담당한다. `consensus_results`(3개 모델의 독립 점수)를 실제로 다수결/편차 계산해 최종 판정에 반영하는 건 `#42`(aggregate_consensus)의 몫이다.

**한 가지 확인해둘 게 있다: 지금은 `consensus_results`가 `EvaluationState`(그래프 내부 상태) 밖으로 전혀 안 나간다.** `app/main.py`의 `run_evaluation_pipeline`이 `graph_result`에서 `verification`/`evaluation`/`supervision`/`retry_count`만 꺼내 `result_payload`를 만들고 반환하는데, `consensus_results`는 이 목록에 없다 — 즉 fan-out이 실행되고 3개 결과가 그래프 상태에 잘 쌓여도, `/agents/evaluate/sync` 응답에도, Backend의 `EvalResult`에도 지금은 저장되지 않고 그래프 실행이 끝나는 순간 버려진다. `#42`가 집계 로직을 만들 때 이 연결(`main.py` → API 응답 → Backend 저장)도 같이 뚫어야 한다.
