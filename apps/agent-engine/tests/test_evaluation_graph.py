from typing import Any, Dict, List, Optional

import pytest

from app.workflows.evaluation_graph import (
    CONSENSUS_MODELS,
    CONSENSUS_SPREAD_THRESHOLD,
    EvaluationWorkflow,
    _aggregate_consensus_results,
)


class FakeVerifier:
    def __init__(self, is_valid: bool, reason: str = "reason"):
        self.is_valid = is_valid
        self.reason = reason
        self.calls = 0

    async def run(self, **kwargs) -> Dict[str, Any]:
        self.calls += 1
        return {"isValid": self.is_valid, "reason": self.reason}


class FakeEvaluator:
    def __init__(self, score: float = 0.9):
        self.score = score
        self.calls = 0
        self.received_kwargs: Dict[str, Any] = {}
        # #42 집계 테스트에서 triggeredFailConditions 등을 실어 보내려고
        # 쓴다. 지정 안 하면 기본 metrics를 그대로 쓴다.
        self.metrics_override: Optional[Dict[str, Any]] = None

    async def run(self, **kwargs) -> Dict[str, Any]:
        self.calls += 1
        self.received_kwargs = kwargs
        metrics = self.metrics_override or {"reason": "채점 완료"}
        return {"score": self.score, "metrics": metrics}


class FakeConsensusFactory:
    """`consensus_evaluator_factory`(#41)의 테스트 대역.

    실제 `EvaluatorAgent`를 만드는 대신, 모델명 하나당 새 `FakeEvaluator`
    인스턴스를 만들어 `created`에 기록해둔다. 이걸로 두 가지를 검증할 수
    있다: (1) fan-out된 각 모델이 서로 다른(격리된) 인스턴스를 썼는지,
    (2) 각 인스턴스가 실제로 어떤 kwargs를 받았는지(`supervisor_feedback`이
    새어 들어가지 않는지 등).

    이 팩토리를 안 쓰고 기본값(진짜 `EvaluatorAgent`)을 그대로 두면,
    escalation이 뜨는 테스트가 실제 Ollama를 호출해버려 기본 테스트
    스위트가 느려지고 Ollama 의존성이 생긴다 — 실제로 이 파일의
    `test_escalation_during_retry_survives_to_final_verdict`에서
    한 번 발생했던 회귀다.
    """

    def __init__(
        self,
        score: float = 0.8,
        scores_by_model: Optional[Dict[str, float]] = None,
        metrics_by_model: Optional[Dict[str, Dict[str, Any]]] = None,
    ):
        self.score = score
        # 모델별로 다른 점수/metrics를 내야 하는 #42 집계 테스트(spread,
        # fail_disagreement)를 위한 것. 지정 안 된 모델은 기본 self.score를 쓴다.
        self.scores_by_model = scores_by_model or {}
        self.metrics_by_model = metrics_by_model or {}
        self.created: Dict[str, FakeEvaluator] = {}

    def __call__(self, model: str) -> FakeEvaluator:
        agent = FakeEvaluator(score=self.scores_by_model.get(model, self.score))
        if model in self.metrics_by_model:
            agent.metrics_override = self.metrics_by_model[model]
        self.created[model] = agent
        return agent


class FakeGroundedness:
    def __init__(
        self,
        grounded: bool = True,
        unsupported_claims: Optional[List[Dict[str, Any]]] = None,
        confidence: float = 0.9,
    ):
        self.grounded = grounded
        self.unsupported_claims = unsupported_claims or []
        self.confidence = confidence
        self.calls = 0

    async def run(self, **kwargs) -> Dict[str, Any]:
        self.calls += 1
        return {
            "grounded": self.grounded,
            "unsupportedClaims": self.unsupported_claims,
            "confidence": self.confidence,
        }


class FakeToolCall:
    def __init__(
        self,
        valid: bool = True,
        issues: Optional[List[Dict[str, Any]]] = None,
        confidence: float = 0.9,
    ):
        self.valid = valid
        self.issues = issues or []
        self.confidence = confidence
        self.calls = 0

    async def run(self, **kwargs) -> Dict[str, Any]:
        self.calls += 1
        return {
            "valid": self.valid,
            "issues": self.issues,
            "confidence": self.confidence,
        }


class FakeSupervisor:
    """Verifier가 무효 판정을 내리면 LLM 호출 없이 즉시 FAIL을 반환하는
    실제 SupervisorAgent의 규칙 기반 단축 로직을 흉내 낸 테스트 대역."""

    def __init__(
        self,
        retry_once: bool = False,
        escalate_on_retry: bool = False,
        escalate_final: bool = False,
    ):
        self.retry_once = retry_once
        # RETRY 라운드(retry_count==0)의 응답에 escalation을
        # "ESCALATE_MULTI_JUDGE"로 실어 보낼지. #40의 "RETRY 도중 뜬
        # escalation 신호가 최종 판정까지 유실되지 않아야 한다"는 요구를
        # 재현하기 위한 것 — 최종(2번째) 라운드는 일부러 NONE을 반환해서,
        # 최종 escalation이 그 라운드 자체가 아니라 누적값에서 오는지 검증한다.
        self.escalate_on_retry = escalate_on_retry
        # 최종(PASS/FAIL 확정) 라운드의 응답에 escalation을 직접 실어
        # 보낼지. RETRY를 거치지 않고 바로 애매함이 뜨는, 실제로 더 흔한
        # 경로(#41 fan-out 트리거)를 재현하기 위한 것.
        self.escalate_final = escalate_final
        self.calls = 0

    async def run(self, **kwargs) -> Dict[str, Any]:
        self.calls += 1
        verification = kwargs["verification"]
        if not verification.get("isValid", False):
            return {
                "verdict": "FAIL",
                "confidence": 1.0,
                "reason": verification.get("reason", "유효성 검증에 실패했습니다."),
                "issues": ["VERIFICATION_FAILED"],
                "recommendedAction": "원본 AI 답변을 수정하거나 다시 생성하세요.",
                "escalation": "NONE",
            }
        if self.retry_once and kwargs["retry_count"] == 0:
            return {
                "verdict": "RETRY",
                "confidence": 1.0,
                "reason": "재평가가 필요합니다.",
                "issues": [],
                "recommendedAction": "다시 평가하세요.",
                "escalation": "ESCALATE_MULTI_JUDGE" if self.escalate_on_retry else "NONE",
            }
        evaluation = kwargs["evaluation"]
        verdict = "PASS" if evaluation["score"] >= kwargs["pass_threshold"] else "FAIL"
        return {
            "verdict": verdict,
            "confidence": 1.0,
            "reason": "정상 판정",
            "issues": [],
            "recommendedAction": "",
            "escalation": "ESCALATE_MULTI_JUDGE" if self.escalate_final else "NONE",
        }


@pytest.mark.asyncio
async def test_invalid_verification_skips_evaluator_and_stubs_evaluation():
    verifier = FakeVerifier(is_valid=False, reason="빈 답변입니다.")
    evaluator = FakeEvaluator()
    supervisor = FakeSupervisor()
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
    )

    result = await workflow.run(prompt="질문", output="")

    assert evaluator.calls == 0
    assert result["evaluation"] == {
        "score": 0.0,
        "metrics": {},
        "skipped": True,
        "reason": "빈 답변입니다.",
    }
    assert result["supervision"]["verdict"] == "FAIL"


@pytest.mark.asyncio
async def test_valid_verification_still_calls_evaluator():
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor()
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
    )

    result = await workflow.run(prompt="질문", output="괜찮은 답변", pass_threshold=0.7)

    assert evaluator.calls == 1
    assert result["evaluation"].get("skipped") is None
    assert result["supervision"]["verdict"] == "PASS"


def test_workers_only_connect_through_supervisor():
    """워커(verify/evaluate/skip_evaluation/groundedness_check/tool_call_check)가
    서로 직접 연결되지 않고, 반드시 supervisor를 거쳐서만 오간다는 그래프 구조를 검증한다.

    `consensus_evaluator`/`aggregate_consensus`(#41/#42)는 의도적으로 이
    집합에서 제외한다 — hub-and-spoke 패턴에 속하는 "워커"가 아니라,
    supervisor가 Send로 fan-out하고 aggregate_consensus를 거쳐 곧장
    END로 빠지는 별도 경로이기 때문이다(아래에서 그 토폴로지를 직접
    검증한다)."""
    workflow = EvaluationWorkflow(
        verifier=FakeVerifier(is_valid=True),
        evaluator=FakeEvaluator(),
        supervisor=FakeSupervisor(),
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
    )

    workers = {
        "verify",
        "evaluate",
        "skip_evaluation",
        "groundedness_check",
        "tool_call_check",
    }
    edges = list(workflow.graph.get_graph().edges)
    for edge in edges:
        if edge.source in workers:
            assert edge.target == "supervisor"
        if edge.target in workers:
            assert edge.source == "supervisor"

    # consensus_evaluator: supervisor에서만 들어오고(fan-out), 나갈 땐
    # supervisor가 아니라 aggregate_consensus로 간다(fan-in) — 워커와는
    # 다른 토폴로지임을 명시적으로 확인.
    assert any(
        e.source == "supervisor" and e.target == "consensus_evaluator"
        for e in edges
    )
    assert any(
        e.source == "consensus_evaluator" and e.target == "aggregate_consensus"
        for e in edges
    )
    assert not any(
        e.source == "consensus_evaluator" and e.target == "supervisor"
        for e in edges
    )
    # aggregate_consensus: consensus_evaluator에서만 들어오고, 곧장
    # END로 나간다 — #42가 생기기 전까지는 aggregate_consensus 결과가
    # supervisor로 되먹임되지 않는다.
    assert any(
        e.source == "aggregate_consensus" and e.target == "__end__" for e in edges
    )
    assert not any(
        e.source == "aggregate_consensus" and e.target == "supervisor"
        for e in edges
    )


@pytest.mark.asyncio
async def test_rag_metadata_routes_through_groundedness_check():
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor()
    groundedness = FakeGroundedness(grounded=True)
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=groundedness,
        tool_call=FakeToolCall(),
    )

    result = await workflow.run(
        prompt="질문",
        output="근거 문서를 인용한 답변",
        pass_threshold=0.7,
        output_metadata={"retrievedDocuments": ["doc-1"]},
    )

    assert groundedness.calls == 1
    assert result["groundedness_result"]["grounded"] is True
    assert result.get("tool_call_result") is None
    assert evaluator.calls == 1
    assert evaluator.received_kwargs.get("groundedness_result") == result["groundedness_result"]
    assert result["supervision"]["verdict"] == "PASS"


@pytest.mark.asyncio
async def test_ungrounded_result_still_reaches_evaluator():
    """groundedness_check가 grounded=False를 내도 evaluate로 계속 진행되고,
    그 결과가 EvaluatorAgent.run()에 그대로 전달된다(감점 참고 신호로 반영하기 위함)."""
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor()
    groundedness = FakeGroundedness(
        grounded=False,
        unsupported_claims=[{"claim": "배송비도 환불됩니다", "reason": "문서에 언급 없음"}],
    )
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=groundedness,
        tool_call=FakeToolCall(),
    )

    result = await workflow.run(
        prompt="질문",
        output="근거 문서를 인용한 답변",
        pass_threshold=0.7,
        output_metadata={"retrievedDocuments": ["doc-1"]},
    )

    assert result["groundedness_result"]["grounded"] is False
    assert evaluator.received_kwargs.get("groundedness_result") == result["groundedness_result"]


@pytest.mark.asyncio
async def test_tool_call_metadata_routes_through_tool_call_check():
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor()
    tool_call = FakeToolCall(valid=True)
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=tool_call,
    )

    result = await workflow.run(
        prompt="질문",
        output="도구를 호출한 답변",
        pass_threshold=0.7,
        output_metadata={"toolCalls": [{"name": "search", "arguments": {"q": "날씨"}}]},
    )

    assert tool_call.calls == 1
    assert result["tool_call_result"]["valid"] is True
    assert result.get("groundedness_result") is None
    assert evaluator.calls == 1
    assert evaluator.received_kwargs.get("tool_call_result") == result["tool_call_result"]
    assert result["supervision"]["verdict"] == "PASS"


@pytest.mark.asyncio
async def test_invalid_tool_call_result_still_reaches_evaluator():
    """tool_call_check가 valid=False를 내도 evaluate로 계속 진행되고,
    그 결과가 EvaluatorAgent.run()에 그대로 전달된다(감점 참고 신호로 반영하기 위함)."""
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor()
    tool_call = FakeToolCall(
        valid=False,
        issues=[
            {
                "toolName": "get_weather",
                "issue": "invalid_parameter",
                "reason": "질문은 서울 날씨인데 도쿄로 조회함",
            }
        ],
    )
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=tool_call,
    )

    result = await workflow.run(
        prompt="질문",
        output="도구를 호출한 답변",
        pass_threshold=0.7,
        output_metadata={"toolCalls": [{"name": "get_weather", "arguments": {"city": "도쿄"}}]},
    )

    assert result["tool_call_result"]["valid"] is False
    assert evaluator.received_kwargs.get("tool_call_result") == result["tool_call_result"]


@pytest.mark.asyncio
async def test_no_metadata_skips_both_checks():
    """메타데이터가 없는 기존 요청은 "일반" 유형으로 처리되어 두 체크를 모두 건너뛴다."""
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor()
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
    )

    result = await workflow.run(
        prompt="질문", output="평범한 답변", pass_threshold=0.7
    )

    assert result.get("groundedness_result") is None
    assert result.get("tool_call_result") is None
    assert evaluator.calls == 1
    assert result["supervision"]["verdict"] == "PASS"


@pytest.mark.asyncio
async def test_retry_loop_still_calls_evaluator_again():
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor(retry_once=True)
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
    )

    result = await workflow.run(
        prompt="질문", output="괜찮은 답변", pass_threshold=0.7, max_retries=1
    )

    assert verifier.calls == 1
    assert evaluator.calls == 2
    assert result["retry_count"] == 1
    assert result["supervision"]["verdict"] == "PASS"
    # 대조군: RETRY 라운드가 애매하지 않았다면(escalate_on_retry=False),
    # 누적 로직이 괜히 최종 escalation을 켜버리는 오탐이 없어야 한다.
    assert result["supervision"]["escalation"] == "NONE"


@pytest.mark.asyncio
async def test_escalation_during_retry_survives_to_final_verdict():
    """가설(#40): 1차 판정(RETRY)에서 escalation="ESCALATE_MULTI_JUDGE"가
    떴다가, RETRY 진입으로 `supervision`이 `None`으로 리셋되고 2차
    판정(PASS)에서는 escalation="NONE"이 나와도, 최종 저장되는
    `result["supervision"]["escalation"]`은 "ESCALATE_MULTI_JUDGE"로
    유지되어야 한다 — 중간 라운드의 애매함 신호가 리셋 때문에 유실되면
    안 된다."""
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor(retry_once=True, escalate_on_retry=True)
    # 누적된 escalation 때문에 최종적으로 #41 fan-out이 트리거된다 —
    # 가짜 팩토리를 안 넣으면 기본값(진짜 EvaluatorAgent)이 실제 Ollama를
    # 3번 호출해버린다(이 테스트에서 실제로 벌어졌던 회귀).
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
        consensus_evaluator_factory=FakeConsensusFactory(),
    )

    result = await workflow.run(
        prompt="질문", output="괜찮은 답변", pass_threshold=0.7, max_retries=1
    )

    assert result["supervision"]["verdict"] == "PASS"
    assert result["supervision"]["escalation"] == "ESCALATE_MULTI_JUDGE"
    assert result["escalated_during_retries"] is True


@pytest.mark.asyncio
async def test_consensus_fan_out_produces_tagged_result_per_model():
    """가설(#41): 최종 판정에서 escalation이 뜨면, CONSENSUS_MODELS
    개수만큼 consensus_evaluator가 fan-out되고, 각 결과가 모델명으로
    태깅된 채 consensus_results에 전부 모인다 — operator.add 리듀서
    덕분에 병렬로 반환된 원소 1개짜리 리스트들이 유실 없이 이어붙는다."""
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor(escalate_final=True)
    consensus_factory = FakeConsensusFactory(score=0.8)
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
        consensus_evaluator_factory=consensus_factory,
    )

    result = await workflow.run(
        prompt="질문", output="괜찮은 답변", pass_threshold=0.7
    )

    assert result["supervision"]["escalation"] == "ESCALATE_MULTI_JUDGE"
    assert len(result["consensus_results"]) == len(CONSENSUS_MODELS)
    tagged_models = {r["model"] for r in result["consensus_results"]}
    assert tagged_models == set(CONSENSUS_MODELS)
    for r in result["consensus_results"]:
        assert r["score"] == 0.8


@pytest.mark.asyncio
async def test_consensus_evaluator_instances_are_isolated():
    """가설(#41 완료 조건 "인스턴스 간 완전한 격리"): fan-out된 각 모델은
    factory가 매번 새로 만든 서로 다른 EvaluatorAgent 인스턴스를 쓴다 —
    하나를 재사용해서 상태를 공유하지 않는다."""
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor(escalate_final=True)
    consensus_factory = FakeConsensusFactory()
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
        consensus_evaluator_factory=consensus_factory,
    )

    await workflow.run(prompt="질문", output="괜찮은 답변", pass_threshold=0.7)

    assert len(consensus_factory.created) == len(CONSENSUS_MODELS)
    instances = list(consensus_factory.created.values())
    assert len({id(instance) for instance in instances}) == len(instances)
    for instance in instances:
        assert instance.calls == 1


@pytest.mark.asyncio
async def test_consensus_evaluator_does_not_receive_supervisor_feedback():
    """가설(#41): 1차 Supervisor가 RETRY로 남긴 supervisor_feedback이
    있어도(재평가 사유), consensus_evaluator는 이걸 EvaluatorAgent에
    넘기지 않는다 — 1차 판정의 근거가 컨센서스 모델에게 새어 들어가면
    "서로의 결과를 안 본다"는 #37 원칙(anchoring 방지)이 깨지기 때문이다."""
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor(retry_once=True, escalate_final=True)
    consensus_factory = FakeConsensusFactory()
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
        consensus_evaluator_factory=consensus_factory,
    )

    result = await workflow.run(
        prompt="질문", output="괜찮은 답변", pass_threshold=0.7, max_retries=1
    )

    # RETRY를 한 번 거쳤으니 supervisor_feedback 자체는 상태에 존재해야 한다.
    assert result.get("supervisor_feedback") == "재평가가 필요합니다."
    # 그런데도 consensus_evaluator가 받은 kwargs엔 없어야 한다.
    for instance in consensus_factory.created.values():
        assert "supervisor_feedback" not in instance.received_kwargs


@pytest.mark.asyncio
async def test_no_consensus_fan_out_when_not_escalated():
    """대조군: escalation이 뜨지 않는 평범한 케이스에서는 consensus_evaluator가
    아예 호출되지 않아야 한다 — 애매하지 않은 케이스까지 매번 3개 모델을
    추가로 돌리면 비용 낭비다."""
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor()
    consensus_factory = FakeConsensusFactory()
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
        consensus_evaluator_factory=consensus_factory,
    )

    result = await workflow.run(
        prompt="질문", output="괜찮은 답변", pass_threshold=0.7
    )

    assert result["supervision"]["escalation"] == "NONE"
    assert result["consensus_results"] == []
    assert consensus_factory.created == {}


@pytest.mark.integration
@pytest.mark.asyncio
async def test_consensus_evaluator_node_works_with_real_default_factory():
    """가설(#41 통합): `consensus_evaluator_factory`를 안 넘기면 기본값인
    실제 `EvaluatorAgent`가 쓰여서, 실제 로컬 Ollama로 구조화 출력을 낸다.
    세 모델 각각의 구조화 출력 준수율은 `#39` 벤치마크
    (`scripts/benchmark_judge_models.py`, `docs/ADR-Consensus-Judge-Models.md`)
    에서 이미 확인했으므로, 여기서는 그래프 노드 자체가 실제 에이전트와
    맞물려도 정상 동작하는지만 대표로 하나 확인한다."""
    workflow = EvaluationWorkflow(
        verifier=FakeVerifier(is_valid=True),
        evaluator=FakeEvaluator(),
        supervisor=FakeSupervisor(),
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
        # consensus_evaluator_factory 생략 → 기본값(진짜 EvaluatorAgent) 사용
    )

    state = {
        "prompt": "대한민국의 수도는?",
        "output": "서울입니다.",
        "expected_output": "서울",
        "criteria": [],
        "agent_prompts": {},
        "pass_threshold": 0.7,
        "consensus_model": "qwen3.5:4b",
    }
    result = await workflow._consensus_evaluator(state)

    tagged = result["consensus_results"][0]
    assert tagged["model"] == "qwen3.5:4b"
    assert "error" not in tagged.get("metrics", {})
    assert isinstance(tagged["score"], float)


# ---------------------------------------------------------------------------
# _aggregate_consensus_results — 순수 함수, Ollama 불필요 (#42)
# ---------------------------------------------------------------------------


def _consensus_result(model: str, score: float, **metrics_overrides) -> Dict[str, Any]:
    """`_aggregate_consensus_results`에 넣을 fixture. 실제
    `consensus_evaluator`가 반환하는 모양({"model", "score", "metrics"})을
    흉내 낸다."""
    metrics = {
        "reason": "채점 완료",
        "triggeredFailConditions": [],
        "missingRequiredConditions": [],
    }
    metrics.update(metrics_overrides)
    return {"model": model, "score": score, "metrics": metrics}


def test_aggregate_consensus_converges_when_spread_is_low():
    """가설(#42 시나리오 1 — spread 낮음): 3개 점수가 서로 가까우면
    (spread <= CONSENSUS_SPREAD_THRESHOLD) CONVERGED로 분류돼야 한다."""
    results = [
        _consensus_result("qwen3.5:4b", 0.85),
        _consensus_result("llama3.2:3b", 0.9),
        _consensus_result("mistral:7b", 0.8),
    ]

    summary = _aggregate_consensus_results(results)

    assert summary["verdict"] == "CONVERGED"
    assert summary["spread"] == pytest.approx(0.1)  # 부동소수점 오차 방지
    assert summary["medianScore"] == 0.85
    assert summary["failDisagreement"] is False
    assert summary["scoresByModel"] == {
        "qwen3.5:4b": 0.85,
        "llama3.2:3b": 0.9,
        "mistral:7b": 0.8,
    }


def test_aggregate_consensus_flags_spread_too_high():
    """가설(#42 시나리오 2 — spread 높음): 3개 점수가 크게 갈리면
    (spread > CONSENSUS_SPREAD_THRESHOLD) SPREAD_TOO_HIGH로 분류돼야 한다."""
    results = [
        _consensus_result("qwen3.5:4b", 0.9),
        _consensus_result("llama3.2:3b", 0.4),
        _consensus_result("mistral:7b", 0.6),
    ]

    summary = _aggregate_consensus_results(results)

    assert summary["spread"] == 0.5
    assert summary["spread"] > CONSENSUS_SPREAD_THRESHOLD
    assert summary["verdict"] == "SPREAD_TOO_HIGH"
    assert summary["failDisagreement"] is False


def test_aggregate_consensus_fail_disagreement_takes_priority_over_spread():
    """가설(#42 시나리오 3 — fail_disagreement): 필수/실패조건 판정
    자체가 모델 간에 갈리면(하나는 위반 발견, 나머지는 안 함) 점수
    spread와 무관하게 FAIL_DISAGREEMENT로 분류돼야 한다 — #37 설계
    원칙("평균으로 해결할 수 없는 의미 해석의 차이")에 따라 spread보다
    우선순위가 높다. 실제 evaluator.py라면 위반 발견 시 score를 0으로
    강제해 자연히 spread도 커지지만, 이 테스트는 그 상관관계와
    무관하게 집계 함수 자체가 fail_disagreement를 먼저 보는지
    직접 검증하기 위해 점수를 일부러 가깝게(spread 낮음) 뒀다."""
    results = [
        _consensus_result(
            "qwen3.5:4b", 0.7, triggeredFailConditions=["확인되지 않은 환불 보장을 약속함"]
        ),
        _consensus_result("llama3.2:3b", 0.75),
        _consensus_result("mistral:7b", 0.72),
    ]

    summary = _aggregate_consensus_results(results)

    assert summary["spread"] <= CONSENSUS_SPREAD_THRESHOLD  # spread만 보면 CONVERGED감
    assert summary["failDisagreement"] is True
    assert summary["verdict"] == "FAIL_DISAGREEMENT"


def test_aggregate_consensus_no_disagreement_when_all_models_agree_on_fail():
    """대조군: 3개 모델 전부 동일하게 실패 조건을 발견했다면(또는 전부
    발견 안 했다면) fail_disagreement가 아니다 — "판정이 갈렸다"가
    아니라 "다들 똑같이 봤다"이므로."""
    results = [
        _consensus_result("qwen3.5:4b", 0.0, triggeredFailConditions=["위반"]),
        _consensus_result("llama3.2:3b", 0.0, triggeredFailConditions=["위반"]),
        _consensus_result("mistral:7b", 0.0, triggeredFailConditions=["위반"]),
    ]

    summary = _aggregate_consensus_results(results)

    assert summary["failDisagreement"] is False
    assert summary["verdict"] == "CONVERGED"


# ---------------------------------------------------------------------------
# aggregate_consensus 그래프 통합 (fan-out → fan-in) — Ollama 불필요 (#42)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_aggregate_consensus_runs_after_fan_in_with_per_model_scores():
    """가설(#42): supervisor가 escalation을 확정하면 3개 모델로 fan-out되고,
    LangGraph가 전원의 결과를 기다렸다가(fan-in) aggregate_consensus를
    한 번 실행해 consensus_summary를 최종 결과에 남긴다."""
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor(escalate_final=True)
    consensus_factory = FakeConsensusFactory(
        scores_by_model={
            "qwen3.5:4b": 0.9,
            "llama3.2:3b": 0.4,
            "mistral:7b": 0.6,
        }
    )
    workflow = EvaluationWorkflow(
        verifier=verifier,
        evaluator=evaluator,
        supervisor=supervisor,
        groundedness=FakeGroundedness(),
        tool_call=FakeToolCall(),
        consensus_evaluator_factory=consensus_factory,
    )

    result = await workflow.run(
        prompt="질문", output="괜찮은 답변", pass_threshold=0.7
    )

    assert len(result["consensus_results"]) == len(CONSENSUS_MODELS)
    summary = result["consensus_summary"]
    assert summary["verdict"] == "SPREAD_TOO_HIGH"
    assert summary["spread"] == 0.5
    assert summary["scoresByModel"] == {
        "qwen3.5:4b": 0.9,
        "llama3.2:3b": 0.4,
        "mistral:7b": 0.6,
    }
