from typing import Any, Dict, List, Literal, Optional, TypedDict

from langgraph.graph import END, START, StateGraph

from app.agents import EvaluatorAgent, SupervisorAgent, VerifierAgent


class EvaluationState(TypedDict, total=False):
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
    criteria: List[Dict[str, Any]]
    agent_prompts: Dict[str, str]


class EvaluationWorkflow:
    """Verifier, Evaluator, Supervisor를 연결하는 LangGraph 워크플로."""

    def __init__(
        self,
        verifier: VerifierAgent,
        evaluator: EvaluatorAgent,
        supervisor: SupervisorAgent,
    ):
        self.verifier = verifier
        self.evaluator = evaluator
        self.supervisor = supervisor
        self.graph = self._build_graph()

    def _build_graph(self):
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
        verification = await self.verifier.run(
            prompt=state["prompt"],
            output=state["output"],
            system_prompt=state.get("agent_prompts", {}).get("verifier"),
        )
        return {"verification": verification}

    async def _evaluate(self, state: EvaluationState) -> Dict[str, Any]:
        evaluation = await self.evaluator.run(
            prompt=state["prompt"],
            output=state["output"],
            expected_output=state.get("expected_output"),
            supervisor_feedback=state.get("supervisor_feedback"),
            criteria=state.get("criteria"),
            system_prompt=state.get("agent_prompts", {}).get("evaluator"),
        )
        return {"evaluation": evaluation}

    async def _supervise(self, state: EvaluationState) -> Dict[str, Any]:
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
        )

        result: Dict[str, Any] = {"supervision": supervision}
        if supervision["verdict"] == "RETRY":
            result["retry_count"] = retry_count + 1
            result["supervisor_feedback"] = supervision["reason"]
        return result

    @staticmethod
    def _route_supervision(state: EvaluationState) -> Literal["retry", "end"]:
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
        criteria: Optional[List[Dict[str, Any]]] = None,
        agent_prompts: Optional[Dict[str, str]] = None,
    ) -> EvaluationState:
        return await self.graph.ainvoke(
            {
                "prompt": prompt,
                "output": output,
                "expected_output": expected_output,
                "retry_count": 0,
                "max_retries": max_retries,
                "pass_threshold": pass_threshold,
                "criteria": criteria or [],
                "agent_prompts": agent_prompts or {},
            }
        )
