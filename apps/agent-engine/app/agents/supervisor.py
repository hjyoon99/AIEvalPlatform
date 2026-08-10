import json
import os
from typing import Any, Dict, List, Literal, Optional

from dotenv import load_dotenv
from ollama import AsyncClient
from pydantic import BaseModel, Field

load_dotenv()


class SupervisorDecisionSchema(BaseModel):
    """Ollama structured output으로 강제되는 감독관 최종 판정 스키마.

    Attributes:
        verdict: 최종 통과("PASS"), 실패("FAIL") 또는 재평가("RETRY") 판정.
        confidence: 감독관 판정의 신뢰도(0.0~1.0).
        reason: 최종 판정 근거.
        issues: 발견된 품질 문제 목록.
        recommendedAction: 사용자에게 권장할 후속 조치.
    """

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
    """검증(Verifier) 및 평가(Evaluator) 결과를 종합해 최종 QA 판정을 내리는 감독관.

    검증 실패나 평가 오류 같은 결정적 케이스는 LLM 호출 없이 규칙 기반으로
    즉시 판정하고, 그 외의 경우에만 LLM을 호출해 종합 판단을 받는다. 이후
    사용자가 설정한 `pass_threshold`(정량 기준)를 LLM 판정보다 우선 적용해
    점수가 기준 미달인데 PASS로 나온 결과를 FAIL로 강제 보정한다.
    """

    def __init__(self, supervisor_model: str = "qwen3.5:4b"):
        """에이전트를 초기화하고 Ollama 비동기 클라이언트를 준비한다.

        Args:
            supervisor_model: `run` 호출 시 별도 모델이 지정되지 않았을 때
                사용할 기본 감독관 Ollama 모델명.

        Attributes set:
            supervisor_model: 기본 감독관 모델명.
            client: `OLLAMA_HOST` 환경 변수(기본값
                `http://localhost:11434`)로 연결되는 `AsyncClient` 인스턴스.
        """
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
        system_prompt: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        """검증/평가 결과를 감사하여 최종 PASS/FAIL/RETRY 판정을 내린다.

        Args:
            prompt: 원래 사용자 질문/요청 텍스트.
            output: 판정 대상인 AI 에이전트의 실제 답변 텍스트.
            verification: `VerifierAgent.run`의 결과 딕셔너리
                (`isValid`, `reason`, 선택적으로 `error` 포함).
            evaluation: `EvaluatorAgent.run`의 결과 딕셔너리
                (`score`, `passed`, `metrics` 포함).
            expected_output: 정답/기대 답변(있는 경우 LLM 컨텍스트에 포함).
            pass_threshold: 평가 점수가 이 값 이상이어야 PASS로 인정된다.
                LLM이 이보다 낮은 점수로 PASS를 내려도 이 값 기준으로
                FAIL로 강제 보정된다.
            retry_count: 지금까지 재평가를 수행한 횟수.
            max_retries: 허용되는 최대 재평가 횟수. 이 값에 도달하면
                RETRY 판정은 점수 기준에 따라 PASS/FAIL로 강제 전환된다.
            system_prompt: 감독관 LLM 호출에 사용할 커스텀 시스템 프롬프트
                (플랫폼 판정 규칙 문구가 자동으로 뒤에 추가됨).
            model: 감독관 호출에 사용할 모델명. 생략 시 `supervisor_model`을 사용한다.

        Returns:
            `verdict`("PASS"|"FAIL"|"RETRY"), `confidence`, `reason`,
            `issues`, `recommendedAction` 키를 가진 딕셔너리. 검증 실패,
            평가 오류(재시도 가능), LLM 호출 실패 등의 케이스는 각각의
            고정된 사유 메시지와 함께 규칙 기반으로 즉시 반환된다.
        """
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

        active_system_prompt = (
            system_prompt
            or "당신은 AI 답변 품질을 최종 승인하는 QA 감독관입니다. "
            "검증 에이전트와 평가 에이전트의 결과가 원본 답변과 일치하는지 감사하세요."
        ) + (
            "\n\n다음 플랫폼 판정 규칙은 반드시 따르세요.\n"
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
                model=model or self.supervisor_model,
                messages=[
                    {"role": "system", "content": active_system_prompt},
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
