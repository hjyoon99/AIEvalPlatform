import pytest

from app.agents.groundedness import GroundednessAgent

REFUND_POLICY_DOCUMENT = {
    "content": (
        "환불 정책: 구매 후 7일 이내에는 상품 결함 여부와 관계없이 전액 환불이 "
        "가능합니다. 배송비는 고객이 부담합니다."
    ),
    "source": "refund-policy.md",
}


@pytest.mark.integration
@pytest.mark.asyncio
async def test_groundedness_distinguishes_grounded_answer():
    """근거 문서 내용과 일치하는 답변은 grounded=True, 근거 없는 주장이 없어야 한다."""
    agent = GroundednessAgent()

    result = await agent.run(
        prompt="환불 정책이 어떻게 되나요?",
        output="구매 후 7일 이내라면 상품에 문제가 없어도 전액 환불받을 수 있습니다.",
        retrieved_documents=[REFUND_POLICY_DOCUMENT],
    )

    assert result["grounded"] is True
    assert result["unsupportedClaims"] == []


@pytest.mark.integration
@pytest.mark.asyncio
async def test_groundedness_flags_unsupported_claim():
    """근거 문서와 모순/무관한 주장이 섞인 답변은 grounded=False와 함께
    근거 없는 주장을 unsupportedClaims에 담아 반환해야 한다."""
    agent = GroundednessAgent()

    result = await agent.run(
        prompt="환불 정책이 어떻게 되나요?",
        output=(
            "구매 후 7일 이내라면 전액 환불받을 수 있고, "
            "배송비도 저희가 전액 부담해드립니다."
        ),
        retrieved_documents=[REFUND_POLICY_DOCUMENT],
    )

    assert result["grounded"] is False
    assert len(result["unsupportedClaims"]) >= 1


@pytest.mark.integration
@pytest.mark.asyncio
async def test_groundedness_accepts_plain_string_documents():
    """retrievedDocuments 항목이 {content, source} 객체가 아니라 순수
    문자열이어도 동일하게 동작해야 한다(SDK의 unknown[] 계약과 호환)."""
    agent = GroundednessAgent()

    result = await agent.run(
        prompt="환불 정책이 어떻게 되나요?",
        output="구매 후 7일 이내라면 전액 환불받을 수 있습니다.",
        retrieved_documents=[REFUND_POLICY_DOCUMENT["content"]],
    )

    assert result["grounded"] is True


@pytest.mark.asyncio
async def test_groundedness_skips_llm_call_when_no_documents():
    """근거 문서가 없으면 Ollama 호출 없이 즉시 검증 불가로 반환한다."""
    agent = GroundednessAgent()

    result = await agent.run(
        prompt="환불 정책이 어떻게 되나요?",
        output="7일 이내 환불 가능합니다.",
        retrieved_documents=None,
    )

    assert result["grounded"] is False
    assert result["unsupportedClaims"] == []
