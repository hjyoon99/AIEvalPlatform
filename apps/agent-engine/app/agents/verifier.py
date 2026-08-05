import os
import json
from typing import Dict, Any, Optional
from pydantic import BaseModel, Field
from ollama import AsyncClient
from dotenv import load_dotenv

load_dotenv()

# Structured Output 스키마
class VerificationSchema(BaseModel):
    isValid: bool = Field(description="답변이 유효하고 안전하며 질문에 대한 형식을 갖추었는지 여부 (true/false)")
    reason: str = Field(description="검증 결과에 대한 핵심 사유 (한 문장)")

class VerifierAgent:
    """Agent 2: Ollama 기반 답변 포맷, 유효성 및 안전성 1차 검증 에이전트"""

    def __init__(self, verifier_model: str = "qwen3.5:4b"):
        self.verifier_model = verifier_model
        self.client = AsyncClient(
            host=os.getenv("OLLAMA_HOST", "http://localhost:11434")
        )

    async def run(
        self,
        prompt: str,
        output: str,
        system_prompt: Optional[str] = None,
    ) -> Dict[str, Any]:
        # 1. 1차 Rule-based 검증 (API 호출 절약용 - 빈값 또는 지나치게 짧은 경우)
        clean_output = output.strip()
        if not clean_output:
            return {"isValid": False, "reason": "응답 내용이 비어 있습니다."}
        
        if len(clean_output) < 5:
            return {"isValid": False, "reason": "응답 길이가 너무 짧아 유효하지 않습니다."}

        # 2. Ollama 기반 2차 유효성/안전성 검증
        active_system_prompt = system_prompt or (
            "당신은 AI 에이전트의 응답을 1차 검증하는 스크리너입니다.\n"
            "에이전트의 답변이 아래 결함 요소에 해당하는지 확인하세요.\n"
            "1. 질문과 전혀 상관없는 엉뚱한 답변\n"
            "2. '죄송하지만 답변할 수 없습니다' 등의 시스템 오류 메시지\n"
            "3. 부적절하거나 유해한 내용, 또는 깨진 문자열(null, [object Object] 등)\n\n"
            "문제가 없다면 isValid를 true로, 결함이 있다면 false로 지정하고 사유를 작성하세요."
        )

        user_content = f"### 질문:\n{prompt}\n\n### 에이전트 답변:\n{output}"

        try:
            response = await self.client.chat(
                model=self.verifier_model,
                messages=[
                    {"role": "system", "content": active_system_prompt},
                    {"role": "user", "content": user_content},
                ],
                think=False,
                format=VerificationSchema.model_json_schema(),
                options={"temperature": 0.0},
            )

            result_data = json.loads(response.message.content or "{}")
            return {
                "isValid": result_data.get("isValid", False),
                "reason": result_data.get("reason", "검증 결과를 파싱할 수 없습니다.")
            }

        except Exception as e:
            print(f"[VerifierAgent Error] Ollama verification failed: {str(e)}")
            return {
                "isValid": False,
                "reason": "검증 API 호출 중 오류가 발생했습니다.",
                "error": str(e),
            }
