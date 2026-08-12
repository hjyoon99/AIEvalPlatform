from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, Dict, Any, List
from dotenv import load_dotenv

from app.agents import (
    EvaluatorAgent,
    GroundednessAgent,
    SupervisorAgent,
    ScenarioGeneratorAgent,
    TaskExecutorAgent,
    ToolCallCheckAgent,
    VerifierAgent,
)
from app.workflows import EvaluationWorkflow

load_dotenv()

app = FastAPI(
    title="AI Agent Evaluation Engine",
    description="LangGraph Supervisor 패턴 기반 AI 답변 품질 평가 API",
    version="0.2.0",
)

executor = TaskExecutorAgent()
verifier = VerifierAgent()
evaluator = EvaluatorAgent()
supervisor = SupervisorAgent()
groundedness = GroundednessAgent()
tool_call_check = ToolCallCheckAgent()
evaluation_workflow = EvaluationWorkflow(
    verifier=verifier,
    evaluator=evaluator,
    supervisor=supervisor,
    groundedness=groundedness,
    tool_call=tool_call_check,
)
scenario_generator = ScenarioGeneratorAgent()

# Request/Response 스키마
class DatasetItemMetadata(BaseModel):
    """답변 유형(RAG/도구호출/일반) 분류에 쓰이는 부가 정보.

    필드가 전부 생략되면(또는 `metadata` 자체가 없으면) 해당 항목은
    "일반" 유형으로 처리된다.

    Attributes:
        retrievedDocuments: RAG 답변이 근거로 인용한 문서 목록(선택).
        toolCalls: 도구 호출 답변이 실행한 도구 호출 목록(선택).
    """

    retrievedDocuments: Optional[List[Any]] = None
    toolCalls: Optional[List[Any]] = None


class EvalDatasetItem(BaseModel):
    """평가 요청(`EvalRequest`) 내 데이터셋 한 건.

    Attributes:
        prompt: 평가할 사용자 질문/요청 텍스트.
        output: 평가할 외부 AI의 답변. 생략하면 `TaskExecutorAgent`가
            대신 답변을 생성한다.
        expectedOutput: 정답/기대 답변(선택).
        criteria: 이 항목에만 적용할 사용자 정의 평가 지표 목록. 생략 시
            `EvalRequest.criteria`(요청 전체 기본 지표)가 사용된다.
        metadata: 답변 유형 분류용 부가 정보(선택). 생략 시 "일반" 유형으로
            처리된다.
    """

    prompt: str
    output: Optional[str] = Field(
        default=None,
        description=(
            "평가할 외부 AI의 답변입니다. 생략하면 테스트용 Agent 1이 답변을 생성합니다."
        ),
    )
    expectedOutput: Optional[str] = None
    criteria: Optional[List[Dict[str, Any]]] = None
    metadata: Optional[DatasetItemMetadata] = None


class AgentPrompts(BaseModel):
    """verifier/evaluator/supervisor/groundedness/toolCall 각 에이전트에 적용할 커스텀 시스템 프롬프트.

    Attributes:
        verifier: `VerifierAgent`에 사용할 커스텀 시스템 프롬프트(선택).
        evaluator: `EvaluatorAgent`에 사용할 커스텀 시스템 프롬프트(선택).
        supervisor: `SupervisorAgent`에 사용할 커스텀 시스템 프롬프트(선택).
        groundedness: `GroundednessAgent`에 사용할 커스텀 시스템 프롬프트(선택).
        toolCall: `ToolCallCheckAgent`에 사용할 커스텀 시스템 프롬프트(선택).
    """

    verifier: Optional[str] = None
    evaluator: Optional[str] = None
    supervisor: Optional[str] = None
    groundedness: Optional[str] = None
    toolCall: Optional[str] = None


class EvalRequest(BaseModel):
    """`/agents/evaluate`, `/agents/evaluate/sync`의 요청 본문 스키마.

    Attributes:
        runId: 이 평가 실행을 식별하는 외부 run ID.
        agentName: 평가 대상 에이전트의 이름.
        targetModel: 답변을 생성할 때(dataset의 output이 없을 때) 사용할
            모델명. 생략 시 `TaskExecutorAgent`의 기본 모델을 사용한다.
        judgeModel: verifier/evaluator/supervisor 호출에 공통으로 사용할
            Ollama 모델명.
        maxRetries: 감독관이 RETRY를 판정할 수 있는 최대 횟수(0~2).
        passThreshold: 통과로 인정할 최소 평가 점수(0.0~1.0).
        criteria: 데이터셋 항목에 개별 criteria가 없을 때 사용할 기본
            평가 지표 목록.
        metadata: `TaskExecutorAgent` 답변 생성 시 참고할 부가 메타데이터
            (예: `systemPrompt`).
        agentPrompts: 각 내부 에이전트에 적용할 커스텀 시스템 프롬프트.
        dataset: 평가할 테스트 항목 목록. 생략 시 내장된 샘플 1건을 사용한다.
    """

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "runId": "test-run-001",
                "agentName": "customer-support-agent",
                "judgeModel": "qwen3.5:4b",
                "maxRetries": 1,
                "passThreshold": 0.7,
                "dataset": [
                    {
                        "prompt": "대한민국의 수도는 어디인가요?",
                        "output": "대한민국의 수도는 서울입니다.",
                        "expectedOutput": "대한민국의 수도는 서울입니다.",
                    },
                    {
                        "prompt": "물의 화학식을 알려주세요.",
                        "output": "물의 화학식은 CO2입니다.",
                        "expectedOutput": "물의 화학식은 H2O입니다.",
                    },
                ],
            }
        }
    )

    runId: str
    agentName: str
    targetModel: Optional[str] = None
    judgeModel: str = "qwen3.5:4b"
    maxRetries: int = Field(default=1, ge=0, le=2)
    passThreshold: float = Field(default=0.7, ge=0.0, le=1.0)
    criteria: List[Dict[str, Any]] = Field(default_factory=list)
    metadata: Optional[Dict[str, Any]] = None
    agentPrompts: Optional[AgentPrompts] = None
    dataset: Optional[List[EvalDatasetItem]] = None


class ScenarioGenerateRequest(BaseModel):
    """`/scenarios/generate`의 요청 본문 스키마.

    Attributes:
        domain: 시나리오를 생성할 대상 도메인.
        description: 도메인에 대한 부가 설명(선택).
        context: 시나리오 생성에 참고할 비즈니스 컨텍스트.
        criteria: 평가 루브릭 작성 시 참고할 평가 지표 목록.
        count: 생성할 시나리오 개수(1~10).
        model: 시나리오 생성 및 자동검증에 사용할 Ollama 모델명.
    """

    domain: str
    description: Optional[str] = None
    context: Dict[str, Any] = Field(default_factory=dict)
    criteria: List[Dict[str, Any]] = Field(default_factory=list)
    count: int = Field(default=5, ge=1, le=10)
    model: str = "qwen3.5:4b"


# 핵심 파이프라인 연결 및 실행 로직
async def run_evaluation_pipeline(request: EvalRequest):
    """요청의 각 데이터셋 항목에 대해 답변 생성(선택) 및 평가 워크플로를 실행한다.

    데이터셋 항목에 `output`이 없으면 `TaskExecutorAgent`로 답변을 생성한
    뒤, `EvaluationWorkflow`(supervisor 허브가 verify/evaluate를 라우팅)를
    실행하여 검증/채점/최종 판정 결과를 수집한다.

    Args:
        request: 평가 실행 설정과 데이터셋을 담은 `EvalRequest`.
            `dataset`이 없으면 내장된 샘플 1건으로 대체한다.

    Returns:
        데이터셋 항목별 결과 딕셔너리 목록. 각 항목은 `prompt`, `output`,
        `expectedOutput`, `outputSource`("provided" 또는 "generated"),
        `score`, `passed`, `verdict`, `verification`, `evaluation`,
        `supervision`, `retryCount`, `metrics`를 포함한다.
    """
    test_dataset = request.dataset or [
        EvalDatasetItem(
            prompt="환불 규정에 대해 설명해 줘.",
            output="구매 후 7일 이내 환불 가능합니다.",
            expectedOutput="구매 후 7일 이내 환불 가능합니다.",
        )
    ]

    results_log = []

    for idx, item in enumerate(test_dataset, 1):
        print(f"\n================ [ Test Item {idx} ] ================")
        print(f"📥 Prompt: {item.prompt}")

        output_source = "provided"
        output = item.output
        if output is None:
            output_source = "generated"
            output = await executor.run(
                prompt=item.prompt,
                model=request.targetModel,
                metadata=request.metadata,
            )
        print(f"🤖 Target AI Output ({output_source}):\n{output}\n")

        graph_result = await evaluation_workflow.run(
            prompt=item.prompt,
            output=output,
            expected_output=item.expectedOutput,
            max_retries=request.maxRetries,
            pass_threshold=request.passThreshold,
            judge_model=request.judgeModel,
            criteria=item.criteria or request.criteria,
            agent_prompts=(
                request.agentPrompts.model_dump(exclude_none=True)
                if request.agentPrompts
                else {}
            ),
            output_metadata=(
                item.metadata.model_dump(exclude_none=True)
                if item.metadata
                else None
            ),
        )

        verification = graph_result["verification"]
        eval_result = graph_result["evaluation"]
        supervision = graph_result["supervision"]

        print(f"🔍 Agent 2 Verification: {verification}")
        print(f"📊 Agent 3 Evaluation: {eval_result}")
        print(f"🧭 Supervisor Final Verdict: {supervision}\n")

        result_payload = {
            "prompt": item.prompt,
            "output": output,
            "expectedOutput": item.expectedOutput,
            "outputSource": output_source,
            "score": eval_result["score"],
            "passed": supervision["verdict"] == "PASS",
            "verdict": supervision["verdict"],
            "verification": verification,
            "evaluation": eval_result,
            "supervision": supervision,
            "retryCount": graph_result.get("retry_count", 0),
            "metrics": eval_result["metrics"],
        }
        results_log.append(result_payload)

    print("\n================ [ Pipeline Completed ] ================")
    return results_log


# 📌 API 엔드포인트
@app.get("/health")
async def health_check():
    """서비스 헬스체크 엔드포인트.

    Returns:
        서비스 상태와 사용 중인 워크플로 유형을 담은 딕셔너리
        (`status`, `service`, `workflow`).
    """
    return {
        "status": "ok",
        "service": "agent-engine",
        "workflow": "langgraph-supervisor",
    }


@app.post("/agents/evaluate")
async def evaluate(request: EvalRequest, background_tasks: BackgroundTasks):
    """평가 실행 API (백그라운드 비동기 처리).

    파이프라인을 FastAPI `BackgroundTasks`에 등록하고 즉시 접수 응답을
    반환한다. 실행 결과는 이 응답에 포함되지 않는다.

    Args:
        request: 평가 실행 설정과 데이터셋을 담은 `EvalRequest`.
        background_tasks: 파이프라인을 백그라운드로 실행시키기 위한
            FastAPI 의존성 객체.

    Returns:
        접수 상태를 나타내는 딕셔너리(`status`, `message`, `runId`).
    """
    background_tasks.add_task(run_evaluation_pipeline, request)
    return {
        "status": "Accepted",
        "message": "Evaluation pipeline started in background.",
        "runId": request.runId
    }


@app.post("/agents/evaluate/sync")
async def evaluate_sync(request: EvalRequest):
    """[테스트용] 결과를 화면에서 즉시 확인하는 동기(Sync) 평가 API.

    Args:
        request: 평가 실행 설정과 데이터셋을 담은 `EvalRequest`.

    Returns:
        `runId`와 `run_evaluation_pipeline`이 반환한 전체 결과 목록
        (`results`)을 담은 딕셔너리.
    """
    results = await run_evaluation_pipeline(request)
    return {
        "runId": request.runId,
        "results": results
    }


@app.post("/scenarios/generate")
async def generate_scenarios(request: ScenarioGenerateRequest):
    """도메인 기반 테스트 시나리오를 생성하는 API.

    Args:
        request: 도메인, 컨텍스트, 평가 지표, 생성 개수, 모델을 담은
            `ScenarioGenerateRequest`.

    Returns:
        `ScenarioGeneratorAgent.run`이 반환한 시나리오 목록을 담은
        딕셔너리(`scenarios`).
    """
    scenarios = await scenario_generator.run(
        domain=request.domain,
        description=request.description,
        context=request.context,
        criteria=request.criteria,
        count=request.count,
        model=request.model,
    )
    return {"scenarios": scenarios}
