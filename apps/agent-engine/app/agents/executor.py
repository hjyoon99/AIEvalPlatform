import os
from typing import Dict, Any, Optional
from ollama import AsyncClient
from dotenv import load_dotenv

load_dotenv()

class TaskExecutorAgent:
    """Agent 1: Ollama 로컬 모델로 답변을 생성하는 에이전트"""

    def __init__(self, default_model: str = "qwen3.5:4b"):
        self.default_model = default_model
        self.client = AsyncClient(
            host=os.getenv("OLLAMA_HOST", "http://localhost:11434")
        )

    async def run(
        self, 
        prompt: str, 
        model: Optional[str] = None, 
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        target_model = model or self.default_model

        system_instruction = "당신은 사용자 요청에 대해 명확하고 친절하게 답변하는 AI 에이전트입니다."
        if metadata and "systemPrompt" in metadata:
            system_instruction = metadata["systemPrompt"]

        try:
            response = await self.client.chat(
                model=target_model,
                messages=[
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": prompt},
                ],
                think=False,
                options={"temperature": 0.7},
            )

            return (response.message.content or "").strip()

        except Exception as e:
            print(f"[TaskExecutorAgent Error] Ollama API call failed: {str(e)}")
            raise e
