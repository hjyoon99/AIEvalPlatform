# ADR: 컨센서스용 로컬 모델 3종 확정 (#39)

- **상태:** 확정
- **관련 이슈:** `#37`(다중 모델 컨센서스 에스컬레이션 에픽), `#39`(다양한 로컬 모델 3종 확보)
- **선행 문서:** `docs/Supervisor-Escalation-Signal-Design.md`(에스컬레이션 신호, `#38`/`#40`)

## 1. 배경

`#37` 에픽의 컨센서스는 Supervisor가 애매하다고 판단한(`escalation="ESCALATE_MULTI_JUDGE"`) 케이스를, 계열이 다른 모델 3개가 서로의 결과를 보지 않고 독립적으로 재채점하게 하는 것이다. 같은 모델을 N번 돌리면 그 모델의 편향을 그대로 반복할 뿐이라, `#37` 설계 원칙상 계열이 다른 모델이 필수다.

지금까지 확보된 건 `qwen3.5:4b`(Alibaba, 기존 기본 judge 모델) 하나뿐이었다. `#39`는 여기에 계열이 다른 모델 2개를 추가로 확보하고, 구조화 출력을 실제로 낼 수 있는지 검증하는 게 목표다.

## 2. 왜 `EvaluatorAgent` 기준으로 벤치마크했는가

`#41`(consensus_evaluator 노드) 이슈 원문을 보면 "Send API로 3개 모델에 대해 독립 병렬 **EvaluatorAgent** 실행"이라고 명시돼 있다 — 컨센서스가 실제로 fan-out하는 대상은 `SupervisorAgent`가 아니라 `EvaluatorAgent`다(최종 판정 합의는 이후 `#42`의 `aggregate_consensus`가 담당). 그래서 이번 벤치마크는 `EvaluatorAgent.run()`이 사용하는 `DynamicEvaluationSchema` 구조화 출력 기준으로 진행했다. `SupervisorAgent` 관점의 모델 비교(confidence 캘리브레이션 등)는 별도로 `docs/Supervisor-Escalation-Signal-Design.md` §5에 이미 기록돼 있다.

## 3. 벤치마크 방법

`apps/agent-engine/scripts/benchmark_judge_models.py`로 5개의 다양한 케이스(단순 사실 확인, 정책/부분 정답, 기술/오답, 안전 민감 회피성 답변, 다중 지표 지정)를 각 후보 모델에 순서대로 태워, 다음 두 가지를 측정했다.

- **구조화 출력 준수율**: `EvaluatorAgent.run()`이 예외 없이 `DynamicEvaluationSchema`에 맞는 JSON을 돌려줬는지(`metrics.error`가 없는 비율).
- **응답 속도**: 케이스 1건당 걸린 시간(평균/p95).

재현 방법:

```bash
cd apps/agent-engine
source venv/bin/activate
python scripts/benchmark_judge_models.py --models <모델명...>
```

## 4. 후보 5개와 결과

| 모델 | 계열 | 준수율 | 평균 지연 | p95 지연 | 판정 |
|---|---|---|---|---|---|
| `qwen3.5:4b` | Alibaba Qwen | 100% (5/5) | 10,214ms | 18,531ms | ✅ 채택 (기존 기본 모델) |
| `llama3.2:3b` | Meta Llama | 100% (5/5) | 4,591ms | 6,162ms | ✅ 채택 |
| `mistral:7b` | Mistral AI | 100% (5/5) | 8,451ms | 12,984ms | ✅ 채택 |
| `gemma3:4b` | Google Gemma | 100% (5/5) | 8,344ms | 16,991ms | ❌ 탈락 (§5.1) |
| `phi3.5` | Microsoft Phi | 60% (3/5) | 41,639ms | 88,297ms | ❌ 탈락 (§5.2) |

### 5.1 `gemma3:4b` 탈락 사유 — score와 reason의 자기모순

5개 중 2개(40%) 케이스에서, 모델이 반환한 지표별 `reason`이 명백히 부정적인데 같은 응답의 `score`는 만점(1.0)이었다. 예시(케이스 3, "이 코드의 시간복잡도는?" — 정답 O(n^2), 답변 O(n log n)):

```json
{
  "key": "faithfulness",
  "score": 1.0,
  "reason": "답변(O(n log n))은 제공된 코드에 대한 시간 복잡도 분석이 아닙니다. 정답(O(n^2))은 코드의 알고리즘을 기반으로 한 정확한 시간 복잡도입니다. 따라서 답변은 사실적으로 정확하지 않습니다."
}
```

`reason`이 "사실적으로 정확하지 않습니다"라고 명시하는데 `score`는 1.0이다. 케이스 4(안전 민감 회피성 답변)에서도 동일한 패턴이 재현됐다. 이건 벤치마크 스크립트나 `evaluator.py`의 집계 로직 문제가 아니라(`app/agents/evaluator.py`의 `EvaluatorAgent.run()`이 받은 원본 JSON을 그대로 확인해 재현함), **모델이 반환하는 구조화 출력 자체의 내적 일관성 결함**이다. 구조화 출력 스키마 자체는 지켰지만(그래서 "준수율"은 100%), 점수를 신뢰할 수 없다면 judge 모델로서 자격이 없다고 판단해 제외했다.

### 5.2 `phi3.5` 탈락 사유 — 스키마 실패와 응답 속도

5개 중 2개(40%) 케이스에서 Ollama가 `"an error was encountered while running the model: unexpected EOF (status code: 500)"`를 반환해 `EvaluatorAgent`가 예외 폴백 경로로 빠졌다(`metrics.error`에 기록됨). 성공한 3개 케이스도 응답이 평균 40초 이상 걸렸고(p95 88초), 근거 텍스트에 "x/10" 같은 다른 채점 관례가 섞여 나오는 등 출력 품질도 불안정했다. 준수율·속도·품질 세 축에서 모두 다른 후보보다 뒤처져 제외했다.

## 5. 결정 — 최종 3종

**`qwen3.5:4b`(Alibaba Qwen) + `llama3.2:3b`(Meta Llama) + `mistral:7b`(Mistral AI)**

세 계열이 서로 다르고, 5개 케이스 전부 구조화 출력을 예외 없이 생성했다. `#37` 설계 원칙("계열이 다른 모델을 섞는다")을 충족한다.

## 6. 알려진 한계 (탈락시키진 않았지만 기록해둘 것)

- **`llama3.2:3b`**: 이번 벤치마크(5개 케이스)에서는 문제가 없었지만, 별도로 진행한 Supervisor 관점 테스트(`docs/Supervisor-Escalation-Signal-Design.md` §5)에서 실제 답변과 기대값(expected_output)을 혼동해 틀린 근거로 PASS를 준 사례가 1건 있었다. 완전히 신뢰할 수 있는 모델은 아니라는 뜻이므로, `#42`(aggregate_consensus)에서 다수결/편차 계산 시 이 모델 하나의 판정에 과도한 가중치를 주지 않는 설계가 필요하다.
- **`mistral:7b`**: 한국어 프롬프트를 줘도 `reason`을 영어로 반환한다. 채점 결과 자체(`score`)에는 영향이 없지만, 컨센서스 상세를 Dashboard에 노출할 때(`#43`) 근거 텍스트 언어가 모델마다 달라 사용자 경험이 일관되지 않을 수 있다. 시스템 프롬프트에 "반드시 한국어로 답하라"는 지시를 명시적으로 추가하면 해결 가능성이 높지만, 이번 벤치마크 범위에서는 검증하지 않았다.
- **리소스 사용량**: 3개 모델을 전부 로컬에 두면 디스크 `3.4 + 2.0 + 4.4 ≈ 9.8GB`. `#41`이 세 모델을 실제로 "동시에" 로드해 병렬 실행하면(현재 로컬 환경은 16GB RAM), `docs/Judge-Worker-Concurrency-Tuning.md`에서 다뤘던 메모리 압박이 다시 문제가 될 수 있다. `#41` 구현 시 `OLLAMA_MAX_LOADED_MODELS`와 실제 동시 로드 가능 여부를 먼저 확인해야 한다.

## 7. 탈락 모델 정리 여부

`gemma3:4b`(3.3GB), `phi3.5`(2.2GB)는 로컬에 그대로 남아있다. 디스크 공간이 급하지 않다면(`df -h` 기준 여유 300GB+) 굳이 지울 필요는 없지만, 원하면 `ollama rm gemma3:4b phi3.5`로 정리 가능하다.

## 8. 완료 조건 충족 여부

`#39` 완료 조건: "3개 모델이 로컬에서 정상적으로 구조화 출력을 생성함을 확인합니다." — `qwen3.5:4b`, `llama3.2:3b`, `mistral:7b` 5개 케이스 전부 100% 충족. **완료.**

## 9. 다음 단계

`#41`(consensus_evaluator 노드 구현)의 선행 조건(`#38`, `#39`, `#40`)이 모두 충족됐다. `#41`을 시작할 수 있다.
