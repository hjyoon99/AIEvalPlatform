from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, Dict, Any, List
from dotenv import load_dotenv

from app.agents import (
    EvaluatorAgent,
    SupervisorAgent,
    ScenarioGeneratorAgent,
    TaskExecutorAgent,
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
evaluation_workflow = EvaluationWorkflow(
    verifier=verifier,
    evaluator=evaluator,
    supervisor=supervisor,
)
scenario_generator = ScenarioGeneratorAgent()

# Request/Response 스키마
class EvalDatasetItem(BaseModel):
    prompt: str
    output: Optional[str] = Field(
        default=None,
        description=(
            "평가할 외부 AI의 답변입니다. 생략하면 테스트용 Agent 1이 답변을 생성합니다."
        ),
    )
    expectedOutput: Optional[str] = None
    criteria: Optional[List[Dict[str, Any]]] = None


class EvalRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "runId": "test-run-001",
                "agentName": "customer-support-agent",
                "model": "qwen3.5:4b",
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
    model: Optional[str] = "qwen3.5:4b"
    maxRetries: int = Field(default=1, ge=0, le=2)
    passThreshold: float = Field(default=0.7, ge=0.0, le=1.0)
    criteria: List[Dict[str, Any]] = Field(default_factory=list)
    metadata: Optional[Dict[str, Any]] = None
    dataset: Optional[List[EvalDatasetItem]] = None


class ScenarioGenerateRequest(BaseModel):
    domain: str
    description: Optional[str] = None
    context: Dict[str, Any] = Field(default_factory=dict)
    criteria: List[Dict[str, Any]] = Field(default_factory=list)
    count: int = Field(default=5, ge=1, le=10)
    model: str = "qwen3.5:4b"


# 🔄 핵심 파이프라인 연결 및 실행 로직
async def run_evaluation_pipeline(request: EvalRequest):
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
                model=request.model,
                metadata=request.metadata,
            )
        print(f"🤖 Target AI Output ({output_source}):\n{output}\n")

        graph_result = await evaluation_workflow.run(
            prompt=item.prompt,
            output=output,
            expected_output=item.expectedOutput,
            max_retries=request.maxRetries,
            pass_threshold=request.passThreshold,
            criteria=item.criteria or request.criteria,
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
    return {
        "status": "ok",
        "service": "agent-engine",
        "workflow": "langgraph-supervisor",
    }


@app.post("/agents/evaluate")
async def evaluate(request: EvalRequest, background_tasks: BackgroundTasks):
    """
    평가 실행 API (백그라운드 비동기 처리)
    """
    background_tasks.add_task(run_evaluation_pipeline, request)
    return {
        "status": "Accepted", 
        "message": "Evaluation pipeline started in background.",
        "runId": request.runId
    }


@app.post("/agents/evaluate/sync")
async def evaluate_sync(request: EvalRequest):
    """
    [테스트용] 결과를 화면에서 즉시 확인하는 동기(Sync) 평가 API
    """
    results = await run_evaluation_pipeline(request)
    return {
        "runId": request.runId,
        "results": results
    }


@app.post("/scenarios/generate")
async def generate_scenarios(request: ScenarioGenerateRequest):
    scenarios = await scenario_generator.run(
        domain=request.domain,
        description=request.description,
        context=request.context,
        criteria=request.criteria,
        count=request.count,
        model=request.model,
    )
    return {"scenarios": scenarios}
