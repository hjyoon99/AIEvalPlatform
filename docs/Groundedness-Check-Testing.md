# Groundedness Check 검증 과정

`GroundednessAgent`(#20)를 어떻게 검증했는지, 왜 그 방식을 택했는지, 그리고 검증 과정에서 실제로 무엇을 발견했는지 기록한다.

## 1. 왜 두 층으로 테스트를 나눴는가

`GroundednessAgent`가 검증해야 할 것은 두 가지 서로 다른 성격의 정확성이다.

1. **배선이 맞는가**: `classify_answer_type`이 RAG 유형을 올바르게 판별해 `groundedness_check`로 라우팅하는가, 그 결과가 `evaluate` 단계까지 실제로 전달되는가. 이건 그래프 구조/데이터 흐름의 문제이고, LLM이 무슨 답을 내든 상관없이 결정론적으로 검증 가능하다.
2. **판단이 맞는가**: 실제로 근거 문서와 일치하는 답변과 모순되는 답변을 주면, LLM이 정말로 다른 결과를 내는가. 이건 프롬프트/모델의 문제이고, Ollama를 실제로 호출해봐야만 확인할 수 있다.

기존 `VerifierAgent`/`EvaluatorAgent`/`SupervisorAgent`는 전부 (1)만 fake 객체로 검증하고 (2)는 자동화하지 않았다. `GroundednessAgent`는 이슈 #20의 완료 조건 자체가 "모순 샘플과 일치 샘플에서 서로 다른 결과가 나온다"는 (2)에 해당하는 요구라서, 이번엔 실제 Ollama를 호출하는 통합 테스트를 추가로 만들었다.

## 2. 테스트 구성

### 2.1 그래프 레벨 (fake, `tests/test_evaluation_graph.py`)

`FakeGroundedness`를 주입해 실제 LLM 호출 없이 배선만 검증한다.

| 테스트 | 검증 내용 |
| --- | --- |
| `test_rag_metadata_routes_through_groundedness_check` | RAG 메타데이터가 있으면 `groundedness_check`가 실행되고, 결과가 `evaluate` 호출 kwargs(`groundedness_result`)에 그대로 전달된다 |
| `test_ungrounded_result_still_reaches_evaluator` | `grounded=False` 결과도 그래프가 멈추지 않고 `evaluate`까지 정상 진행되며, 그 값이 그대로 전달된다 |
| `test_tool_call_metadata_routes_through_tool_call_check` | 도구호출 메타데이터면 `groundedness_check`를 건너뛴다(회귀 확인) |
| `test_no_metadata_skips_both_checks` | 메타데이터가 없으면 두 체크 모두 건너뛰고 기존과 동일하게 동작한다(하위 호환) |

Ollama가 없는 환경(CI 등)에서도 항상 실행되는 기본 테스트다.

### 2.2 에이전트 레벨 (실제 Ollama, `tests/test_groundedness_agent.py`)

`@pytest.mark.integration`으로 표시하고, `pytest.ini`의 `addopts = -m "not integration"`으로 기본 `pytest` 실행에서는 제외했다. 로컬에 Ollama(`qwen3.5:4b`)가 떠 있어야 하므로 명시적으로 `pytest -m integration`을 실행해야 돈다.

| 테스트 | 샘플 | 기대 결과 |
| --- | --- | --- |
| `test_groundedness_distinguishes_grounded_answer` | 근거 문서 내용과 일치하는 답변 | `grounded=True`, `unsupportedClaims=[]` |
| `test_groundedness_flags_unsupported_claim` | 근거 문서에 없는 주장("배송비도 전액 부담")이 섞인 답변 | `grounded=False`, `unsupportedClaims`에 1개 이상 |
| `test_groundedness_accepts_plain_string_documents` | `retrievedDocuments`를 `{content, source}` 객체가 아니라 순수 문자열로 전달 | `grounded=True` (형식 관계없이 동일하게 동작) |

`test_groundedness_skips_llm_call_when_no_documents`는 근거 문서가 없을 때 Ollama를 호출하지 않고 즉시 반환하는 경로라 LLM 판단이 필요 없어 기본 테스트에 포함했다.

두 샘플 모두 같은 근거 문서(환불 정책: "7일 이내 전액 환불 가능, 배송비는 고객 부담")를 쓰고, 답변에 "배송비도 전액 부담해드립니다"라는 근거 없는 문장 하나만 추가해 최소 차이로 결과가 갈리는지 확인한다.

## 3. 실행 중 실제로 발견한 버그

`test_groundedness_distinguishes_grounded_answer`(근거와 일치하는 답변)를 처음 돌렸을 때 **실패**했다.

```
assert result["unsupportedClaims"] == []
# → [{'claim': '배송비는 고객이 부담합니다.',
#     'reason': "[자료 1]에는 '배송비가 고객에게 부과된다'고 명시되어
#                있으나, AI 답변에는 이 내용이 포함되어 있지 않습니다."}]
```

LLM이 **"근거 문서에는 있지만 답변이 언급하지 않은 내용"(누락)**을 **"답변의 근거 없는 주장"**으로 잘못 분류했다. 최초 프롬프트가 "답변의 주장이 문서로 뒷받침되는지 판단하라"고만 지시했는데, 이걸 양방향(답변↔문서 커버리지 비교)으로 해석한 것이다.

Groundedness(faithfulness)는 원래 **단방향** 지표다 — "답변이 지어낸 말을 하지 않았는가"이지 "답변이 문서를 빠짐없이 요약했는가"(이건 별개로 relevance/completeness 지표)가 아니다. 실제 LLM 응답을 보지 않았다면 이 혼동을 코드 리뷰만으로는 못 잡았을 것이다.

**수정**: 시스템 프롬프트에 다음을 명시적으로 추가했다(`app/agents/groundedness.py`).

```text
이 검증은 오직 한 방향입니다: AI 에이전트 답변(Output)이 실제로 주장한
내용만 보고, 그 각각의 주장이 근거 문서로 뒷받침되는지 판단하세요.

절대 하지 말아야 할 것: 근거 문서에는 있지만 답변이 언급하지 않은 내용을
'근거 없는 주장'으로 지적하지 마세요. 답변이 문서의 일부만 인용하거나
요약해서 다른 내용을 생략하는 것은 정상이며 결함이 아닙니다. 오직 답변이
실제로 말한 문장 중 문서에 없거나 문서와 모순되는 것만 unsupportedClaims에
넣으세요.
```

수정 후 같은 테스트를 재실행해 통과를 확인했고, "근거 없는 주장이 섞인 답변" 샘플도 여전히 `grounded=False`로 정확히 잡아내는 것을 함께 확인했다(수정이 민감도를 과도하게 낮추지 않았음을 검증).

## 4. 결과

```
pytest                    # 9 passed (integration 3개 제외, 기본 실행)
pytest -m integration     # 3 passed (실제 Ollama 호출)
```

완료 조건("근거 문서와 모순되는 답변 샘플과 일치하는 샘플에서 서로 다른 결과가 나옵니다")은 mock이 아닌 실제 모델 응답으로 검증됐다.

## 5. 재현/실행 방법

```bash
cd apps/agent-engine

# 기본 테스트 (Ollama 불필요)
pytest

# 실제 Ollama 호출 포함 (로컬에 qwen3.5:4b 필요)
pytest -m integration
```
