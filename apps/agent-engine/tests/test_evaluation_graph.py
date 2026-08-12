from typing import Any, Dict

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

    async def run(self, **kwargs) -> Dict[str, Any]:
        self.calls += 1
        return {"score": self.score, "metrics": {"reason": "채점 완료"}}


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
        verifier=verifier, evaluator=evaluator, supervisor=supervisor
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
        verifier=verifier, evaluator=evaluator, supervisor=supervisor
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
    workflow = EvaluationWorkflow(
        verifier=verifier, evaluator=evaluator, supervisor=supervisor
    )

    result = await workflow.run(
        prompt="질문",
        output="근거 문서를 인용한 답변",
        pass_threshold=0.7,
        output_metadata={"retrievedDocuments": ["doc-1"]},
    )

    assert result["groundedness_result"]["checked"] is False
    assert result.get("tool_call_result") is None
    assert evaluator.calls == 1
    assert result["supervision"]["verdict"] == "PASS"


@pytest.mark.asyncio
async def test_tool_call_metadata_routes_through_tool_call_check():
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor()
    workflow = EvaluationWorkflow(
        verifier=verifier, evaluator=evaluator, supervisor=supervisor
    )

    result = await workflow.run(
        prompt="질문",
        output="도구를 호출한 답변",
        pass_threshold=0.7,
        output_metadata={"toolCalls": [{"name": "search"}]},
    )

    assert result["tool_call_result"]["checked"] is False
    assert result.get("groundedness_result") is None
    assert evaluator.calls == 1
    assert result["supervision"]["verdict"] == "PASS"


@pytest.mark.asyncio
async def test_no_metadata_skips_both_checks():
    """메타데이터가 없는 기존 요청은 "일반" 유형으로 처리되어 두 체크를 모두 건너뛴다."""
    verifier = FakeVerifier(is_valid=True)
    evaluator = FakeEvaluator(score=0.9)
    supervisor = FakeSupervisor()
    workflow = EvaluationWorkflow(
        verifier=verifier, evaluator=evaluator, supervisor=supervisor
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
        verifier=verifier, evaluator=evaluator, supervisor=supervisor
    )

    result = await workflow.run(
        prompt="질문", output="괜찮은 답변", pass_threshold=0.7, max_retries=1
    )

    assert verifier.calls == 1
    assert evaluator.calls == 2
    assert result["retry_count"] == 1
    assert result["supervision"]["verdict"] == "PASS"
