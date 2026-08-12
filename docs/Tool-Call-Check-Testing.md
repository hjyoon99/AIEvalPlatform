# Tool Call Check 검증 과정

`ToolCallCheckAgent`(#21)를 어떻게 검증했는지, 왜 그 방식을 택했는지 기록한다. `groundedness_check`(#20) 검증과 같은 구조를 따른다 — 자세한 배경은 [Groundedness-Check-Testing.md](./Groundedness-Check-Testing.md) 참고.

## 1. 테스트 구성

### 1.1 그래프 레벨 (fake, `tests/test_evaluation_graph.py`)

`FakeToolCall`을 주입해 실제 LLM 호출 없이 배선만 검증한다.

| 테스트 | 검증 내용 |
| --- | --- |
| `test_tool_call_metadata_routes_through_tool_call_check` | 도구호출 메타데이터가 있으면 `tool_call_check`가 실행되고, 결과가 `evaluate` 호출 kwargs(`tool_call_result`)에 그대로 전달된다 |
| `test_invalid_tool_call_result_still_reaches_evaluator` | `valid=False` 결과도 그래프가 멈추지 않고 `evaluate`까지 정상 진행되며, 그 값이 그대로 전달된다 |
| `test_rag_metadata_routes_through_groundedness_check` | RAG 메타데이터면 `tool_call_check`를 건너뛴다(회귀 확인, `groundedness_check`와 상호 배타적) |
| `test_no_metadata_skips_both_checks` | 메타데이터가 없으면 두 체크 모두 건너뛰고 기존과 동일하게 동작한다(하위 호환) |

### 1.2 에이전트 레벨 (실제 Ollama, `tests/test_tool_call_check_agent.py`)

`@pytest.mark.integration`으로 표시하고 기본 `pytest` 실행에서는 제외된다(`pytest.ini`의 `addopts`). `pytest -m integration`으로 명시 실행해야 한다.

| 테스트 | 샘플 | 기대 결과 |
| --- | --- | --- |
| `test_tool_call_check_passes_valid_call` | "서울 날씨" 질문 → `get_weather(city=서울)` 호출 | `valid=True`, `issues=[]` |
| `test_tool_call_check_flags_invalid_parameter` | 같은 질문인데 `get_weather(city=도쿄)`로 호출(질문과 불일치) | `valid=False`, `issues`에 1개 이상 |
| `test_tool_call_check_accepts_string_tool_calls` | `toolCalls` 항목을 객체가 아니라 순수 문자열로 전달 | 정상 동작(형식 관계없이) |

`test_tool_call_check_skips_llm_call_when_no_calls`는 도구 호출 정보가 없을 때 Ollama를 호출하지 않는 경로라 LLM 판단이 필요 없어 기본 테스트에 포함했다.

두 핵심 샘플은 같은 질문("서울 날씨 알려줘")에 도시 파라미터 하나만 바꿔(`서울` → `도쿄`) 최소 차이로 결과가 갈리는지 확인한다. `groundedness_check` 검증 때와 동일한 최소-차이 설계다.

## 2. 결과

`groundedness_check`와 달리 이번엔 **첫 실행에서 3개 통합 테스트가 전부 통과**했다. 시스템 프롬프트를 작성할 때 이미 `groundedness_check`에서 배운 교훈(모호한 지시는 LLM이 의도와 다르게 해석할 수 있다)을 반영해, "확실하지 않으면 문제로 지적하지 말라"는 보수적 지침과 `invalid_parameter`/`unnecessary_call` 두 카테고리를 명확히 분리해 처음부터 넣었기 때문으로 보인다.

```
pytest                    # 11 passed (integration 6개 제외, 기본 실행)
pytest -m integration     # 6 passed (groundedness 3 + tool_call 3, 실제 Ollama 호출)
```

완료 조건("정상 호출 케이스와 잘못된 파라미터 케이스에서 서로 다른 결과가 나옵니다")은 mock이 아닌 실제 모델 응답으로 검증됐다.

## 3. 재현/실행 방법

```bash
cd apps/agent-engine

# 기본 테스트 (Ollama 불필요)
pytest

# 실제 Ollama 호출 포함 (로컬에 qwen3.5:4b 필요)
pytest -m integration
```
