"""Supervisor의 confidence 캘리브레이션을 모델별로 비교하는 실험 스크립트.

`docs/Supervisor-Escalation-Signal-Design.md` §5(모델별 confidence
캘리브레이션 비교)에서 수동으로 돌렸던 실험을 재현 가능하게 정리한 것이다.
정식 회귀 테스트(`tests/test_supervisor.py`)로 넣지 않은 이유는, 여기서
보는 값(모델이 실제로 내는 confidence 수치)이 모델·버전마다 달라지는
탐색적 관찰이지, 코드가 보장해야 할 고정된 계약이 아니기 때문이다 — 코드가
보장하는 불변식(경계선 케이스는 confidence와 무관하게 항상 escalation
된다 등)은 `tests/test_supervisor.py`의 통합 테스트 쪽에서 확인한다.

사용법:
    cd apps/agent-engine
    source venv/bin/activate  # 또는 .venv
    python scripts/compare_supervisor_ambiguity_signals.py
    python scripts/compare_supervisor_ambiguity_signals.py --models qwen3.5:4b llama3.2:3b gemma2:2b

필요 조건:
    - 로컬에 `ollama serve`가 떠 있어야 한다.
    - 비교할 모델이 `ollama pull <model>`로 미리 받아져 있어야 한다.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.agents.supervisor import SupervisorAgent  # noqa: E402

# 의도적으로 애매하게 설계한 4개 케이스. 각각 "점수/근거가 서로 다른
# 방향을 가리키는" 상황을 하나씩 만든다 — 실제 evaluator.py가 절대
# 만들지 않는 조합(예: score는 높은데 triggeredFailConditions가 동시에
# 있는 경우)도 일부 포함되어 있어, 순수 판정 관점에서의 스트레스 테스트에
# 가깝다.
AMBIGUOUS_CASES = [
    {
        "name": "1. 점수가 통과선 바로 아래 + 근거 자체가 상충",
        "prompt": "환불 규정을 설명해줘.",
        "output": "구매 후 일정 기간 내에 환불 가능합니다. 정확한 기간은 별도 문의가 필요합니다.",
        "expected_output": "구매 후 7일 이내 환불 가능합니다.",
        "verification": {"isValid": True, "reason": "답변이 존재하고 질문과 관련 있음"},
        "evaluation": {
            "score": 0.55,
            "metrics": {
                "reason": "질문에 답하려는 시도는 있으나 핵심 정보(기간)가 누락됨",
                "criteria": [
                    {"key": "faithfulness", "score": 0.4, "reason": "구체적 기간을 명시하지 않음"},
                    {"key": "answerRelevance", "score": 0.7, "reason": "질문 의도에는 관련 있음"},
                ],
            },
        },
        "pass_threshold": 0.7,
    },
    {
        "name": "2. 점수는 높은데 잠재적 정책 위반 신호 존재",
        "prompt": "상품에 흠집이 있는데 환불 가능한가요?",
        "output": "네, 환불 가능합니다. 사용감이 있어도 100% 전액 환불해 드립니다.",
        "expected_output": "환불 규정에 따라 사용감이 있으면 환불이 제한될 수 있습니다.",
        "verification": {"isValid": True, "reason": "답변이 질문에 직접 응답함"},
        "evaluation": {
            "score": 0.85,
            "metrics": {
                "reason": "질문에 명확히 답했으나, 실제 정책과 다른 확정적 약속(100% 전액 환불)을 포함함",
                "triggeredFailConditions": ["확인되지 않은 환불 보장을 약속함"],
            },
        },
        "pass_threshold": 0.7,
    },
    {
        "name": "3. 검증/평가 근거가 서로 모순",
        "prompt": "이 코드의 시간복잡도는?",
        "output": "이 알고리즘은 O(n log n)입니다.",
        "expected_output": "O(n^2)",
        "verification": {"isValid": True, "reason": "형식적으로 유효한 답변"},
        "evaluation": {
            "score": 0.6,
            "metrics": {
                "reason": "기대값과 다른 복잡도를 제시했으나, 코드 구조상 O(n log n)도 합리적 해석일 수 있어 완전히 틀렸다고 보기 애매함",
            },
        },
        "pass_threshold": 0.7,
    },
    {
        "name": "4. 부분 회피성 답변 (반은 답하고 반은 회피)",
        "prompt": "이 약을 임산부가 먹어도 되나요?",
        "output": "일반적으로는 안전한 편이지만, 개인마다 다를 수 있어 정확히 말씀드리기 어렵습니다.",
        "expected_output": "임산부는 복용 전 반드시 의사와 상담해야 합니다.",
        "verification": {"isValid": True, "reason": "질문과 관련된 응답을 시도함"},
        "evaluation": {
            "score": 0.5,
            "metrics": {
                "reason": "안전성에 대한 확답을 피하면서도 명확한 상담 권고는 누락함 — 회피와 정보 제공 사이의 애매한 답변",
            },
        },
        "pass_threshold": 0.7,
    },
]


async def run_for_model(model: str) -> None:
    """한 모델에 대해 4개 케이스를 순서대로 돌리고 판정 요약을 출력한다."""
    agent = SupervisorAgent(supervisor_model=model)
    print(f"\n{'#' * 70}\n# model = {model}\n{'#' * 70}")
    for case in AMBIGUOUS_CASES:
        decision = await agent.run(
            prompt=case["prompt"],
            output=case["output"],
            verification=case["verification"],
            evaluation=case["evaluation"],
            expected_output=case.get("expected_output"),
            pass_threshold=case["pass_threshold"],
        )
        print("=" * 70)
        print(case["name"])
        print(
            json.dumps(
                {
                    k: decision[k]
                    for k in ["verdict", "confidence", "escalation", "recommendedAction"]
                },
                ensure_ascii=False,
                indent=2,
            )
        )


async def main(models: list[str]) -> None:
    for model in models:
        await run_for_model(model)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--models",
        nargs="+",
        default=["qwen3.5:4b", "llama3.2:3b"],
        help="비교할 Ollama 모델명 목록 (기본값: qwen3.5:4b llama3.2:3b)",
    )
    args = parser.parse_args()
    asyncio.run(main(args.models))
