import os
import json
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field
from ollama import AsyncClient
from dotenv import load_dotenv

load_dotenv()

# Ollama Structured Output을 위한 Pydantic Schema 정의
class EvaluationSchema(BaseModel):
    """(레거시/미사용 고정 스키마) 기본 2지표 채점 결과 형태.

    Attributes:
        faithfulness: 0.0~1.0 사이의 실수(답변의 사실성 및 정확성).
        answerRelevance: 0.0~1.0 사이의 실수(질문과의 관련성).
        reason: 채점 이유 및 요약 설명.
    """

    faithfulness: float = Field(description="0.0 ~ 1.0 사이의 실수 (답변의 사실성 및 정확성)")
    answerRelevance: float = Field(description="0.0 ~ 1.0 사이의 실수 (질문과의 관련성)")
    reason: str = Field(description="채점 이유 및 요약 설명")

class MetricScoreSchema(BaseModel):
    """사용자 정의 평가 지표 하나에 대한 채점 결과.

    Attributes:
        key: 평가 지표 key(요청에 전달된 criteria의 key와 매칭됨).
        score: 0.0~1.0 사이의 지표 점수.
        reason: 지표별 채점 근거.
    """

    key: str = Field(description="평가 지표 key")
    score: float = Field(ge=0.0, le=1.0, description="지표 점수")
    reason: str = Field(description="지표별 채점 근거")


class DynamicEvaluationSchema(BaseModel):
    """Ollama structured output으로 강제되는, 다중 지표 기반 평가 결과 스키마.

    Attributes:
        metrics: 지표별 채점 결과(`MetricScoreSchema`) 목록.
        reason: 전체 평가 요약.
        triggeredFailConditions: 답변이 실제로 위반한 즉시 실패 조건 목록.
        missingRequiredConditions: 답변에서 충족되지 않은 필수 조건 목록.
    """

    metrics: List[MetricScoreSchema]
    reason: str = Field(description="전체 평가 요약")
    triggeredFailConditions: List[str] = Field(
        default_factory=list,
        description="답변이 실제로 위반한 즉시 실패 조건",
    )
    missingRequiredConditions: List[str] = Field(
        default_factory=list,
        description="답변에서 충족되지 않은 필수 조건",
    )


class EvaluatorAgent:
    """Agent 3: Ollama 기반 LLM-as-a-Judge 채점 에이전트.

    사용자 정의(또는 기본) 평가 지표별로 가중 평균 점수를 계산하고,
    즉시 실패/필수 미충족 조건 위반 여부에 따라 최종 통과 여부를 판정한다.
    """

    def __init__(self, judge_model: str = "qwen3.5:4b"):
        """에이전트를 초기화하고 Ollama 비동기 클라이언트를 준비한다.

        Args:
            judge_model: `run` 호출 시 별도 모델이 지정되지 않았을 때
                사용할 기본 채점(judge) Ollama 모델명.

        Attributes set:
            judge_model: 기본 채점 모델명.
            client: `OLLAMA_HOST` 환경 변수(기본값
                `http://localhost:11434`)로 연결되는 `AsyncClient` 인스턴스.
        """
        self.judge_model = judge_model
        self.client = AsyncClient(
            host=os.getenv("OLLAMA_HOST", "http://localhost:11434")
        )

    async def run(
        self,
        prompt: str,
        output: str,
        expected_output: Optional[str] = None,
        supervisor_feedback: Optional[str] = None,
        criteria: Optional[List[Dict[str, Any]]] = None,
        system_prompt: Optional[str] = None,
        pass_threshold: float = 0.7,
        model: Optional[str] = None,
        groundedness_result: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """AI 에이전트 답변을 지표별로 채점하고 가중 평균 점수를 산출한다.

        Args:
            prompt: 원래 사용자 질문/요청 텍스트.
            output: 채점 대상인 AI 에이전트의 실제 답변 텍스트.
            expected_output: 정답/기대 답변. 제공되면 프롬프트에 포함되어
                사실 정확성 비교 기준으로 사용된다.
            supervisor_feedback: 감독관(Supervisor)이 재평가를 지시한 사유.
                제공되면 이전 평가와 독립적으로 다시 채점하도록 지시가 추가된다.
            criteria: 사용자 정의 평가 지표 목록. 각 항목은 `key`, `name`,
                `weight` 등을 포함하는 딕셔너리이며, 생략 시 사실 정확성/
                답변 관련성 2개 지표(각 가중치 0.5)를 기본으로 사용한다.
            system_prompt: 채점에 사용할 커스텀 시스템 프롬프트. 생략 시
                기본 LLM-as-a-Judge 지침을 사용한다.
            pass_threshold: 최종 점수가 이 값 이상이어야 통과(`passed=True`)로
                판정된다.
            model: 채점 호출에 사용할 모델명. 생략 시 `judge_model`을 사용한다.
            groundedness_result: `GroundednessAgent.run` 결과(RAG 유형
                답변에만 존재). `grounded=False`이면 뒷받침되지 않는 주장
                목록을 채점 프롬프트에 감점 참고 신호로 포함한다.

        Returns:
            다음 키를 포함하는 딕셔너리:
                - `score` (float): 지표별 가중 평균 점수(소수점 2자리).
                  실패 조건 위반 또는 필수 조건 누락 시 0.0으로 강제된다.
                - `passed` (bool): `score >= pass_threshold` 여부.
                - `metrics` (dict): `reason`, `hasExpectedOutput`,
                  `criteria`(지표별 상세 채점 결과), `triggeredFailConditions`,
                  `missingRequiredConditions`를 포함. Ollama 호출 실패 시에는
                  대신 `error`와 `reason`만 포함된다.
        """
        judge_system_prompt = system_prompt or (
            "당신은 AI 에이전트 답변의 품질을 채점하는 엄격한 평가자(LLM-as-a-Judge)입니다.\n"
            "제공된 프롬프트와 에이전트의 출력(Output)을 심사하여 평가 점수를 내리세요."
        )

        user_content = f"### 사용자 프롬프트:\n{prompt}\n\n### AI 에이전트 실제 출력(Output):\n{output}\n"
        if expected_output:
            user_content += f"\n### 정답/기대값 (Expected Output):\n{expected_output}\n"
        if supervisor_feedback:
            user_content += (
                "\n### 감독관 재평가 지시:\n"
                f"{supervisor_feedback}\n"
                "이전 평가와 독립적으로 답변을 다시 검토하세요.\n"
            )
        if groundedness_result and not groundedness_result.get("grounded", True):
            unsupported_claims = groundedness_result.get("unsupportedClaims", [])
            claims_text = "; ".join(
                f"{claim.get('claim')}({claim.get('reason')})"
                if isinstance(claim, dict)
                else str(claim)
                for claim in unsupported_claims
            )
            user_content += (
                "\n### 근거 충실성 검증 결과:\n"
                f"이 답변은 근거 문서로 뒷받침되지 않는 주장을 포함합니다: {claims_text}\n"
                "이를 사실 정확성 등 관련 지표의 감점 요소로 고려하세요.\n"
            )

        active_criteria = criteria or [
            {
                "key": "faithfulness",
                "name": "사실 정확성",
                "description": "답변의 사실성과 기대 답변 일치도를 평가",
                "weight": 0.5,
            },
            {
                "key": "answerRelevance",
                "name": "답변 관련성",
                "description": "질문 의도에 직접 답변했는지 평가",
                "weight": 0.5,
            },
        ]
        user_content += (
            "\n### 사용자 정의 평가 지표:\n"
            f"{json.dumps(active_criteria, ensure_ascii=False)}\n"
            "각 key에 대해 반드시 하나의 점수와 근거를 반환하세요. "
            "rubric의 점수 구간을 그대로 적용하고, requiredConditions와 "
            "failConditions를 각각 누락/위반했는지도 명시하세요. "
            "allowedVariations에 포함된 의미상 동등한 표현은 감점하지 마세요.\n"
        )

        try:
            response = await self.client.chat(
                model=model or self.judge_model,
                messages=[
                    {"role": "system", "content": judge_system_prompt},
                    {"role": "user", "content": user_content},
                ],
                think=False,
                format=DynamicEvaluationSchema.model_json_schema(),
                options={"temperature": 0.0},
            )

            raw_json = response.message.content or "{}"
            result_data = json.loads(raw_json)

            scores_by_key = {
                item.get("key"): item for item in result_data.get("metrics", [])
            }
            metric_results = []
            weighted_score = 0.0
            total_weight = 0.0
            for criterion in active_criteria:
                key = str(criterion.get("key", "metric"))
                weight = float(criterion.get("weight", 0.0))
                metric = scores_by_key.get(key, {})
                raw_metric_score = float(metric.get("score", 0.0))
                metric_score = max(0.0, min(1.0, raw_metric_score))
                weighted_score += metric_score * weight
                total_weight += weight
                metric_results.append({
                    "key": key,
                    "name": criterion.get("name", key),
                    "score": metric_score,
                    "weight": weight,
                    "required": bool(criterion.get("required", False)),
                    "reason": metric.get("reason", ""),
                })

            score = round(
                weighted_score / total_weight if total_weight > 0 else 0.0,
                2,
            )
            empty_markers = {
                "",
                "none",
                "n/a",
                "없음",
                "해당 없음",
                "누락 없음",
                "위반 없음",
            }
            triggered_fail_conditions = [
                str(item)
                for item in result_data.get("triggeredFailConditions", [])
                if str(item).strip().lower() not in empty_markers
            ]
            missing_required_conditions = [
                str(item)
                for item in result_data.get("missingRequiredConditions", [])
                if str(item).strip().lower() not in empty_markers
                and "누락되지" not in str(item)
                and "누락된 필수 조건이 없" not in str(item)
            ]
            if triggered_fail_conditions or missing_required_conditions:
                score = 0.0
            passed = score >= pass_threshold

            return {
                "score": score,
                "passed": passed,
                "metrics": {
                    "reason": result_data.get("reason", ""),
                    "hasExpectedOutput": expected_output is not None,
                    "criteria": metric_results,
                    "triggeredFailConditions": triggered_fail_conditions,
                    "missingRequiredConditions": missing_required_conditions,
                }
            }

        except Exception as e:
            print(f"[EvaluatorAgent Error] Ollama API call failed: {str(e)}")
            return {
                "score": 0.0,
                "passed": False,
                "metrics": {
                    "error": str(e),
                    "reason": "평가 중 오류가 발생했습니다."
                }
            }
