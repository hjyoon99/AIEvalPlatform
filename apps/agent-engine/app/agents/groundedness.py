import json
import os
from typing import Any, Dict, List, Optional, Union

from dotenv import load_dotenv
from ollama import AsyncClient
from pydantic import BaseModel, Field

load_dotenv()


class UnsupportedClaimSchema(BaseModel):
    """근거 문서로 뒷받침되지 않는 개별 주장.

    Attributes:
        claim: 답변에서 근거 없이 제시된 주장 문장.
        reason: 근거가 없다고 판단한 사유(문서에 언급 없음/문서와 모순 등).
    """

    claim: str = Field(description="답변에서 근거 없이 제시된 주장 문장")
    reason: str = Field(
        description="근거가 없다고 판단한 사유 (문서에 언급 없음/문서와 모순 등)"
    )


class GroundednessSchema(BaseModel):
    """Ollama structured output으로 강제되는 근거 충실성 검증 결과 스키마.

    Attributes:
        grounded: 답변의 모든 주장이 근거 문서로 뒷받침되는지 여부.
        unsupportedClaims: 근거 문서로 뒷받침되지 않는 주장 목록.
        confidence: 판정에 대한 확신도(0.0~1.0).
    """

    grounded: bool = Field(
        description="답변의 모든 주장이 근거 문서로 뒷받침되는지 여부"
    )
    unsupportedClaims: List[UnsupportedClaimSchema] = Field(
        default_factory=list,
        description="근거 문서로 뒷받침되지 않는 주장 목록",
    )
    confidence: float = Field(ge=0.0, le=1.0, description="판정에 대한 확신도")


def _format_retrieved_documents(documents: List[Any]) -> str:
    """`retrievedDocuments` 항목을 프롬프트용 텍스트로 정규화한다.

    각 항목은 문자열이거나 `{"content": str, "source": str}` 형태의
    딕셔너리일 수 있다. SDK의 `retrievedDocuments`가 `unknown[]`로
    느슨하게 정의되어 있어(고객사 RAG 구현마다 구조가 다름), 어느 쪽이든
    받아들이도록 관대하게 파싱한다.
    """
    lines = []
    for idx, doc in enumerate(documents, start=1):
        if isinstance(doc, dict):
            content = doc.get("content", str(doc))
            source = doc.get("source")
        else:
            content = str(doc)
            source = None
        label = f"[자료 {idx}" + (f" — {source}" if source else "") + "]"
        lines.append(f"{label}\n{content}")
    return "\n\n".join(lines)


class GroundednessAgent:
    """RAG 답변의 근거 충실성(groundedness)을 검증하는 에이전트.

    답변에 포함된 각 주장이 `retrievedDocuments`(검색된 근거 문서)로
    실제로 뒷받침되는지 판단하고, 뒷받침되지 않는 주장을 사유와 함께
    반환한다. 검증 결과는 그래프의 `groundedness_result` 상태에 저장되어
    이후 `evaluate` 단계의 채점 프롬프트에 반영된다.
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
        retrieved_documents: Optional[List[Union[str, Dict[str, Any]]]] = None,
        system_prompt: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        """답변의 각 주장이 근거 문서로 뒷받침되는지 검증한다.

        Args:
            prompt: 원래 사용자 질문/요청 텍스트.
            output: 검증 대상인 AI 에이전트의 답변 텍스트.
            retrieved_documents: 근거로 제시된 문서 목록. 각 항목은
                문자열이거나 `{"content": str, "source": str}` 형태의
                딕셔너리일 수 있다.
            system_prompt: 검증에 사용할 커스텀 시스템 프롬프트. 생략 시
                기본 근거 충실성 판단 지침을 사용한다.
            model: 호출에 사용할 모델명. 생략 시 `self.model`을 사용한다.

        Returns:
            다음 키를 포함하는 딕셔너리:
                - `grounded` (bool): 모든 주장이 근거로 뒷받침되는지 여부.
                - `unsupportedClaims` (list[dict]): 각 `claim`, `reason`을
                  포함하는 근거 없는 주장 목록.
                - `confidence` (float): 판정 확신도.

            `retrieved_documents`가 비어있으면 Ollama 호출 없이 즉시
            검증 불가로 반환한다(API 호출 절약). 호출 실패 시 `error`를
            포함해 반환한다.
        """
        documents = retrieved_documents or []
        if not documents:
            return {
                "grounded": False,
                "unsupportedClaims": [],
                "confidence": 0.0,
                "reason": "근거 문서가 제공되지 않아 검증할 수 없습니다.",
            }

        active_system_prompt = system_prompt or (
            "당신은 RAG(검색 증강 생성) 답변의 근거 충실성(faithfulness)을 검증하는 "
            "평가자입니다.\n"
            "이 검증은 오직 한 방향입니다: AI 에이전트 답변(Output)이 실제로 주장한 "
            "내용만 보고, 그 각각의 주장이 근거 문서로 뒷받침되는지 판단하세요.\n\n"
            "절대 하지 말아야 할 것: 근거 문서에는 있지만 답변이 언급하지 않은 내용을 "
            "'근거 없는 주장'으로 지적하지 마세요. 답변이 문서의 일부만 인용하거나 "
            "요약해서 다른 내용을 생략하는 것은 정상이며 결함이 아닙니다. 오직 답변이 "
            "실제로 말한 문장 중 문서에 없거나 문서와 모순되는 것만 unsupportedClaims에 "
            "넣으세요.\n\n"
            "각 unsupportedClaims 항목의 reason에는 '문서에 언급 없음'인지 "
            "'문서 내용과 모순됨'인지 명시하세요.\n"
            "답변의 모든 주장이 뒷받침되면 grounded를 true로, 하나라도 근거 없거나 "
            "모순되면 false로 지정하세요."
        )

        docs_text = _format_retrieved_documents(documents)
        user_content = (
            f"### 질문:\n{prompt}\n\n"
            f"### 근거 문서:\n{docs_text}\n\n"
            f"### AI 에이전트 답변:\n{output}"
        )

        try:
            response = await self.client.chat(
                model=model or self.model,
                messages=[
                    {"role": "system", "content": active_system_prompt},
                    {"role": "user", "content": user_content},
                ],
                think=False,
                format=GroundednessSchema.model_json_schema(),
                options={"temperature": 0.0},
            )

            result_data = json.loads(response.message.content or "{}")
            return {
                "grounded": result_data.get("grounded", False),
                "unsupportedClaims": result_data.get("unsupportedClaims", []),
                "confidence": result_data.get("confidence", 0.0),
            }

        except Exception as e:
            print(f"[GroundednessAgent Error] Ollama call failed: {str(e)}")
            return {
                "grounded": False,
                "unsupportedClaims": [],
                "confidence": 0.0,
                "error": str(e),
                "reason": "근거 충실성 검증 중 오류가 발생했습니다.",
            }
