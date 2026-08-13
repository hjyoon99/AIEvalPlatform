"""SupervisorAgent의 에스컬레이션 강제 로직과 규칙 기반 단축 경로를 검증한다.

이 파일은 두 종류로 나뉜다.

1. 순수 로직 / 규칙 기반 단축 경로 (기본 `pytest`로 실행됨, Ollama 불필요)
   - `_force_escalation_if_ambiguous`는 딕셔너리만 주고받는 순수 함수라
     Ollama 없이 즉시 검증할 수 있다.
   - `verification.error`, `isValid=False`, `evaluation.metrics.error` 세
     경로는 LLM 호출 전에 `return`하므로 Ollama 없이도 통과해야 한다.
   - Ollama 연결 실패 경로는 실제 Ollama가 떠 있는지와 무관하게, 존재하지
     않는 포트로 `client.host`를 바꿔치기해 연결 거부를 결정론적으로
     재현한다(mock이 아니라 진짜 `AsyncClient`로, 대상만 바꾼다).

2. 통합 테스트 (`@pytest.mark.integration`, `pytest -m integration`으로만
   실행됨, 로컬에 `ollama serve`와 `qwen3.5:4b`가 있어야 한다)
   - 실제 LLM 응답에 좌우되는 값(정확한 confidence 수치 등)은 단정하지
     않는다. 대신 코드가 "항상 보장해야 하는" 불변식만 검증한다 —
     예: 경계선 score는 모델이 confidence를 얼마로 내든 항상
     escalation되어야 한다.

각 테스트의 가설은 `docs/Supervisor-Escalation-Signal-Design.md`에서 실제
데이터로 검증한 내용을 그대로 옮긴 것이다. 테스트 실행 방법은 같은 문서의
"테스트 실행 방법" 절을 참고한다.
"""

import pytest
from ollama import AsyncClient

from app.agents.supervisor import (
    AMBIGUITY_CONFIDENCE_THRESHOLD,
    SupervisorAgent,
    _force_escalation_if_ambiguous,
)

# ---------------------------------------------------------------------------
# 1a. _force_escalation_if_ambiguous — 순수 함수, Ollama 불필요
# ---------------------------------------------------------------------------


def _base_decision(**overrides):
    """`_force_escalation_if_ambiguous`가 읽는 최소 필드만 채운 fixture.

    실제 `SupervisorDecisionSchema.model_dump()` 결과를 흉내 낸 것으로,
    이 함수는 `confidence`와 `escalation`만 읽고 쓰므로 나머지 필드는
    임의값이어도 무방하다.
    """
    decision = {
        "verdict": "PASS",
        "confidence": 0.95,
        "escalation": "NONE",
        "reason": "정상 판정",
        "issues": [],
        "recommendedAction": "",
    }
    decision.update(overrides)
    return decision


def test_force_escalation_when_confidence_below_threshold():
    """가설 1: confidence가 임계값 미만이면, score가 threshold에서 한참
    떨어져 있어(margin 큼) 전혀 경계선이 아니어도 escalation이 강제로
    켜져야 한다."""
    decision = _base_decision(confidence=AMBIGUITY_CONFIDENCE_THRESHOLD - 0.01)

    _force_escalation_if_ambiguous(decision, score=0.95, pass_threshold=0.7)

    assert decision["escalation"] == "ESCALATE_MULTI_JUDGE"


def test_force_escalation_when_score_within_margin_of_threshold():
    """가설 2: confidence가 아무리 높아도(0.95) score가 pass_threshold와
    BORDERLINE_SCORE_MARGIN 이내로 붙어 있으면 escalation이 강제로
    켜져야 한다. 실제 DB에 남아있던 과거 경계 케이스(score=0.65,
    threshold=0.7, 당시 qwen3.5:4b confidence=0.95)를 그대로 재현한
    값이다 — 이 케이스가 바로 confidence 단독 신호로는 놓쳤던 사례다."""
    decision = _base_decision(confidence=0.95, escalation="NONE")

    _force_escalation_if_ambiguous(decision, score=0.65, pass_threshold=0.7)

    assert decision["escalation"] == "ESCALATE_MULTI_JUDGE"


def test_no_escalation_for_clear_cut_case():
    """가설 3: confidence도 높고(0.95) score도 threshold에서 한참
    떨어져 있으면(margin 0.22 > 0.15) escalation은 NONE으로 유지돼야
    한다 — 코드 백스톱이 명백한 케이스까지 과잉 발동(오탐)하면 안 된다."""
    decision = _base_decision(confidence=0.95, escalation="NONE")

    _force_escalation_if_ambiguous(decision, score=0.92, pass_threshold=0.7)

    assert decision["escalation"] == "NONE"


def test_force_escalation_handles_floating_point_boundary():
    """가설 2b(부동소수점 회귀): score=0.85, threshold=0.7일 때 수학적
    margin은 정확히 0.15로 경계값 포함(<=) 조건에 걸려야 하는데, 파이썬의
    `abs(0.85 - 0.7)`은 부동소수점 오차로 0.15000000000000002가 되어
    순진하게 `<= 0.15`만 비교하면 걸리지 않는 회귀가 실제로 있었다
    (`scripts/compare_supervisor_ambiguity_signals.py`로 재현하다 발견)."""
    decision = _base_decision(confidence=0.95, escalation="NONE")

    _force_escalation_if_ambiguous(decision, score=0.85, pass_threshold=0.7)

    assert decision["escalation"] == "ESCALATE_MULTI_JUDGE"


def test_escalation_forcing_never_downgrades_llm_own_signal():
    """가설 4: 두 코드 신호(confidence, margin)가 전부 해당 없어도, LLM이
    이미 스스로 ESCALATE_MULTI_JUDGE를 냈다면 이 함수가 그걸 NONE으로
    되돌려선 안 된다. 강제는 단방향(NONE → ESCALATE_MULTI_JUDGE)이며
    반대 방향으로는 절대 움직이지 않는다."""
    decision = _base_decision(confidence=0.95, escalation="ESCALATE_MULTI_JUDGE")

    _force_escalation_if_ambiguous(decision, score=0.92, pass_threshold=0.7)

    assert decision["escalation"] == "ESCALATE_MULTI_JUDGE"


# ---------------------------------------------------------------------------
# 1b. 규칙 기반 즉시 반환 — LLM 호출 전에 return되므로 Ollama 불필요
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_verification_error_short_circuits_without_llm_call():
    """가설: Verifier 자체가 실행 실패(error)했으면, Ollama를 부르지 않고
    즉시 FAIL·confidence=1.0·escalation=NONE으로 반환해야 한다."""
    agent = SupervisorAgent()

    result = await agent.run(
        prompt="환불 규정을 설명해줘.",
        output="",
        verification={"error": "Ollama connection refused"},
        evaluation={"score": 0.0, "metrics": {}},
    )

    assert result["verdict"] == "FAIL"
    assert result["confidence"] == 1.0
    assert result["escalation"] == "NONE"


@pytest.mark.asyncio
async def test_invalid_verification_short_circuits_without_llm_call():
    """가설: Verifier가 isValid=False로 판정했으면, Ollama를 부르지 않고
    즉시 FAIL·confidence=1.0·escalation=NONE으로 반환해야 한다."""
    agent = SupervisorAgent()

    result = await agent.run(
        prompt="환불 규정을 설명해줘.",
        output="",
        verification={"isValid": False, "reason": "빈 답변입니다."},
        evaluation={"score": 0.0, "metrics": {}},
    )

    assert result["verdict"] == "FAIL"
    assert result["confidence"] == 1.0
    assert result["escalation"] == "NONE"


@pytest.mark.asyncio
async def test_evaluation_error_with_retries_left_short_circuits_without_llm_call():
    """가설: Evaluator 실행이 오류로 실패했고 재시도 여유가 남아있으면,
    Ollama를 부르지 않고 즉시 RETRY·escalation=NONE으로 반환해야 한다 —
    판정이 애매한 게 아니라 인프라 오류이므로 컨센서스로 보내지 않는다."""
    agent = SupervisorAgent()

    result = await agent.run(
        prompt="환불 규정을 설명해줘.",
        output="7일 이내 환불 가능합니다.",
        verification={"isValid": True, "reason": "유효함"},
        evaluation={"score": 0.0, "metrics": {"error": "Evaluator timeout"}},
        retry_count=0,
        max_retries=1,
    )

    assert result["verdict"] == "RETRY"
    assert result["escalation"] == "NONE"


@pytest.mark.asyncio
async def test_ollama_connection_failure_falls_back_to_score_threshold():
    """가설: Ollama 호출 자체가 실패하면(연결 거부 등), 예외를 잡아서
    score>=pass_threshold 여부로만 PASS/FAIL을 정하고 escalation은 NONE을
    유지해야 한다 — 인프라 장애는 판정 애매함이 아니므로 컨센서스 대상이
    아니다. 실제 Ollama가 떠 있는지와 무관하게, 닫힌 포트(127.0.0.1:1)로
    `client`를 바꿔치기해 연결 거부를 결정론적으로 재현한다."""
    agent = SupervisorAgent()
    agent.client = AsyncClient(host="http://127.0.0.1:1")

    result = await agent.run(
        prompt="환불 규정을 설명해줘.",
        output="7일 이내 환불 가능합니다.",
        verification={"isValid": True, "reason": "유효함"},
        evaluation={"score": 0.9, "metrics": {"reason": "정확함"}},
        pass_threshold=0.7,
    )

    assert result["verdict"] == "PASS"  # score(0.9) >= pass_threshold(0.7)
    assert result["escalation"] == "NONE"


# ---------------------------------------------------------------------------
# 2. 통합 테스트 — 실제 로컬 Ollama(qwen3.5:4b) 필요, `pytest -m integration`
# ---------------------------------------------------------------------------

# 실제 DB에 남아있던 경계 케이스(score=0.65, threshold=0.7)를 그대로 재현.
# `docs/Supervisor-Escalation-Signal-Design.md` §5, §8 "케이스 B"와 동일.
_BORDERLINE_CASE = dict(
    prompt="환불 규정을 설명해줘.",
    output="구매 후 일정 기간 내에 환불 가능합니다. 정확한 기간은 별도 문의가 필요합니다.",
    expected_output="구매 후 7일 이내 환불 가능합니다.",
    verification={"isValid": True, "reason": "답변이 존재하고 질문과 관련 있음"},
    evaluation={
        "score": 0.65,
        "metrics": {
            "reason": "질문에 답하려는 시도는 있으나 핵심 정보(기간)가 누락됨",
            "criteria": [
                {"key": "faithfulness", "score": 0.5, "reason": "구체적 기간을 명시하지 않음"},
                {"key": "answerRelevance", "score": 0.8, "reason": "질문 의도에는 관련 있음"},
            ],
        },
    },
    pass_threshold=0.7,
)

# 명백한 PASS. `docs/Supervisor-Escalation-Signal-Design.md` §8 "케이스 A"와 동일.
_CLEAR_CUT_CASE = dict(
    prompt="대한민국의 수도는?",
    output="서울입니다.",
    expected_output="서울",
    verification={"isValid": True, "reason": "정답"},
    evaluation={
        "score": 0.92,
        "metrics": {
            "reason": "정확함",
            "criteria": [{"key": "faithfulness", "score": 0.9, "reason": "정확"}],
        },
    },
    pass_threshold=0.7,
)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_borderline_score_always_escalates_regardless_of_model_confidence():
    """가설: score(0.65)가 pass_threshold(0.7)에서 margin(0.15) 이내인
    실제 과거 경계 케이스를 재현하면, qwen3.5:4b가 confidence를 얼마로
    내든(실측상 0.95로 높게 나옴 — 즉 LLM 자체는 이걸 애매하다고
    못 느낀다) escalation은 항상 ESCALATE_MULTI_JUDGE여야 한다. 이게 이번에
    추가한 코드 백스톱의 핵심 존재 이유다."""
    agent = SupervisorAgent(supervisor_model="qwen3.5:4b")

    result = await agent.run(**_BORDERLINE_CASE)

    assert result["escalation"] == "ESCALATE_MULTI_JUDGE"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_clear_cut_case_does_not_escalate_via_real_pipeline():
    """가설: score(0.92)가 pass_threshold(0.7)에서 한참 떨어진 명백한
    PASS 케이스는, 실제 Ollama를 태워도 escalation이 NONE으로 나와야
    한다 — 순수 함수 테스트(`test_no_escalation_for_clear_cut_case`)와
    같은 가설을 실제 파이프라인 전체로 다시 확인한다."""
    agent = SupervisorAgent(supervisor_model="qwen3.5:4b")

    result = await agent.run(**_CLEAR_CUT_CASE)

    assert result["escalation"] == "NONE"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_recommended_action_is_a_sentence_not_a_bare_keyword():
    """가설: `escalation` 필드를 `recommendedAction` 옆에 추가했을 때
    관찰됐던 회귀 — `recommendedAction`에 "RETRY"/"NONE" 같은 단일
    키워드가 나오는 버그(`docs/Supervisor-Escalation-Signal-Design.md`
    §6) — 가 스키마 수정(필드 재배치 + 설명/예시 보강) 이후 재발하지
    않아야 한다."""
    agent = SupervisorAgent(supervisor_model="qwen3.5:4b")

    result = await agent.run(**_BORDERLINE_CASE)

    reserved_keywords = {"PASS", "FAIL", "RETRY", "NONE", "ESCALATE_MULTI_JUDGE"}
    assert result["recommendedAction"].strip().upper() not in reserved_keywords
    assert len(result["recommendedAction"]) >= 5
