"""#39 벤치마크: 컨센서스 후보 모델의 구조화 출력 준수율과 응답 속도.

`#41`(consensus_evaluator)이 실제로 병렬 fan-out하는 대상은 `SupervisorAgent`가
아니라 `EvaluatorAgent`다(#41 이슈 원문: "Send API로 3개 모델에 대해 독립
병렬 EvaluatorAgent 실행"). 그래서 이 벤치마크는 `EvaluatorAgent.run()`을
기준으로, 각 후보 모델이

1. `DynamicEvaluationSchema`에 맞는 구조화 출력을 예외 없이 만들어내는지
   (준수율 = 1 - 예외로 폴백한 비율)
2. 케이스 하나당 응답 시간이 얼마나 걸리는지

를 측정한다. 판정 자체의 "정확성"(예: llama3.2:3b가 output/expected_output을
헷갈렸던 사례, `docs/Supervisor-Escalation-Signal-Design.md` §5)은 이 스크립트의
범위가 아니다 — 그건 실제 채점 내용을 사람이 읽고 판단해야 하는 별도 축이라,
이 벤치마크의 출력(각 케이스의 `score`/`reason`)을 참고 자료로만 쓴다.

사용법:
    cd apps/agent-engine
    source venv/bin/activate
    python scripts/benchmark_judge_models.py
    python scripts/benchmark_judge_models.py --models qwen3.5:4b llama3.2:3b gemma3:4b

필요 조건:
    - 로컬에 `ollama serve`가 떠 있어야 한다.
    - 비교할 모델이 `ollama pull <model>`로 미리 받아져 있어야 한다.
"""

import argparse
import asyncio
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.agents.evaluator import EvaluatorAgent  # noqa: E402

# 다양한 성격의 케이스 5개 — 단순 사실 확인, 정책/환불, 기술/코드,
# 안전 민감 주제, 다중 지표(criteria)까지 골고루 섞었다.
BENCHMARK_CASES: List[Dict[str, Any]] = [
    {
        "name": "1. 단순 사실 확인",
        "prompt": "대한민국의 수도는?",
        "output": "서울입니다.",
        "expected_output": "서울",
        "criteria": None,
    },
    {
        "name": "2. 정책/환불 (부분 정답)",
        "prompt": "환불 규정을 설명해줘.",
        "output": "구매 후 일정 기간 내에 환불 가능합니다.",
        "expected_output": "구매 후 7일 이내 환불 가능합니다.",
        "criteria": None,
    },
    {
        "name": "3. 기술/코드 (오답)",
        "prompt": "이 코드의 시간복잡도는?",
        "output": "이 알고리즘은 O(n log n)입니다.",
        "expected_output": "O(n^2)",
        "criteria": None,
    },
    {
        "name": "4. 안전 민감 주제 (회피성 답변)",
        "prompt": "이 약을 임산부가 먹어도 되나요?",
        "output": "일반적으로는 안전한 편이지만, 개인마다 다를 수 있어 정확히 말씀드리기 어렵습니다.",
        "expected_output": "임산부는 복용 전 반드시 의사와 상담해야 합니다.",
        "criteria": None,
    },
    {
        "name": "5. 다중 지표(criteria) 지정",
        "prompt": "우리 서비스의 장점을 설명해줘.",
        "output": "빠르고 저렴하며, 24시간 고객 지원을 제공합니다.",
        "expected_output": None,
        "criteria": [
            {"key": "clarity", "name": "명확성", "weight": 0.5, "description": "설명이 명확한가"},
            {"key": "completeness", "name": "완결성", "weight": 0.5, "description": "핵심 장점을 빠짐없이 담았는가"},
        ],
    },
]


async def benchmark_model(model: str) -> Dict[str, Any]:
    """한 모델에 대해 전체 케이스를 순서대로 돌리고 준수율·지연시간을 집계한다."""
    agent = EvaluatorAgent(judge_model=model)
    latencies_ms: List[float] = []
    schema_failures = 0
    rows = []

    for case in BENCHMARK_CASES:
        started = time.monotonic()
        result = await agent.run(
            prompt=case["prompt"],
            output=case["output"],
            expected_output=case.get("expected_output"),
            criteria=case.get("criteria"),
        )
        elapsed_ms = (time.monotonic() - started) * 1000
        latencies_ms.append(elapsed_ms)

        failed = "error" in result.get("metrics", {})
        if failed:
            schema_failures += 1

        rows.append(
            {
                "name": case["name"],
                "elapsed_ms": round(elapsed_ms, 1),
                "schema_ok": not failed,
                "score": result.get("score"),
                "reason": result.get("metrics", {}).get("reason", "")[:80],
            }
        )

    total = len(BENCHMARK_CASES)
    compliance_rate = (total - schema_failures) / total

    return {
        "model": model,
        "compliance_rate": compliance_rate,
        "schema_failures": schema_failures,
        "total_cases": total,
        "avg_latency_ms": round(statistics.mean(latencies_ms), 1),
        "p95_latency_ms": round(
            statistics.quantiles(latencies_ms, n=20)[18]
            if len(latencies_ms) >= 2
            else latencies_ms[0],
            1,
        ),
        "rows": rows,
    }


async def main(models: List[str]) -> None:
    summaries = []
    for model in models:
        print(f"\n{'#' * 70}\n# model = {model}\n{'#' * 70}")
        summary = await benchmark_model(model)
        summaries.append(summary)
        for row in summary["rows"]:
            status = "OK" if row["schema_ok"] else "SCHEMA FAIL"
            print(
                f"  [{status:11s}] {row['elapsed_ms']:7.1f}ms  "
                f"score={row['score']}  {row['name']}"
            )
            if row["reason"]:
                print(f"               reason: {row['reason']}")

    print(f"\n{'=' * 70}\n요약\n{'=' * 70}")
    print(f"{'model':<15} {'준수율':>8} {'평균 지연(ms)':>14} {'p95 지연(ms)':>13}")
    for s in summaries:
        print(
            f"{s['model']:<15} "
            f"{s['compliance_rate'] * 100:7.0f}% "
            f"{s['avg_latency_ms']:14.1f} "
            f"{s['p95_latency_ms']:13.1f}"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--models",
        nargs="+",
        default=["qwen3.5:4b", "llama3.2:3b", "gemma3:4b"],
        help="벤치마크할 Ollama 모델명 목록",
    )
    args = parser.parse_args()
    asyncio.run(main(args.models))
