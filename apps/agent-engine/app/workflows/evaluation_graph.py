from typing import Any, Dict, List, Literal, Optional, TypedDict

from langgraph.graph import END, START, StateGraph

from app.agents import EvaluatorAgent, SupervisorAgent, VerifierAgent


class EvaluationState(TypedDict, total=False):
    """LangGraph 노드 간에 공유되는 평가 파이프라인 상태.

    Attributes:
        prompt: 원래 사용자 질문/요청 텍스트.
        output: 검증/평가 대상인 AI 에이전트의 답변 텍스트.
        expected_output: 정답/기대 답변(선택).
        verification: `VerifierAgent.run` 결과.
        evaluation: `EvaluatorAgent.run` 결과.
        supervision: `SupervisorAgent.run` 결과.
        supervisor_feedback: 감독관이 RETRY를 지시했을 때 남긴 재평가 사유.
        retry_count: 지금까지 수행한 재평가 횟수.
        max_retries: 허용되는 최대 재평가 횟수.
        pass_threshold: 통과로 인정할 최소 평가 점수.
        judge_model: 각 에이전트 호출에 사용할 Ollama 모델명.
        criteria: 사용자 정의 평가 지표 목록.
        agent_prompts: 에이전트별(verifier/evaluator/supervisor) 커스텀
            시스템 프롬프트 딕셔너리.
    """

    prompt: str
    output: str
    expected_output: Optional[str]
    verification: Dict[str, Any]
    evaluation: Dict[str, Any]
    supervision: Dict[str, Any]
    supervisor_feedback: Optional[str]
    retry_count: int
    max_retries: int
    pass_threshold: float
    judge_model: str
    criteria: List[Dict[str, Any]]
    agent_prompts: Dict[str, str]


class EvaluationWorkflow:
    """Verifier, Evaluator, Supervisor를 연결하는 LangGraph 워크플로.

    `verify -> evaluate -> supervise` 순서로 노드를 실행하며, 감독관이
    RETRY를 판정하면 `evaluate` 노드로 돌아가 재평가 루프를 돈다.
    """

    def __init__(
        self,
        verifier: VerifierAgent,
        evaluator: EvaluatorAgent,
        supervisor: SupervisorAgent,
    ):
        """세 에이전트를 주입받아 LangGraph 상태 그래프를 컴파일한다.

        Args:
            verifier: 1차 유효성/안전성 검증을 수행하는 `VerifierAgent`.
            evaluator: 지표 기반 채점을 수행하는 `EvaluatorAgent`.
            supervisor: 최종 PASS/FAIL/RETRY 판정을 내리는 `SupervisorAgent`.

        Attributes set:
            verifier, evaluator, supervisor: 주입된 각 에이전트 인스턴스.
            graph: `_build_graph`로 컴파일된 실행 가능한 LangGraph 그래프.
        """
        self.verifier = verifier
        self.evaluator = evaluator
        self.supervisor = supervisor
        self.graph = self._build_graph()

    def _build_graph(self):
        """verify/evaluate/supervise 노드와 재평가 라우팅을 연결한 상태 그래프를 만든다.

        Returns:
            `START -> verify -> evaluate -> supervise` 순서로 실행되고,
            supervise 이후 `_route_supervision` 결과에 따라 `evaluate`로
            되돌아가거나(RETRY) `END`로 종료되는(PASS/FAIL) 컴파일된
            LangGraph 실행 그래프.
        """
        builder = StateGraph(EvaluationState)
        builder.add_node("verify", self._verify)
        builder.add_node("evaluate", self._evaluate)
        builder.add_node("supervise", self._supervise)

        builder.add_edge(START, "verify")
        builder.add_edge("verify", "evaluate")
        builder.add_edge("evaluate", "supervise")
        builder.add_conditional_edges(
            "supervise",
            self._route_supervision,
            {
                "retry": "evaluate",
                "end": END,
            },
        )
        return builder.compile()

    async def _verify(self, state: EvaluationState) -> Dict[str, Any]:
        """`verify` 노드: 현재 상태를 기반으로 VerifierAgent를 실행한다.

        Args:
            state: 최소한 `prompt`, `output`, `judge_model`을 포함하는
                현재 그래프 상태.

        Returns:
            상태에 병합될 `{"verification": <VerifierAgent.run 결과>}` 딕셔너리.
        """
        verification = await self.verifier.run(
            prompt=state["prompt"],
            output=state["output"],
            system_prompt=state.get("agent_prompts", {}).get("verifier"),
            model=state["judge_model"],
        )
        return {"verification": verification}

    async def _evaluate(self, state: EvaluationState) -> Dict[str, Any]:
        """`evaluate` 노드: 현재 상태를 기반으로 EvaluatorAgent를 실행한다.

        재평가(RETRY) 루프로 재진입한 경우 `state["supervisor_feedback"]`가
        평가 프롬프트에 함께 전달되어 이전과 독립적으로 다시 채점하도록 한다.

        Args:
            state: 최소한 `prompt`, `output`, `pass_threshold`, `judge_model`을
                포함하는 현재 그래프 상태.

        Returns:
            상태에 병합될 `{"evaluation": <EvaluatorAgent.run 결과>}` 딕셔너리.
        """
        evaluation = await self.evaluator.run(
            prompt=state["prompt"],
            output=state["output"],
            expected_output=state.get("expected_output"),
            supervisor_feedback=state.get("supervisor_feedback"),
            criteria=state.get("criteria"),
            system_prompt=state.get("agent_prompts", {}).get("evaluator"),
            pass_threshold=state["pass_threshold"],
            model=state["judge_model"],
        )
        return {"evaluation": evaluation}

    async def _supervise(self, state: EvaluationState) -> Dict[str, Any]:
        """`supervise` 노드: 검증/평가 결과를 감독관에게 넘겨 최종 판정을 받는다.

        판정이 RETRY이면 `retry_count`를 1 증가시키고, 다음 `evaluate`
        노드 실행에 사용할 `supervisor_feedback`을 상태에 추가한다.

        Args:
            state: `prompt`, `output`, `verification`, `evaluation`,
                `judge_model` 등을 포함하는 현재 그래프 상태.

        Returns:
            상태에 병합될 딕셔너리. 항상 `supervision`을 포함하며,
            RETRY 판정 시에는 갱신된 `retry_count`와 `supervisor_feedback`도
            함께 포함한다.
        """
        retry_count = state.get("retry_count", 0)
        supervision = await self.supervisor.run(
            prompt=state["prompt"],
            output=state["output"],
            expected_output=state.get("expected_output"),
            verification=state["verification"],
            evaluation=state["evaluation"],
            pass_threshold=state.get("pass_threshold", 0.7),
            retry_count=retry_count,
            max_retries=state.get("max_retries", 1),
            system_prompt=state.get("agent_prompts", {}).get("supervisor"),
            model=state["judge_model"],
        )

        result: Dict[str, Any] = {"supervision": supervision}
        if supervision["verdict"] == "RETRY":
            result["retry_count"] = retry_count + 1
            result["supervisor_feedback"] = supervision["reason"]
        return result

    @staticmethod
    def _route_supervision(state: EvaluationState) -> Literal["retry", "end"]:
        """`supervise` 노드 이후 다음 단계를 결정하는 조건부 라우팅 함수.

        Args:
            state: `supervision` 판정 결과와 `retry_count`, `max_retries`를
                포함하는 현재 그래프 상태.

        Returns:
            판정이 "RETRY"이고 재시도 횟수가 한도 이내이면 `"retry"`
            (evaluate 노드로 재진입), 그 외에는 `"end"`(그래프 종료).
        """
        supervision = state["supervision"]
        if (
            supervision["verdict"] == "RETRY"
            and state.get("retry_count", 0) <= state.get("max_retries", 1)
        ):
            return "retry"
        return "end"

    async def run(
        self,
        prompt: str,
        output: str,
        expected_output: Optional[str] = None,
        max_retries: int = 1,
        pass_threshold: float = 0.7,
        judge_model: str = "qwen3.5:4b",
        criteria: Optional[List[Dict[str, Any]]] = None,
        agent_prompts: Optional[Dict[str, str]] = None,
    ) -> EvaluationState:
        """초기 상태를 구성하여 verify -> evaluate -> supervise 그래프를 실행한다.

        Args:
            prompt: 평가할 사용자 질문/요청 텍스트.
            output: 검증/평가 대상인 AI 에이전트의 답변 텍스트.
            expected_output: 정답/기대 답변(선택).
            max_retries: 감독관이 RETRY를 판정할 수 있는 최대 횟수.
            pass_threshold: 통과로 인정할 최소 평가 점수.
            judge_model: verifier/evaluator/supervisor 호출에 공통으로
                사용할 Ollama 모델명.
            criteria: 사용자 정의 평가 지표 목록. 생략 시 빈 목록.
            agent_prompts: 에이전트별 커스텀 시스템 프롬프트 딕셔너리.
                생략 시 빈 딕셔너리.

        Returns:
            그래프 실행이 끝난 뒤의 최종 `EvaluationState`
            (`verification`, `evaluation`, `supervision`, `retry_count` 등 포함).
        """
        return await self.graph.ainvoke(
            {
                "prompt": prompt,
                "output": output,
                "expected_output": expected_output,
                "retry_count": 0,
                "max_retries": max_retries,
                "pass_threshold": pass_threshold,
                "judge_model": judge_model,
                "criteria": criteria or [],
                "agent_prompts": agent_prompts or {},
            }
        )
