import json
import os
from typing import Any, Dict, List

from dotenv import load_dotenv
from ollama import AsyncClient
from pydantic import BaseModel, Field

load_dotenv()


class ScenarioDraftSchema(BaseModel):
    title: str
    category: str
    prompt: str
    expectedOutput: str
    expectedBehavior: List[str]
    evaluationRubric: Dict[str, Any] = Field(
        description=(
            "metrics(지표별 key/name/levels), requiredConditions, "
            "failConditions, allowedVariations를 포함한 채점 루브릭"
        )
    )
    riskLevel: str = Field(description="LOW, MEDIUM, HIGH 중 하나")


class ScenarioListSchema(BaseModel):
    scenarios: List[ScenarioDraftSchema]


class ScenarioValidationSchema(BaseModel):
    index: int
    valid: bool
    score: float = Field(ge=0.0, le=1.0)
    reason: str
    issues: List[str] = Field(default_factory=list)


class ScenarioValidationListSchema(BaseModel):
    validations: List[ScenarioValidationSchema]


class ScenarioGeneratorAgent:
    """도메인 기반 테스트 시나리오 생성 및 자동검증 에이전트."""

    def __init__(self):
        self.client = AsyncClient(
            host=os.getenv("OLLAMA_HOST", "http://localhost:11434")
        )

    async def run(
        self,
        domain: str,
        description: str | None,
        context: Dict[str, Any],
        criteria: List[Dict[str, Any]],
        count: int,
        model: str,
    ) -> List[Dict[str, Any]]:
        generation_context = {
            "domain": domain,
            "description": description,
            "businessContext": context,
            "evaluationCriteria": criteria,
            "count": count,
        }
        response = await self.client.chat(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "당신은 AI 제품의 QA 테스트 시나리오 설계자입니다. "
                        "현실적인 정상·경계·실패 상황을 균형 있게 만들고, "
                        "각 시나리오가 독립적으로 평가 가능하도록 작성하세요. "
                        "evaluationRubric에는 정책의 각 평가 지표마다 key, name과 "
                        "1.0/0.75/0.5/0.25/0.0 점수별 구체적 기준(levels)을 짧게 "
                        "작성하세요. requiredConditions는 필수 포함 조건, "
                        "failConditions는 충족 시 즉시 실패 조건, allowedVariations는 "
                        "정답과 표현이 달라도 허용할 의미 범위입니다. 실제 근거가 없는 "
                        "날짜·정책·보상 내용을 정답으로 만들어내지 마세요."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(generation_context, ensure_ascii=False),
                },
            ],
            think=False,
            format=ScenarioListSchema.model_json_schema(),
            options={"temperature": 0.4},
        )
        generated = ScenarioListSchema.model_validate_json(
            response.message.content or "{}"
        ).scenarios[:count]

        validation_response = await self.client.chat(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "당신은 테스트 시나리오 검증 QA입니다. 각 시나리오가 "
                        "도메인 관련성, 명확성, 기대 답변 일관성, 현실성, 평가 가능성을 "
                        "충족하는지 검사하세요. index는 입력 순서의 0부터 시작합니다."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "domain": domain,
                            "context": context,
                            "scenarios": [
                                item.model_dump() for item in generated
                            ],
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            think=False,
            format=ScenarioValidationListSchema.model_json_schema(),
            options={"temperature": 0.0},
        )
        try:
            validations = ScenarioValidationListSchema.model_validate_json(
                validation_response.message.content or "{}"
            ).validations
        except Exception as error:
            # 로컬 소형 모델은 간혹 구조화 JSON을 길게 반복하다 응답이
            # 잘릴 수 있다. 생성된 시나리오는 보존하되 자동 승인하지 않고
            # 사람이 검토할 수 있도록 DRAFT 판정으로 안전하게 내린다.
            validations = [
                ScenarioValidationSchema(
                    index=index,
                    valid=False,
                    score=0.0,
                    reason="자동검증 응답 형식이 올바르지 않아 사람 검토가 필요합니다.",
                    issues=[f"VALIDATION_RESPONSE_ERROR: {type(error).__name__}"],
                )
                for index in range(len(generated))
            ]
        validation_map = {item.index: item for item in validations}

        results: List[Dict[str, Any]] = []
        for index, scenario in enumerate(generated):
            validation = validation_map.get(index)
            validation_data = (
                validation.model_dump()
                if validation
                else {
                    "valid": False,
                    "score": 0.0,
                    "reason": "자동검증 결과가 누락되었습니다.",
                    "issues": ["VALIDATION_MISSING"],
                }
            )
            results.append(
                {
                    **scenario.model_dump(),
                    "autoValidation": validation_data,
                    "status": (
                        "AUTO_VERIFIED"
                        if validation_data.get("valid")
                        and float(validation_data.get("score", 0.0)) >= 0.7
                        else "DRAFT"
                    ),
                }
            )
        return results
