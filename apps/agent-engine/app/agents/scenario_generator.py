import json
import os
from typing import Any, Dict, List

from dotenv import load_dotenv
from ollama import AsyncClient
from pydantic import BaseModel, Field

load_dotenv()


class ScenarioDraftSchema(BaseModel):
    """LLM이 생성한 테스트 시나리오 초안 하나의 스키마.

    Attributes:
        title: 시나리오 제목.
        category: 시나리오가 속한 분류(정상/경계/실패 등).
        prompt: 테스트에 사용할 사용자 프롬프트.
        expectedOutput: 기대되는 정답/모범 답변.
        expectedBehavior: 기대되는 에이전트 행동 목록.
        evaluationRubric: metrics(지표별 key/name/levels),
            requiredConditions, failConditions, allowedVariations를
            포함한 채점 루브릭.
        riskLevel: "LOW", "MEDIUM", "HIGH" 중 하나.
    """

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
    """시나리오 생성 LLM 호출의 structured output 최상위 스키마.

    Attributes:
        scenarios: 생성된 `ScenarioDraftSchema` 목록.
    """

    scenarios: List[ScenarioDraftSchema]


class ScenarioValidationSchema(BaseModel):
    """생성된 시나리오 하나에 대한 자동검증 결과 스키마.

    Attributes:
        index: 검증 대상 시나리오의 입력 순서(0부터 시작).
        valid: 시나리오가 유효한지 여부.
        score: 0.0~1.0 사이의 검증 점수.
        reason: 검증 판정 근거.
        issues: 발견된 문제점 목록.
    """

    index: int
    valid: bool
    score: float = Field(ge=0.0, le=1.0)
    reason: str
    issues: List[str] = Field(default_factory=list)


class ScenarioValidationListSchema(BaseModel):
    """시나리오 자동검증 LLM 호출의 structured output 최상위 스키마.

    Attributes:
        validations: 시나리오별 `ScenarioValidationSchema` 목록.
    """

    validations: List[ScenarioValidationSchema]


class ScenarioGeneratorAgent:
    """도메인 기반 테스트 시나리오 생성 및 자동검증 에이전트.

    지정된 도메인/비즈니스 컨텍스트를 바탕으로 LLM에게 테스트 시나리오
    초안을 생성시킨 뒤, 동일 LLM에게 각 시나리오의 타당성을 다시 검증시켜
    자동 승인(`AUTO_VERIFIED`) 또는 사람 검토 필요(`DRAFT`) 상태를 부여한다.
    """

    def __init__(self):
        """에이전트를 초기화하고 Ollama 비동기 클라이언트를 준비한다.

        Attributes set:
            client: `OLLAMA_HOST` 환경 변수(기본값
                `http://localhost:11434`)로 연결되는 `AsyncClient` 인스턴스.
        """
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
        """도메인 기반 테스트 시나리오를 생성하고 자동검증까지 수행한다.

        Args:
            domain: 시나리오를 생성할 대상 도메인(예: "customer-support").
            description: 도메인에 대한 부가 설명. 없으면 `None`.
            context: 시나리오 생성에 참고할 비즈니스 컨텍스트 딕셔너리.
            criteria: 평가 루브릭 작성 시 참고할 평가 지표 목록.
            count: 생성할 시나리오 개수.
            model: 시나리오 생성 및 자동검증에 사용할 Ollama 모델명.

        Returns:
            각 시나리오 딕셔너리(`ScenarioDraftSchema` 필드 전체)에
            `autoValidation`(자동검증 결과)과 `status`
            ("AUTO_VERIFIED" 또는 "DRAFT")가 추가된 딕셔너리 목록.
            자동검증 응답이 파싱 불가하거나 특정 인덱스의 검증 결과가
            누락된 경우, 해당 시나리오는 안전하게 "DRAFT" 상태로 처리된다.
        """
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
