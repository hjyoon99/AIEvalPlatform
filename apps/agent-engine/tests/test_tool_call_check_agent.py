import pytest

from app.agents.tool_call import ToolCallCheckAgent

WEATHER_PROMPT = "서울 날씨 알려줘."


@pytest.mark.integration
@pytest.mark.asyncio
async def test_tool_call_check_passes_valid_call():
    """질문 의도에 맞는 파라미터로 호출한 경우 valid=True여야 한다."""
    agent = ToolCallCheckAgent()

    result = await agent.run(
        prompt=WEATHER_PROMPT,
        output="서울은 현재 맑고 22도입니다.",
        tool_calls=[{"name": "get_weather", "arguments": {"city": "서울"}}],
    )

    assert result["valid"] is True
    assert result["issues"] == []


@pytest.mark.integration
@pytest.mark.asyncio
async def test_tool_call_check_flags_invalid_parameter():
    """질문은 서울 날씨인데 도쿄로 조회한 경우처럼 파라미터가 질문 의도와
    명백히 어긋나면 valid=False와 함께 문제를 반환해야 한다."""
    agent = ToolCallCheckAgent()

    result = await agent.run(
        prompt=WEATHER_PROMPT,
        output="도쿄는 현재 흐리고 18도입니다.",
        tool_calls=[{"name": "get_weather", "arguments": {"city": "도쿄"}}],
    )

    assert result["valid"] is False
    assert len(result["issues"]) >= 1


@pytest.mark.integration
@pytest.mark.asyncio
async def test_tool_call_check_accepts_string_tool_calls():
    """tool_calls 항목이 객체가 아니라 순수 문자열이어도 동작해야 한다
    (SDK의 unknown[] 계약과 호환)."""
    agent = ToolCallCheckAgent()

    result = await agent.run(
        prompt=WEATHER_PROMPT,
        output="서울은 현재 맑고 22도입니다.",
        tool_calls=["get_weather(city=서울)"],
    )

    assert "valid" in result


@pytest.mark.asyncio
async def test_tool_call_check_skips_llm_call_when_no_calls():
    """도구 호출 정보가 없으면 Ollama 호출 없이 즉시 검증 불가로 반환한다."""
    agent = ToolCallCheckAgent()

    result = await agent.run(
        prompt=WEATHER_PROMPT,
        output="서울은 맑습니다.",
        tool_calls=None,
    )

    assert result["valid"] is False
    assert result["issues"] == []
