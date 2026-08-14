"""`_attach_consensus_detail`(#43)을 검증한다. 순수 함수라 Ollama 불필요."""

from app.main import _attach_consensus_detail


def test_no_consensus_detail_when_not_applied():
    """가설: 컨센서스가 적용되지 않은 일반 케이스(consensus_results가
    비었거나 None)는 consensusApplied=False, consensusDetail=None이어야
    하고, 원본 eval_result의 기존 키(score 등)는 그대로 보존돼야 한다."""
    eval_result = {"score": 0.9, "passed": True, "metrics": {"reason": "정확함"}}

    result = _attach_consensus_detail(eval_result, [], None)

    assert result["consensusApplied"] is False
    assert result["consensusDetail"] is None
    assert result["score"] == 0.9
    assert result["metrics"] == {"reason": "정확함"}


def test_no_consensus_detail_when_consensus_results_is_none():
    """가설: consensus_results가 아예 None으로 와도(에스컬레이션이 없었던
    일반 경로) 예외 없이 consensusApplied=False로 처리돼야 한다."""
    result = _attach_consensus_detail({"score": 0.9}, None, None)

    assert result["consensusApplied"] is False
    assert result["consensusDetail"] is None


def test_consensus_detail_maps_fields_and_inverts_fail_disagreement_polarity():
    """가설: 컨센서스가 적용되면 models/scores가 같은 순서로 짝지어지고,
    spread/verdict는 그대로 옮겨지되, failDisagreement(불일치 여부,
    True=불일치)는 failConditionAgreement(합의 여부, True=합의)로
    **극성이 뒤집혀서** 저장돼야 한다 — #43 이슈가 요구하는 필드명이
    내부 값과 반대 의미이기 때문이다."""
    eval_result = {"score": 0.5, "metrics": {}}
    consensus_results = [
        {"model": "qwen3.5:4b", "score": 0.0, "metrics": {}},
        {"model": "llama3.2:3b", "score": 0.85, "metrics": {}},
        {"model": "mistral:7b", "score": 0.4, "metrics": {}},
    ]
    consensus_summary = {
        "verdict": "SPREAD_TOO_HIGH",
        "medianScore": 0.4,
        "spread": 0.85,
        "failDisagreement": False,
        "scoresByModel": {"qwen3.5:4b": 0.0, "llama3.2:3b": 0.85, "mistral:7b": 0.4},
    }

    result = _attach_consensus_detail(eval_result, consensus_results, consensus_summary)

    assert result["consensusApplied"] is True
    detail = result["consensusDetail"]
    assert detail["models"] == ["qwen3.5:4b", "llama3.2:3b", "mistral:7b"]
    assert detail["scores"] == [0.0, 0.85, 0.4]
    assert detail["spread"] == 0.85
    assert detail["verdict"] == "SPREAD_TOO_HIGH"
    # failDisagreement=False(불일치 없음) -> failConditionAgreement=True(합의함)
    assert detail["failConditionAgreement"] is True


def test_consensus_detail_inverts_polarity_the_other_direction_too():
    """가설(위 테스트의 대조군): failDisagreement=True(불일치 있음)면
    failConditionAgreement=False(합의 안 함)로 뒤집혀야 한다 — 한쪽
    방향만 우연히 맞고 반대 방향은 틀리는 부호 실수를 잡기 위한 것."""
    eval_result = {"score": 0.7, "metrics": {}}
    consensus_results = [
        {"model": "qwen3.5:4b", "score": 0.0, "metrics": {}},
        {"model": "llama3.2:3b", "score": 0.75, "metrics": {}},
        {"model": "mistral:7b", "score": 0.72, "metrics": {}},
    ]
    consensus_summary = {
        "verdict": "FAIL_DISAGREEMENT",
        "medianScore": 0.72,
        "spread": 0.75,
        "failDisagreement": True,
        "scoresByModel": {"qwen3.5:4b": 0.0, "llama3.2:3b": 0.75, "mistral:7b": 0.72},
    }

    result = _attach_consensus_detail(eval_result, consensus_results, consensus_summary)

    assert result["consensusDetail"]["failConditionAgreement"] is False
