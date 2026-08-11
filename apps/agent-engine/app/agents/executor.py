import os
from typing import Dict, Any, Optional
from ollama import AsyncClient
from dotenv import load_dotenv

load_dotenv()

class TaskExecutorAgent:
    """Agent 1: Ollama 로컬 모델로 답변을 생성하는 에이전트.

    평가 대상 output이 주어지지 않은 데이터셋 항목에 대해, 지정된(또는 기본)
    Ollama 모델을 호출하여 대체 답변을 생성하는 역할을 한다.
    """

    def __init__(self, default_model: str = "qwen3.5:4b"):
        """에이전트를 초기화하고 Ollama 비동기 클라이언트를 준비한다.

        Args:
            default_model: `run` 호출 시 별도 모델이 지정되지 않았을 때
                사용할 기본 Ollama 모델명.

        Attributes set:
            default_model: 기본 모델명.
            client: `OLLAMA_HOST` 환경 변수(기본값
                `http://localhost:11434`)로 연결되는 `AsyncClient` 인스턴스.
        """
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
        """주어진 프롬프트에 대해 Ollama 모델로 답변을 생성한다.

        Args:
            prompt: 사용자 질문/요청 텍스트.
            model: 이번 호출에 사용할 모델명. 생략 시 `default_model`을 사용한다.
            metadata: 부가 설정 딕셔너리. `"systemPrompt"` 키가 있으면 해당
                값을 시스템 프롬프트로 사용하고, 없으면 기본 안내 문구를 사용한다.

        Returns:
            모델이 생성한 답변 텍스트(앞뒤 공백 제거됨).

        Raises:
            Exception: Ollama API 호출이 실패하면 에러를 로그로 남긴 뒤
                동일 예외를 다시 발생시킨다.
        """
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
