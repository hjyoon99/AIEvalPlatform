import os
import json
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field
from ollama import AsyncClient
from dotenv import load_dotenv

load_dotenv()

# Ollama Structured Output을 위한 Pydantic Schema 정의
class EvaluationSchema(BaseModel):
    faithfulness: float = Field(description="0.0 ~ 1.0 사이의 실수 (답변의 사실성 및 정확성)")
    answerRelevance: float = Field(description="0.0 ~ 1.0 사이의 실수 (질문과의 관련성)")
    reason: str = Field(description="채점 이유 및 요약 설명")

class MetricScoreSchema(BaseModel):
    key: str = Field(description="평가 지표 key")
    score: float = Field(ge=0.0, le=1.0, description="지표 점수")
    reason: str = Field(description="지표별 채점 근거")


class DynamicEvaluationSchema(BaseModel):
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
    """Agent 3: Ollama 기반 LLM-as-a-Judge 채점 에이전트"""

    def __init__(self, judge_model: str = "qwen3.5:4b"):
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
    ) -> Dict[str, Any]:
        
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
                model=self.judge_model,
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
                metric_score = float(metric.get("score", 0.0))
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
            triggered_fail_conditions = result_data.get(
                "triggeredFailConditions",
                [],
            )
            missing_required_conditions = result_data.get(
                "missingRequiredConditions",
                [],
            )
            if triggered_fail_conditions or missing_required_conditions:
                score = 0.0
            passed = score >= 0.7

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
