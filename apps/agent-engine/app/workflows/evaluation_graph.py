import logging
from typing import Any, Dict, List, Optional, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from app.agents import EvaluatorAgent, SupervisorAgent, VerifierAgent

logger = logging.getLogger(__name__)


class EvaluationState(TypedDict, total=False):
    """LangGraph 노드 간에 공유되는 평가 파이프라인 상태.

    Attributes:
        prompt: 원래 사용자 질문/요청 텍스트.
        output: 검증/평가 대상인 AI 에이전트의 답변 텍스트.
        expected_output: 정답/기대 답변(선택).
        verification: `VerifierAgent.run` 결과. 아직 실행 전이면 `None`.
        evaluation: `EvaluatorAgent.run` 결과(또는 skip stub). 아직 실행 전이거나
            RETRY로 재평가를 기다리는 동안은 `None`.
        supervision: `SupervisorAgent.run` 결과. 아직 판정 전이거나 RETRY로
            재판정을 기다리는 동안은 `None`.
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
    verification: Optional[Dict[str, Any]]
    evaluation: Optional[Dict[str, Any]]
    supervision: Optional[Dict[str, Any]]
    supervisor_feedback: Optional[str]
    retry_count: int
    max_retries: int
    pass_threshold: float
    judge_model: str
    criteria: List[Dict[str, Any]]
    agent_prompts: Dict[str, str]


class EvaluationWorkflow:
    """`supervisor`를 허브로 두고 워커(verify/evaluate/skip_evaluation)를
    호출하는 LangGraph 워크플로.

    라우팅 권한은 전부 `supervisor` 노드 하나에 집중된다. 워커 노드는
    실행이 끝나면 항상 `supervisor`로만 복귀하며 서로를 직접 호출하지
    않는다. `supervisor`는 누적된 상태(`verification`/`evaluation`/
    `supervision`)를 보고 매번 다음 행동을 `Command(goto=...)`로 결정한다.

    실제 판정(PASS/FAIL/RETRY)은 `SupervisorAgent`(LLM)가 내리지만, 그
    판정을 실제 노드 이동으로 바꾸는 라우팅 자체는 코드가 제한된 enum
    값(`verify`/`evaluate`/`skip_evaluation`/`END`)만으로 결정한다.

    용어 주의: 여기서 "supervisor"는 이 그래프 안의 라우팅 허브 노드를
    가리키며, Backend의 `JudgeJob`/`JudgeWorker`(Agent Engine 전체 호출
    1건을 감싸는 큐 테이블/워커, `apps/backend/prisma/schema.prisma`)와는
    다른 개념이다. 향후 다중 모델 합의(consensus) 로직을 노드로 추가할
    때는 `consensus_evaluator`/`aggregate_consensus`처럼 명명하고,
    `JudgeJob`/`JudgeWorker`가 이미 쓰고 있는 `judge_*` 접두어는 쓰지
    않는다.
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
        """`supervisor`를 허브로 두고 워커 노드가 항상 복귀하는 상태 그래프를 만든다.

        Returns:
            `START -> supervisor`로 시작하는 컴파일된 LangGraph 실행 그래프.
            `verify`/`evaluate`/`skip_evaluation` 워커는 실행 후 고정 엣지로
            무조건 `supervisor`로만 복귀하며, `supervisor`는 매번 상태를 보고
            `Command(goto=...)`로 다음 워커(또는 `END`)를 결정한다.
        """
        builder = StateGraph(EvaluationState)
        builder.add_node(
            "supervisor",
            self._supervisor_node,
            destinations=("verify", "evaluate", "skip_evaluation", END),
        )
        builder.add_node("verify", self._verify)
        builder.add_node("evaluate", self._evaluate)
        builder.add_node("skip_evaluation", self._skip_evaluation)

        builder.add_edge(START, "supervisor")
        builder.add_edge("verify", "supervisor")
        builder.add_edge("evaluate", "supervisor")
        builder.add_edge("skip_evaluation", "supervisor")
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

    async def _skip_evaluation(self, state: EvaluationState) -> Dict[str, Any]:
        """`skip_evaluation` 노드: Verifier가 무효 판정을 내렸을 때 EvaluatorAgent
        호출 없이 stub 평가 결과를 채워 넣는다.

        Supervisor는 이미 `verification.isValid=False`인 경우 LLM 호출 없이
        즉시 FAIL을 반환하므로(`supervisor.py`), 이 노드가 채우는 stub은
        실제 채점에 쓰이지 않고 `EvalResult.evaluation`에 스킵 사실을
        기록하는 용도다.

        Args:
            state: `verification`을 포함하는 현재 그래프 상태.

        Returns:
            상태에 병합될 `{"evaluation": <stub 딕셔너리>}`. stub은
            `score=0.0`, `metrics={}`, `skipped=True`, `reason`(스킵 사유)을
            포함한다.
        """
        reason = state["verification"].get(
            "reason", "Verifier가 답변을 무효로 판정했습니다."
        )
        logger.info("evaluation_skipped reason=%s", reason)
        return {
            "evaluation": {
                "score": 0.0,
                "metrics": {},
                "skipped": True,
                "reason": reason,
            }
        }

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

    async def _supervisor_node(self, state: EvaluationState) -> Command:
        """`supervisor` 노드: 누적된 상태를 보고 다음 행동을 매번 재판단하는 허브.

        워커가 아직 실행되지 않은 단계로 라우팅하고, 모든 워커가 끝나
        평가 결과가 갖춰지면 그때 `SupervisorAgent`(LLM)를 호출해 최종
        판정을 받는다. LLM의 판정(PASS/FAIL/RETRY)을 실제 `Command.goto`로
        바꾸는 결정은 코드가 내리며, 제한된 노드 이름/`END`만 반환한다.

        RETRY 판정 시에는 `retry_count`를 증가시키고 `evaluation`과
        `supervision`을 `None`으로 되돌려, 다음 `evaluate` 실행 후 이
        노드가 재판정을 수행하도록 신호를 남긴다.

        Args:
            state: `verification`/`evaluation`/`supervision`의 진행 상태와
                `prompt`, `output`, `judge_model` 등을 포함하는 현재 그래프 상태.

        Returns:
            다음으로 이동할 노드(`verify`/`evaluate`/`skip_evaluation`/`END`)와
            상태 갱신 내용을 담은 `Command`.
        """
        if state.get("verification") is None:
            return Command(goto="verify")

        if state.get("evaluation") is None:
            target = "evaluate" if state["verification"].get("isValid", False) else "skip_evaluation"
            return Command(goto=target)

        if state.get("supervision") is None:
            retry_count = state.get("retry_count", 0)
            max_retries = state.get("max_retries", 1)
            supervision = await self.supervisor.run(
                prompt=state["prompt"],
                output=state["output"],
                expected_output=state.get("expected_output"),
                verification=state["verification"],
                evaluation=state["evaluation"],
                pass_threshold=state.get("pass_threshold", 0.7),
                retry_count=retry_count,
                max_retries=max_retries,
                system_prompt=state.get("agent_prompts", {}).get("supervisor"),
                model=state["judge_model"],
            )

            if supervision["verdict"] == "RETRY" and retry_count <= max_retries:
                return Command(
                    goto="evaluate",
                    update={
                        "retry_count": retry_count + 1,
                        "supervisor_feedback": supervision["reason"],
                        "evaluation": None,
                        "supervision": None,
                    },
                )
            return Command(goto=END, update={"supervision": supervision})

        # 방어적 처리: verification/evaluation/supervision이 모두 채워진
        # 상태로 다시 들어오는 경우는 정상 흐름에서 발생하지 않는다.
        raise RuntimeError("supervisor_node reached with no pending action")

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
        """초기 상태를 구성하여 supervisor 허브 그래프를 실행한다.

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
