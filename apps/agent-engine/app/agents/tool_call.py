import json
import os
from typing import Any, Dict, List, Literal, Optional, Union

from dotenv import load_dotenv
from ollama import AsyncClient
from pydantic import BaseModel, Field

load_dotenv()


class ToolCallIssueSchema(BaseModel):
    """개별 도구 호출에서 발견된 문제.

    Attributes:
        toolName: 문제가 발견된 도구 호출의 이름.
        issue: 문제 종류. `invalid_parameter`(파라미터가 질문 의도와
            맞지 않거나 비합리적임) 또는 `unnecessary_call`(질문에
            답하는 데 필요하지 않은 호출).
        reason: 문제로 판단한 구체적 사유.
    """

    toolName: str = Field(description="문제가 발견된 도구 호출의 이름")
    issue: Literal["invalid_parameter", "unnecessary_call"] = Field(
        description="문제 종류: invalid_parameter(파라미터 부적절) 또는 unnecessary_call(불필요한 호출)"
    )
    reason: str = Field(description="문제로 판단한 구체적 사유")


class ToolCallCheckSchema(BaseModel):
    """Ollama structured output으로 강제되는 도구 호출 정확성 검증 결과 스키마.

    Attributes:
        valid: 모든 도구 호출이 타당한지 여부.
        issues: 발견된 문제 목록.
        confidence: 판정에 대한 확신도(0.0~1.0).
    """

    valid: bool = Field(description="모든 도구 호출이 타당한지 여부")
    issues: List[ToolCallIssueSchema] = Field(
        default_factory=list,
        description="발견된 문제 목록",
    )
    confidence: float = Field(ge=0.0, le=1.0, description="판정에 대한 확신도")


def _format_tool_calls(tool_calls: List[Any]) -> str:
    """`toolCalls` 항목을 프롬프트용 텍스트로 정규화한다.

    각 항목은 `{"name"/"toolName": str, "arguments"/"params": dict}` 형태의
    딕셔너리를 가정하되, 필드명이 다르거나 다른 형태여도 관대하게
    파싱한다. SDK의 `toolCalls`가 `unknown[]`로 느슨하게 정의되어 있어
    (고객사 에이전트 프레임워크마다 구조가 다름) 하나의 엄격한 스키마를
    강제하지 않는다.
    """
    lines = []
    for idx, call in enumerate(tool_calls, start=1):
        if isinstance(call, dict):
            name = call.get("name") or call.get("toolName") or "unknown"
            arguments = call.get("arguments", call.get("params", {}))
        else:
            name, arguments = str(call), {}
        lines.append(
            f"[호출 {idx}] {name}({json.dumps(arguments, ensure_ascii=False)})"
        )
    return "\n".join(lines)


class ToolCallCheckAgent:
    """도구 호출이 포함된 답변에서 호출 자체의 정확성을 검증하는 에이전트.

    이용 가능한 도구 스키마가 계약에 없어 파라미터 타입을 엄격히
    검증할 수는 없다. 대신 각 도구 호출의 파라미터가 사용자 질문
    의도에 비춰 타당한지(`invalid_parameter`), 그리고 질문에 답하는
    데 애초에 필요했는지(`unnecessary_call`)를 LLM이 판단한다. 검증
    결과는 그래프의 `tool_call_result` 상태에 저장되어 이후 `evaluate`
    단계의 채점 프롬프트에 반영된다.
    """

    def __init__(self, model: str = "qwen3.5:4b"):
        """에이전트를 초기화하고 Ollama 비동기 클라이언트를 준비한다.

        Args:
            model: `run` 호출 시 별도 모델이 지정되지 않았을 때 사용할
                기본 Ollama 모델명.

        Attributes set:
            model: 기본 모델명.
            client: `OLLAMA_HOST` 환경 변수(기본값
                `http://localhost:11434`)로 연결되는 `AsyncClient` 인스턴스.
        """
        self.model = model
        self.client = AsyncClient(
            host=os.getenv("OLLAMA_HOST", "http://localhost:11434")
        )

    async def run(
        self,
        prompt: str,
        output: str,
        tool_calls: Optional[List[Union[str, Dict[str, Any]]]] = None,
        system_prompt: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        """도구 호출의 파라미터 타당성과 필요성을 검증한다.

        Args:
            prompt: 원래 사용자 질문/요청 텍스트.
            output: 검증 대상인 AI 에이전트의 답변 텍스트.
            tool_calls: 답변 생성 중 실행된 도구 호출 목록. 각 항목은
                `{"name": str, "arguments": dict}` 형태를 가정하되
                필드명이 다르거나 문자열이어도 허용한다.
            system_prompt: 검증에 사용할 커스텀 시스템 프롬프트. 생략 시
                기본 지침을 사용한다.
            model: 호출에 사용할 모델명. 생략 시 `self.model`을 사용한다.

        Returns:
            다음 키를 포함하는 딕셔너리:
                - `valid` (bool): 모든 도구 호출이 타당한지 여부.
                - `issues` (list[dict]): 각 `toolName`, `issue`, `reason`을
                  포함하는 문제 목록.
                - `confidence` (float): 판정 확신도.

            `tool_calls`가 비어있으면 Ollama 호출 없이 즉시 검증 불가로
            반환한다(API 호출 절약). 호출 실패 시 `error`를 포함해
            반환한다.
        """
        calls = tool_calls or []
        if not calls:
            return {
                "valid": False,
                "issues": [],
                "confidence": 0.0,
                "reason": "도구 호출 정보가 제공되지 않아 검증할 수 없습니다.",
            }

        active_system_prompt = system_prompt or (
            "당신은 AI 에이전트의 도구 호출(tool call)이 타당한지 검증하는 "
            "평가자입니다.\n"
            "이용 가능한 도구의 정확한 스키마는 제공되지 않으므로, 타입 수준의 "
            "엄격한 검증 대신 다음 두 가지만 판단하세요.\n"
            "1. invalid_parameter: 호출에 사용된 파라미터가 사용자 질문 의도에 "
            "비춰 명백히 부적절하거나 비합리적인가(예: 질문과 무관한 값, 형식이 "
            "깨진 값).\n"
            "2. unnecessary_call: 이 호출이 사용자 질문에 답하는 데 애초에 "
            "필요하지 않았는가.\n"
            "확실하지 않은 경우 문제로 지적하지 마세요. 문제가 없으면 valid를 "
            "true로, 하나라도 있으면 false로 지정하세요."
        )

        calls_text = _format_tool_calls(calls)
        user_content = (
            f"### 질문:\n{prompt}\n\n"
            f"### 실행된 도구 호출:\n{calls_text}\n\n"
            f"### AI 에이전트 최종 답변:\n{output}"
        )

        try:
            response = await self.client.chat(
                model=model or self.model,
                messages=[
                    {"role": "system", "content": active_system_prompt},
                    {"role": "user", "content": user_content},
                ],
                think=False,
                format=ToolCallCheckSchema.model_json_schema(),
                options={"temperature": 0.0},
            )

            result_data = json.loads(response.message.content or "{}")
            return {
                "valid": result_data.get("valid", False),
                "issues": result_data.get("issues", []),
                "confidence": result_data.get("confidence", 0.0),
            }

        except Exception as e:
            print(f"[ToolCallCheckAgent Error] Ollama call failed: {str(e)}")
            return {
                "valid": False,
                "issues": [],
                "confidence": 0.0,
                "error": str(e),
                "reason": "도구 호출 검증 중 오류가 발생했습니다.",
            }
