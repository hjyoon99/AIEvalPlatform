import json
import os
from typing import Any, Dict, List, Literal, Optional

from dotenv import load_dotenv
from ollama import AsyncClient
from pydantic import BaseModel, Field

load_dotenv()

# 컨센서스(다중 모델) 에스컬레이션을 트리거하는 confidence 임계값이다.
# [설계 결정 필요] 잠정치이며, Epic E(#37 하위)에서 실측 데이터로 캘리브레이션 대상이다.
AMBIGUITY_CONFIDENCE_THRESHOLD = 0.6

# score가 pass_threshold에서 이 값 이내로 붙어 있으면, LLM의 confidence와
# 무관하게 경계선 케이스로 보고 에스컬레이션한다. 실측 47건 기준 지표별
# 점수 편차(spread)는 낮은 평균 점수의 명백한 FAIL과 강하게 겹쳐 오탐이
# 많아 채택하지 않았고, score margin만 코드 신호로 채택했다.
# [설계 결정 필요] 잠정치이며, Epic E에서 캘리브레이션 대상이다.
BORDERLINE_SCORE_MARGIN = 0.15


def _force_escalation_if_ambiguous(
    decision: Dict[str, Any], score: float, pass_threshold: float
) -> None:
    """LLM의 escalation 판단을 신뢰하지 않고, 코드가 결정론적으로 덮어쓴다.

    실측 테스트(`docs/Supervisor-Escalation-Signal-Design.md` §5)에서
    qwen3.5:4b는 명백히 애매하게 설계된 입력에서도 confidence를 0.85 밑으로
    거의 내리지 않는다는 게 확인됐다. 즉 "confidence가 낮으면 애매한
    것"이라는 가정은 성립해도, 역은 성립하지 않는다(애매해도 confidence가
    안 낮을 수 있다). 그래서 LLM의 자기평가 하나만으로는 애매한 케이스를
    놓친다 — score margin이라는, LLM 판단과 무관한 두 번째 신호로 이를
    보완한다.

    이 함수는 `decision["escalation"]`을 "ESCALATE_MULTI_JUDGE" 방향으로만
    바꾼다. 아래 두 조건 중 하나라도 해당하면 무조건 덮어쓰고, 둘 다
    해당하지 않으면 LLM이 반환한 값을 그대로 둔다 — 즉 LLM이 이미
    "ESCALATE_MULTI_JUDGE"를 냈다면 이 함수가 그걸 "NONE"으로 되돌리는
    일은 절대 없다(단방향 강제).

    가설(테스트로 검증됨, `tests/test_supervisor.py` 참고):
        1. confidence < AMBIGUITY_CONFIDENCE_THRESHOLD 이면 강제 발동한다.
        2. score가 pass_threshold에서 BORDERLINE_SCORE_MARGIN 이내로 붙어
           있으면, confidence가 아무리 높아도 강제 발동한다 — 실제로 DB에
           남아있던 과거 경계 케이스(score=0.65, threshold=0.7)를 재현하면
           qwen의 confidence는 0.95였지만 이 조건으로 잡힌다.
        3. 위 두 조건에 모두 해당하지 않으면 LLM이 정한 값을 그대로 둔다
           (NONE이든 ESCALATE_MULTI_JUDGE든 건드리지 않는다).

    Args:
        decision: `SupervisorDecisionSchema.model_dump()` 결과. 이 딕셔너리의
            `"escalation"` 키를 제자리에서(in-place) 수정한다.
        score: 이번 케이스의 평가 점수(`EvaluatorAgent.run`의 `score`).
        pass_threshold: 사용자가 설정한 통과 기준 점수.

    Returns:
        값을 반환하지 않는다. `decision`을 직접 수정한다.
    """
    if decision["confidence"] < AMBIGUITY_CONFIDENCE_THRESHOLD:
        decision["escalation"] = "ESCALATE_MULTI_JUDGE"
    # 부동소수점 오차 보정: 예를 들어 abs(0.85 - 0.7)은 수학적으로는 0.15지만
    # 파이썬에서는 0.15000000000000002가 되어 "<= 0.15"를 통과하지 못한다.
    # margin이 정확히 임계값과 같은 경계값도 포함(inclusive)하는 게
    # 의도이므로, 아주 작은 오차(1e-9)만큼 여유를 둔다.
    if abs(score - pass_threshold) <= BORDERLINE_SCORE_MARGIN + 1e-9:
        decision["escalation"] = "ESCALATE_MULTI_JUDGE"


class SupervisorDecisionSchema(BaseModel):
    """Ollama structured output으로 강제되는 감독관 최종 판정 스키마.

    `escalation`과 `recommendedAction`은 역할이 다르다: `escalation`은 코드가
    라우팅에 쓰는 고정된 enum 신호이고, `recommendedAction`은 사람이 읽는
    자유 문장이다. 두 필드가 나란히 있으면 모델이 서로의 값 형식(짧은
    키워드 vs 문장)을 혼동하는 경향이 관찰되어, 스키마 순서상 서로 멀리
    떨어뜨리고 필드 설명에 상호 참조와 예시를 명시해 구분한다.

    Attributes:
        verdict: 최종 통과("PASS"), 실패("FAIL") 또는 재평가("RETRY") 판정.
        confidence: 감독관 판정의 신뢰도(0.0~1.0).
        escalation: 판정이 애매해 다중 모델 컨센서스로 넘겨야 하는지 여부.
            고정된 enum 값만 허용되는 기계 판독용 신호다.
        reason: 최종 판정 근거.
        issues: 발견된 품질 문제 목록.
        recommendedAction: 사용자에게 권장할 후속 조치(자유 문장, 화면 표시용).
    """

    verdict: Literal["PASS", "FAIL", "RETRY"] = Field(
        description="최종 통과, 실패 또는 재평가 판정"
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="감독관 판정의 신뢰도",
    )
    escalation: Literal["NONE", "ESCALATE_MULTI_JUDGE"] = Field(
        description=(
            "판정이 애매해 다중 모델 컨센서스로 넘겨야 하면 "
            "ESCALATE_MULTI_JUDGE, 아니면 NONE. 이 두 값만 허용되며 "
            "recommendedAction과는 별개의 필드다."
        )
    )
    reason: str = Field(description="최종 판정 근거")
    issues: List[str] = Field(
        default_factory=list,
        description="발견된 품질 문제 목록",
    )
    recommendedAction: str = Field(
        description=(
            "사용자에게 권장할 후속 조치를 완전한 한국어 문장으로 작성한다. "
            "예: '기준 미달 지표를 개선한 뒤 다시 평가하세요.' "
            "'PASS'/'FAIL'/'RETRY'/'NONE' 같은 단일 키워드는 절대 쓰지 않는다 "
            "— 그건 verdict와 escalation 필드의 값이지 이 필드의 값이 아니다."
        )
    )


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
            `issues`, `recommendedAction`, `escalation`("NONE"|
            "ESCALATE_MULTI_JUDGE") 키를 가진 딕셔너리. 검증 실패, 평가
            오류(재시도 가능), LLM 호출 실패 등의 케이스는 각각의 고정된
            사유 메시지와 함께 규칙 기반으로 즉시 반환되며(`escalation`은
            항상 "NONE"). 그 외에는 `confidence`가
            `AMBIGUITY_CONFIDENCE_THRESHOLD` 미만이거나 평가 점수가
            `pass_threshold`에서 `BORDERLINE_SCORE_MARGIN` 이내로 붙어
            있으면, LLM 판단과 무관하게 `escalation`이
            "ESCALATE_MULTI_JUDGE"로 강제된다.
        """
        if verification.get("error"):
            return {
                "verdict": "FAIL",
                "confidence": 1.0,
                "reason": "검증 에이전트 실행에 실패하여 품질을 보장할 수 없습니다.",
                "issues": [verification["error"]],
                "recommendedAction": "Ollama 상태를 확인한 뒤 평가를 다시 실행하세요.",
                "escalation": "NONE",
            }

        if not verification.get("isValid", False):
            return {
                "verdict": "FAIL",
                "confidence": 1.0,
                "reason": verification.get("reason", "유효성 검증에 실패했습니다."),
                "issues": ["VERIFICATION_FAILED"],
                "recommendedAction": "원본 AI 답변을 수정하거나 다시 생성하세요.",
                "escalation": "NONE",
            }

        if evaluation.get("metrics", {}).get("error") and retry_count < max_retries:
            return {
                "verdict": "RETRY",
                "confidence": 1.0,
                "reason": "평가 에이전트 실행 오류로 재평가가 필요합니다.",
                "issues": [evaluation["metrics"]["error"]],
                "recommendedAction": "평가 에이전트를 다시 실행하세요.",
                "escalation": "NONE",
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
            "5. 점수와 판정 근거가 일관되는지 확인하세요.\n"
            "6. 검증/평가 결과만으로 판정하기 애매하거나 근거가 팽팽하게 갈리면 "
            "confidence를 낮게 설정하고 escalation을 ESCALATE_MULTI_JUDGE로 "
            "반환하세요. 애매하지 않으면 escalation은 NONE입니다.\n"
            "7. escalation과 recommendedAction은 서로 다른 필드입니다. "
            "escalation에는 반드시 NONE 또는 ESCALATE_MULTI_JUDGE만 쓰고, "
            "recommendedAction에는 PASS/FAIL/RETRY/NONE 같은 단일 단어를 "
            "절대 쓰지 말고 사람이 읽을 완전한 문장을 쓰세요.\n"
            "예시: {\"verdict\": \"FAIL\", \"confidence\": 0.9, "
            "\"escalation\": \"NONE\", \"reason\": \"...\", \"issues\": [], "
            "\"recommendedAction\": \"기준 미달 지표를 개선한 뒤 다시 "
            "평가하세요.\"}"
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

            # LLM의 자체 판단(escalation)은 참고하되, 코드 신호가 걸리면
            # 결정론적으로 덮어쓴다 — 자세한 근거와 가설은 함수 docstring 참고.
            _force_escalation_if_ambiguous(decision, score, pass_threshold)

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
                # 판정 애매함이 아니라 인프라 장애이므로 다중 모델 컨센서스로
                # 넘기지 않는다. confidence가 낮아도 여기서는 사람 검토가 맞다.
                "escalation": "NONE",
            }
