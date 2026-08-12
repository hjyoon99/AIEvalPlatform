from typing import Any, Dict, List, Optional

import pytest

from app.workflows.evaluation_graph import EvaluationWorkflow


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

    async def run(self, **kwargs) -> Dict[str, Any]:
        self.calls += 1
        self.received_kwargs = kwargs
        return {"score": self.score, "metrics": {"reason": "채점 완료"}}


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

    def __init__(self, retry_once: bool = False):
        self.retry_once = retry_once
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
            }
        if self.retry_once and kwargs["retry_count"] == 0:
            return {
                "verdict": "RETRY",
                "confidence": 1.0,
                "reason": "재평가가 필요합니다.",
                "issues": [],
                "recommendedAction": "다시 평가하세요.",
            }
        evaluation = kwargs["evaluation"]
        verdict = "PASS" if evaluation["score"] >= kwargs["pass_threshold"] else "FAIL"
        return {
            "verdict": verdict,
            "confidence": 1.0,
            "reason": "정상 판정",
            "issues": [],
            "recommendedAction": "",
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
    서로 직접 연결되지 않고, 반드시 supervisor를 거쳐서만 오간다는 그래프 구조를 검증한다."""
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
    for edge in workflow.graph.get_graph().edges:
        if edge.source in workers:
            assert edge.target == "supervisor"
        if edge.target in workers:
            assert edge.source == "supervisor"


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
