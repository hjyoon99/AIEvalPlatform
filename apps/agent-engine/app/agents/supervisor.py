import json
import os
from typing import Any, Dict, List, Literal, Optional

from dotenv import load_dotenv
from ollama import AsyncClient
from pydantic import BaseModel, Field

load_dotenv()


class SupervisorDecisionSchema(BaseModel):
    verdict: Literal["PASS", "FAIL", "RETRY"] = Field(
        description="최종 통과, 실패 또는 재평가 판정"
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="감독관 판정의 신뢰도",
    )
    reason: str = Field(description="최종 판정 근거")
    issues: List[str] = Field(
        default_factory=list,
        description="발견된 품질 문제 목록",
    )
    recommendedAction: str = Field(description="사용자에게 권장할 후속 조치")


class SupervisorAgent:
    """검증 및 평가 결과를 종합해 최종 QA 판정을 내리는 감독관."""

    def __init__(self, supervisor_model: str = "qwen3.5:4b"):
        self.supervisor_model = supervisor_model
        self.client = AsyncClient(
            host=os.getenv("OLLAMA_HOST", "http://localhost:11434")
        )

    async def run(
        self,
        prompt: str,
        output: str,
        verification: Dict[str, Any],
        evaluation: Dict[str, Any],
        expected_output: Optional[str] = None,
        pass_threshold: float = 0.7,
        retry_count: int = 0,
        max_retries: int = 1,
    ) -> Dict[str, Any]:
        if verification.get("error"):
            return {
                "verdict": "FAIL",
                "confidence": 1.0,
                "reason": "검증 에이전트 실행에 실패하여 품질을 보장할 수 없습니다.",
                "issues": [verification["error"]],
                "recommendedAction": "Ollama 상태를 확인한 뒤 평가를 다시 실행하세요.",
            }

        if not verification.get("isValid", False):
            return {
                "verdict": "FAIL",
                "confidence": 1.0,
                "reason": verification.get("reason", "유효성 검증에 실패했습니다."),
                "issues": ["VERIFICATION_FAILED"],
                "recommendedAction": "원본 AI 답변을 수정하거나 다시 생성하세요.",
            }

        if evaluation.get("metrics", {}).get("error") and retry_count < max_retries:
            return {
                "verdict": "RETRY",
                "confidence": 1.0,
                "reason": "평가 에이전트 실행 오류로 재평가가 필요합니다.",
                "issues": [evaluation["metrics"]["error"]],
                "recommendedAction": "평가 에이전트를 다시 실행하세요.",
            }

        system_prompt = (
            "당신은 AI 답변 품질을 최종 승인하는 QA 감독관입니다.\n"
            "검증 에이전트와 평가 에이전트의 결과가 원본 답변과 일치하는지 감사하세요.\n"
            "다음 정책을 반드시 따르세요.\n"
            "1. 검증 실패는 FAIL입니다.\n"
            f"2. 평가 점수가 {pass_threshold} 이상이고 중대한 문제가 없으면 PASS입니다.\n"
            f"3. 점수가 {pass_threshold} 미만이면 원칙적으로 FAIL입니다.\n"
            "4. 에이전트 결과가 명백히 충돌하고 재시도 횟수가 남은 경우에만 RETRY입니다.\n"
            "5. 점수와 판정 근거가 일관되는지 확인하세요."
        )

        context = {
            "prompt": prompt,
            "output": output,
            "expectedOutput": expected_output,
            "verification": verification,
            "evaluation": evaluation,
            "retryCount": retry_count,
            "maxRetries": max_retries,
            "passThreshold": pass_threshold,
        }

        try:
            response = await self.client.chat(
                model=self.supervisor_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {
                        "role": "user",
                        "content": json.dumps(context, ensure_ascii=False),
                    },
                ],
                think=False,
                format=SupervisorDecisionSchema.model_json_schema(),
                options={"temperature": 0.0},
            )
            decision = SupervisorDecisionSchema.model_validate_json(
                response.message.content or "{}"
            ).model_dump()
            score = float(evaluation.get("score", 0.0))

            if decision["verdict"] == "RETRY" and retry_count >= max_retries:
                decision["verdict"] = (
                    "PASS"
                    if score >= pass_threshold
                    else "FAIL"
                )
                decision["reason"] = (
                    f"최대 재평가 횟수에 도달했습니다. {decision['reason']}"
                )

            # LLM 감독관의 설명 능력은 활용하되 사용자가 정한 정량 정책은
            # 절대 우회하지 못하게 한다.
            if decision["verdict"] == "PASS" and score < pass_threshold:
                decision["verdict"] = "FAIL"
                decision["issues"] = [
                    *decision.get("issues", []),
                    "SCORE_BELOW_PASS_THRESHOLD",
                ]
                decision["reason"] = (
                    f"평가 점수 {score:.2f}가 사용자 통과 기준 "
                    f"{pass_threshold:.2f}보다 낮습니다. {decision['reason']}"
                )
                decision["recommendedAction"] = (
                    "기준 미달 지표를 개선한 뒤 다시 평가하세요."
                )

            return decision
        except Exception as e:
            score = float(evaluation.get("score", 0.0))
            return {
                "verdict": "PASS" if score >= pass_threshold else "FAIL",
                "confidence": 0.5,
                "reason": "감독관 호출 실패로 평가 점수 기준을 적용했습니다.",
                "issues": [str(e)],
                "recommendedAction": "감독관 결과를 수동으로 검토하세요.",
            }
