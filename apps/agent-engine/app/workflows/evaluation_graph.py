import logging
import operator
from typing import Annotated, Any, Callable, Dict, List, Literal, Optional, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, Send

from app.agents import (
    EvaluatorAgent,
    GroundednessAgent,
    SupervisorAgent,
    ToolCallCheckAgent,
    VerifierAgent,
)

logger = logging.getLogger(__name__)

# #39 ADR(docs/ADR-Consensus-Judge-Models.md)에서 확정한 컨센서스용 모델
# 3종이다. [설계 결정 필요] 지금은 하드코딩이며, 나중에 EvalRun 설정으로
# 옮길 여지를 남겨둔다.
CONSENSUS_MODELS = ["qwen3.5:4b", "llama3.2:3b", "mistral:7b"]


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
        output_metadata: 답변 유형(RAG/도구호출/일반) 분류에 쓰이는 부가
            정보(`retrievedDocuments`/`toolCalls`). 없으면 "일반" 유형으로
            처리된다.
        groundedness_result: `groundedness_check` 결과. RAG 유형이 아니거나
            아직 실행 전이면 `None`.
        tool_call_result: `tool_call_check` 결과. 도구호출 유형이 아니거나
            아직 실행 전이면 `None`.
        escalated_during_retries: RETRY 루프를 도는 동안 한 번이라도
            `supervision.escalation`이 "ESCALATE_MULTI_JUDGE"였는지
            누적한 플래그(#40). RETRY 라운드마다 `supervision`이
            `None`으로 리셋되면서 그 라운드의 escalation 신호도 같이
            사라지는 걸 막기 위한 것 — 최종 판정(PASS/FAIL) 시점에 이
            플래그가 True면, 마지막 라운드 자체는 confidence가 높고
            score도 경계선이 아니었더라도 최종 `escalation`을
            "ESCALATE_MULTI_JUDGE"로 강제한다. 한 번이라도 애매했던
            케이스는 끝까지 애매했던 케이스로 취급한다는 뜻이다.
        consensus_model: `consensus_evaluator` 노드 하나의 인스턴스가
            담당할 모델명(#41). `Send("consensus_evaluator", {...,
            "consensus_model": model})`로 fan-out될 때만 채워지며,
            일반 단일 모델 경로에서는 쓰이지 않는다.
        consensus_results: `consensus_evaluator`가 반환한, 모델명이
            태깅된 독립 채점 결과 목록(#41). `Annotated[..., operator.add]`
            리듀서라서, `CONSENSUS_MODELS` 개수만큼 병렬로 뜬
            `consensus_evaluator` 인스턴스들이 각자 원소 1개짜리 리스트를
            반환해도 LangGraph가 자동으로 이어붙여(concat) 최종적으로는
            전체 결과가 다 모인다 — 그래서 "덮어쓰기"가 아니라
            "누적"이어야 하고, 이 필드만 다른 필드들과 리듀서 방식이 다르다.
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
    output_metadata: Dict[str, Any]
    groundedness_result: Optional[Dict[str, Any]]
    tool_call_result: Optional[Dict[str, Any]]
    escalated_during_retries: bool
    consensus_model: str
    consensus_results: Annotated[List[Dict[str, Any]], operator.add]


class EvaluationWorkflow:
    """`supervisor`를 허브로 두고 워커(verify/evaluate/skip_evaluation/
    groundedness_check/tool_call_check)를 호출하는 LangGraph 워크플로.

    라우팅 권한은 전부 `supervisor` 노드 하나에 집중된다. 워커 노드는
    실행이 끝나면 항상 `supervisor`로만 복귀하며 서로를 직접 호출하지
    않는다. `supervisor`는 누적된 상태(`verification`/`evaluation`/
    `supervision`)를 보고 매번 다음 행동을 `Command(goto=...)`로 결정한다.

    검증이 유효하면 `_classify_answer_type`(LLM 호출 없는 순수 코드
    판별)이 `output_metadata`를 보고 답변 유형을 정하고, RAG 유형이면
    `groundedness_check`, 도구호출 유형이면 `tool_call_check`를 먼저
    거친 뒤 `evaluate`로 넘어간다. 메타데이터가 없으면 기존과 동일하게
    바로 `evaluate`로 간다. `groundedness_check`는 `GroundednessAgent`로
    근거 충실성을, `tool_call_check`는 `ToolCallCheckAgent`로 도구 호출의
    파라미터 타당성/필요성을 검증한다. 결과가 부정적(`grounded=False`
    또는 `valid=False`)이면 `evaluate` 채점 프롬프트에 감점 참고 신호로
    전달된다.

    실제 판정(PASS/FAIL/RETRY)은 `SupervisorAgent`(LLM)가 내리지만, 그
    판정을 실제 노드 이동으로 바꾸는 라우팅 자체는 코드가 제한된 enum
    값(`verify`/`evaluate`/`skip_evaluation`/`END`)만으로 결정한다.

    `consensus_evaluator`(#41)는 이 hub-and-spoke 패턴 밖에 있는 별도
    노드다. `supervisor`가 최종 판정에서 `escalation="ESCALATE_MULTI_JUDGE"`를
    확정하면, 다른 워커들처럼 `supervisor`로 돌아오는 대신
    `Send`로 `CONSENSUS_MODELS` 개수만큼 병렬 fan-out되고, 각 인스턴스는
    실행 후 `supervisor`가 아니라 곧장 `END`로 간다 — 아직 `#42`
    (aggregate_consensus)가 없어서 fan-out 결과를 모으기만 하고
    최종 판정에 반영하지는 않는다.

    용어 주의: 여기서 "supervisor"는 이 그래프 안의 라우팅 허브 노드를
    가리키며, Backend의 `JudgeJob`/`JudgeWorker`(Agent Engine 전체 호출
    1건을 감싸는 큐 테이블/워커, `apps/backend/prisma/schema.prisma`)와는
    다른 개념이다.
    """

    def __init__(
        self,
        verifier: VerifierAgent,
        evaluator: EvaluatorAgent,
        supervisor: SupervisorAgent,
        groundedness: GroundednessAgent,
        tool_call: ToolCallCheckAgent,
        consensus_evaluator_factory: Callable[[str], EvaluatorAgent] = EvaluatorAgent,
    ):
        """다섯 에이전트와 컨센서스 팩토리를 주입받아 LangGraph 상태 그래프를 컴파일한다.

        Args:
            verifier: 1차 유효성/안전성 검증을 수행하는 `VerifierAgent`.
            evaluator: 지표 기반 채점을 수행하는 `EvaluatorAgent`(단일
                모델 경로용).
            supervisor: 최종 PASS/FAIL/RETRY 판정을 내리는 `SupervisorAgent`.
            groundedness: RAG 답변의 근거 충실성을 검증하는 `GroundednessAgent`.
            tool_call: 도구 호출의 파라미터 타당성/필요성을 검증하는
                `ToolCallCheckAgent`.
            consensus_evaluator_factory: 모델명 하나를 받아 그 모델용
                `EvaluatorAgent` 인스턴스를 새로 만드는 팩토리(#41). 기본값은
                `EvaluatorAgent` 클래스 자체(`EvaluatorAgent(model)`과 동일).
                `consensus_evaluator` 노드가 fan-out될 때마다 이 팩토리로
                매번 새 인스턴스를 만들어, 병렬로 뜬 다른 인스턴스와 상태를
                공유하지 않는 완전한 격리를 보장한다. 테스트에서는 실제
                Ollama 호출 없는 가짜 팩토리로 교체할 수 있다.

        Attributes set:
            verifier, evaluator, supervisor, groundedness, tool_call:
                주입된 각 에이전트 인스턴스.
            consensus_evaluator_factory: 주입된 컨센서스 팩토리.
            graph: `_build_graph`로 컴파일된 실행 가능한 LangGraph 그래프.
        """
        self.verifier = verifier
        self.evaluator = evaluator
        self.supervisor = supervisor
        self.groundedness = groundedness
        self.tool_call = tool_call
        self.consensus_evaluator_factory = consensus_evaluator_factory
        self.graph = self._build_graph()

    def _build_graph(self):
        """`supervisor`를 허브로 두고 워커 노드가 항상 복귀하는 상태 그래프를 만든다.

        Returns:
            `START -> supervisor`로 시작하는 컴파일된 LangGraph 실행 그래프.
            `verify`/`evaluate`/`skip_evaluation`/`groundedness_check`/
            `tool_call_check` 워커는 실행 후 고정 엣지로 무조건
            `supervisor`로만 복귀하며, `supervisor`는 매번 상태를 보고
            `Command(goto=...)`로 다음 워커(또는 `END`)를 결정한다.
            `consensus_evaluator`(#41)만 예외로, `supervisor`가 `Send`로
            fan-out한 뒤 곧장 `END`로 연결된다 — hub-and-spoke 패턴 밖의
            fan-out 전용 노드이기 때문이다.
        """
        builder = StateGraph(EvaluationState)
        builder.add_node(
            "supervisor",
            self._supervisor_node,
            destinations=(
                "verify",
                "evaluate",
                "skip_evaluation",
                "groundedness_check",
                "tool_call_check",
                "consensus_evaluator",
                END,
            ),
        )
        builder.add_node("verify", self._verify)
        builder.add_node("evaluate", self._evaluate)
        builder.add_node("skip_evaluation", self._skip_evaluation)
        builder.add_node("groundedness_check", self._groundedness_check)
        builder.add_node("tool_call_check", self._tool_call_check)
        builder.add_node("consensus_evaluator", self._consensus_evaluator)

        builder.add_edge(START, "supervisor")
        builder.add_edge("verify", "supervisor")
        builder.add_edge("evaluate", "supervisor")
        builder.add_edge("skip_evaluation", "supervisor")
        builder.add_edge("groundedness_check", "supervisor")
        builder.add_edge("tool_call_check", "supervisor")
        # consensus_evaluator는 supervisor로 복귀하지 않는다 — #42가
        # 생기기 전까지는 fan-out 결과를 모으기만 하고 곧장 종료한다.
        builder.add_edge("consensus_evaluator", END)
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

    @staticmethod
    def _classify_answer_type(
        state: EvaluationState,
    ) -> Literal["rag", "tool_call", "general"]:
        """`output_metadata`만 보고 답변 유형을 판별하는 순수 코드 함수. LLM 호출 없음.

        `retrievedDocuments`와 `toolCalls`가 모두 있으면 RAG 검증을
        우선한다. 필드가 없거나 빈 값이면 "일반" 유형으로 처리해
        메타데이터가 없는 기존 요청도 에러 없이 동작하도록 한다.

        Args:
            state: `output_metadata`를 포함하는 현재 그래프 상태.

        Returns:
            `"rag"`, `"tool_call"`, `"general"` 중 하나.
        """
        metadata = state.get("output_metadata") or {}
        if metadata.get("retrievedDocuments"):
            return "rag"
        if metadata.get("toolCalls"):
            return "tool_call"
        return "general"

    async def _groundedness_check(self, state: EvaluationState) -> Dict[str, Any]:
        """`groundedness_check` 노드: RAG 답변의 근거 충실성을 검증한다.

        `output_metadata.retrievedDocuments`를 근거로 `GroundednessAgent`를
        실행해 답변의 각 주장이 실제로 뒷받침되는지 판단한다. 결과는
        `evaluate` 단계의 채점 프롬프트에 감점 참고 신호로 전달된다.

        Args:
            state: `output_metadata`를 포함하는 현재 그래프 상태.

        Returns:
            상태에 병합될 `{"groundedness_result": <GroundednessAgent.run 결과>}`.
        """
        metadata = state.get("output_metadata") or {}
        result = await self.groundedness.run(
            prompt=state["prompt"],
            output=state["output"],
            retrieved_documents=metadata.get("retrievedDocuments"),
            system_prompt=state.get("agent_prompts", {}).get("groundedness"),
            model=state["judge_model"],
        )
        return {"groundedness_result": result}

    async def _tool_call_check(self, state: EvaluationState) -> Dict[str, Any]:
        """`tool_call_check` 노드: 도구 호출의 파라미터 타당성/필요성을 검증한다.

        `output_metadata.toolCalls`를 근거로 `ToolCallCheckAgent`를 실행해
        각 도구 호출이 질문 의도에 비춰 타당했는지 판단한다. 결과는
        `evaluate` 단계의 채점 프롬프트에 감점 참고 신호로 전달된다.

        Args:
            state: `output_metadata`를 포함하는 현재 그래프 상태.

        Returns:
            상태에 병합될 `{"tool_call_result": <ToolCallCheckAgent.run 결과>}`.
        """
        metadata = state.get("output_metadata") or {}
        result = await self.tool_call.run(
            prompt=state["prompt"],
            output=state["output"],
            tool_calls=metadata.get("toolCalls"),
            system_prompt=state.get("agent_prompts", {}).get("toolCall"),
            model=state["judge_model"],
        )
        return {"tool_call_result": result}

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
        `groundedness_check`/`tool_call_check`를 거친 답변이면 그 결과도
        함께 전달되어 근거 없는 주장/부적절한 도구 호출이 감점 참고
        신호로 반영된다.

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
            groundedness_result=state.get("groundedness_result"),
            tool_call_result=state.get("tool_call_result"),
        )
        return {"evaluation": evaluation}

    async def _consensus_evaluator(self, state: EvaluationState) -> Dict[str, Any]:
        """`consensus_evaluator` 노드: 컨센서스 모델 하나로 독립적으로
        재채점한다(#41).

        `supervisor`가 최종 판정에서 `escalation="ESCALATE_MULTI_JUDGE"`를
        확정하면, `CONSENSUS_MODELS` 개수만큼 `Send`로 이 노드가 병렬
        fan-out된다. 이 노드 자체는 hub-and-spoke 패턴 밖에 있어 실행 후
        `supervisor`로 돌아가지 않고 곧장 `END`로 간다(`_build_graph`).

        `state["supervisor_feedback"]`은 의도적으로 넘기지 않는다 — 1차
        Supervisor의 재평가 사유가 컨센서스 모델에게 새어 들어가면,
        컨센서스 모델들이 서로(그리고 1차 판정과도) 독립적이어야 한다는
        `#37` 설계 원칙(anchoring 방지)이 깨지기 때문이다.

        Args:
            state: 최소한 `prompt`, `output`, `pass_threshold`, 그리고 이
                인스턴스가 담당할 `consensus_model`을 포함하는 상태. 이
                필드는 `Send("consensus_evaluator", {**state,
                "consensus_model": model})`로 fan-out될 때만 채워진다.

        Returns:
            `{"consensus_results": [{"model": <담당 모델명>,
            **EvaluatorAgent.run 결과}]}`. `consensus_results`는
            `Annotated[..., operator.add]` 리듀서라서, 병렬로 뜬 다른
            `consensus_evaluator` 인스턴스가 반환한 원소 1개짜리 리스트와
            자동으로 이어붙여진다 — 그래서 이 노드는 항상 리스트 하나에
            결과 하나만 담아 반환하면 되고, 최종적으로는
            `len(CONSENSUS_MODELS)`개가 다 모인 리스트가 된다.
        """
        model = state["consensus_model"]
        # 매 fan-out 인스턴스마다 새 EvaluatorAgent를 만든다 — 병렬로 뜬
        # 다른 인스턴스와 상태(예: 내부 클라이언트)를 공유하지 않는
        # 완전한 격리를 보장하기 위함이다(#41 완료 조건).
        agent = self.consensus_evaluator_factory(model)
        result = await agent.run(
            prompt=state["prompt"],
            output=state["output"],
            expected_output=state.get("expected_output"),
            criteria=state.get("criteria"),
            system_prompt=state.get("agent_prompts", {}).get("evaluator"),
            pass_threshold=state.get("pass_threshold", 0.7),
            model=model,
            groundedness_result=state.get("groundedness_result"),
            tool_call_result=state.get("tool_call_result"),
        )
        return {"consensus_results": [{"model": model, **result}]}

    async def _supervisor_node(self, state: EvaluationState) -> Command:
        """`supervisor` 노드: 누적된 상태를 보고 다음 행동을 매번 재판단하는 허브.

        워커가 아직 실행되지 않은 단계로 라우팅하고, 모든 워커가 끝나
        평가 결과가 갖춰지면 그때 `SupervisorAgent`(LLM)를 호출해 최종
        판정을 받는다. LLM의 판정(PASS/FAIL/RETRY)을 실제 `Command.goto`로
        바꾸는 결정은 코드가 내리며, 제한된 노드 이름/`END`만 반환한다.

        RETRY 판정 시에는 `retry_count`를 증가시키고 `evaluation`과
        `supervision`을 `None`으로 되돌려, 다음 `evaluate` 실행 후 이
        노드가 재판정을 수행하도록 신호를 남긴다. 이때 이번 라운드의
        `supervision.escalation`이 "ESCALATE_MULTI_JUDGE"였다면
        `escalated_during_retries`에 누적해두고(#40), 최종 판정이 날 때
        이 누적값을 다시 반영해 중간 라운드의 애매함 신호가 리셋 때문에
        유실되지 않게 한다.

        Args:
            state: `verification`/`evaluation`/`supervision`의 진행 상태와
                `prompt`, `output`, `judge_model` 등을 포함하는 현재 그래프 상태.

        Returns:
            다음으로 이동할 노드(`verify`/`groundedness_check`/
            `tool_call_check`/`evaluate`/`skip_evaluation`/`END`)와 상태
            갱신 내용을 담은 `Command`.
        """
        if state.get("verification") is None:
            return Command(goto="verify")

        verification = state["verification"]
        if verification.get("isValid", False):
            answer_type = self._classify_answer_type(state)
            if answer_type == "rag" and state.get("groundedness_result") is None:
                return Command(goto="groundedness_check")
            if answer_type == "tool_call" and state.get("tool_call_result") is None:
                return Command(goto="tool_call_check")

        if state.get("evaluation") is None:
            target = "evaluate" if verification.get("isValid", False) else "skip_evaluation"
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

            escalated_so_far = state.get("escalated_during_retries", False) or (
                supervision.get("escalation") == "ESCALATE_MULTI_JUDGE"
            )

            if supervision["verdict"] == "RETRY" and retry_count <= max_retries:
                return Command(
                    goto="evaluate",
                    update={
                        "retry_count": retry_count + 1,
                        "supervisor_feedback": supervision["reason"],
                        "evaluation": None,
                        "supervision": None,
                        "escalated_during_retries": escalated_so_far,
                    },
                )

            # 최종 판정(PASS/FAIL) 시점: 지금 이 라운드는 안 애매했더라도
            # 이전 RETRY 라운드 중 한 번이라도 애매했다면(#40), 그 신호를
            # 리셋으로 잃지 않고 최종 escalation에 그대로 되살린다.
            if escalated_so_far:
                supervision = {**supervision, "escalation": "ESCALATE_MULTI_JUDGE"}
                # 애매함이 확정되면 END로 바로 가지 않고, 컨센서스 모델
                # 전원에게 동시에(#41) 독립 재채점을 맡긴다. #42
                # (aggregate_consensus)가 생기기 전까지는 fan-out 결과를
                # 모으기만 하고, 최종 판정 자체는 여전히 1차 supervision을
                # 그대로 쓴다.
                return Command(
                    goto=[
                        Send(
                            "consensus_evaluator",
                            {**state, "consensus_model": model},
                        )
                        for model in CONSENSUS_MODELS
                    ],
                    update={"supervision": supervision},
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
        output_metadata: Optional[Dict[str, Any]] = None,
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
            output_metadata: 답변 유형(RAG/도구호출/일반) 분류에 쓰이는
                `retrievedDocuments`/`toolCalls` 등 부가 정보(선택). 생략
                시 "일반" 유형으로 처리된다.

        Returns:
            그래프 실행이 끝난 뒤의 최종 `EvaluationState`
            (`verification`, `evaluation`, `supervision`, `retry_count`,
            그리고 컨센서스로 에스컬레이션됐다면 `consensus_results` 등 포함).
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
                "output_metadata": output_metadata or {},
                "consensus_results": [],
            }
        )
