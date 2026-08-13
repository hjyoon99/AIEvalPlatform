# Supervisor 에스컬레이션 신호 설계 (Epic #37 / #38)

`#37`(다중 모델 컨센서스 에스컬레이션) 에픽의 `#38`(Supervisor 에스컬레이션 신호 추가)을 구현하며 나눈 논의, 설계 고민, 발견한 문제와 수정, 그리고 실측 테스트 결과를 정리한다.

## 1. 배경

`#37` 에픽의 목표는 Supervisor 혼자 판정하기 애매한 케이스를, 계열이 다른 로컬 모델 3개가 독립적으로(서로의 결과를 보지 않고) 재채점하게 하는 것이다. `#38`은 그 트리거 신호만 만드는 범위였다 — 실제 3-모델 컨센서스 실행(`#40`~`#43`)은 범위 밖.

## 2. 설계 논의와 결정

### 2.1 `recommendedAction`을 enum화할 것인가 (1차 결정)

`#38` 이슈 원문은 "`recommendedAction` Pydantic enum에 `ESCALATE_MULTI_JUDGE` 값 추가"라고 되어 있었다. 그런데 `recommendedAction`은 이미 Dashboard(`App.tsx:50`)에 자유 텍스트 조언으로 그대로 노출되고 있었다.

두 옵션을 놓고 논의했다.

| 옵션 | 내용 | 비용 |
|---|---|---|
| A | `recommendedAction`을 진짜 enum화, Dashboard에 매핑 테이블 추가 | Dashboard도 같이 손봐야 함 |
| **B (채택)** | `recommendedAction`은 자유 텍스트로 유지, `escalation`을 별도 필드로 신설 | `#38` 스코프 최소 유지, Dashboard 무변경 |

**결정: B.** `#38`의 목적은 "에스컬레이션 신호 추가"이지 `recommendedAction` 체계 전체를 갈아엎는 게 아니었다.

### 2.2 confidence 임계값

`AMBIGUITY_CONFIDENCE_THRESHOLD = 0.6`을 잠정치로 하드코딩. Epic E(캘리브레이션 전담)에서 재조정 대상으로 코드 주석에 명시.

## 3. 구현 (1차)

- `SupervisorDecisionSchema`에 `escalation: Literal["NONE", "ESCALATE_MULTI_JUDGE"]` 필드 추가 (필수, enum 고정)
- 시스템 프롬프트에 "애매하면 confidence를 낮추고 escalation을 ESCALATE_MULTI_JUDGE로 반환하라" 규칙 추가
- LLM 응답 파싱 후 `confidence < 0.6`이면 LLM 판단과 무관하게 코드가 `escalation`을 강제 — 기존 `pass_threshold` 강제 로직과 동일한 "LLM은 설명, 정량 기준은 코드가 강제" 패턴
- 규칙 기반 즉시 반환 4곳(검증 오류/무효, 평가 오류, 호출 예외) 모두 `escalation: "NONE"` 명시. 특히 Ollama 호출 실패 케이스는 confidence가 낮아도(0.5) 판정 애매함이 아니라 인프라 장애이므로 컨센서스로 보내지 않음

## 4. 발견 1 — 실측 데이터상 발생 빈도 0%

구현 직후 "이게 실제로 필요한 기능인가"를 검증하기 위해, 기존 DB에 쌓인 실행 결과에 새 로직을 소급 적용해봤다.

```
기존 EvalResult: 47건
supervision.confidence 분포: 0.85 ~ 1.0 (전부)
0.6 임계값 소급 적용 시 escalation 발생: 0건 (0%)
```

47건 전부 confidence 0.85 이상이라, confidence 단독 신호로는 과거 데이터 기준 단 한 번도 발동하지 않았을 것이라는 결론. 다만 샘플이 "대한민국의 수도는?" 같은 명백한 스모크 테스트 위주라 애초에 애매한 입력이 적었을 가능성이 있어, 이 수치만으로 "필요 없다"고 단정하지 않고 다음 단계로 진행.

## 5. 발견 2 — 모델별 confidence 캘리브레이션 비교

의도적으로 애매하게 설계한 4개 케이스(점수-근거 상충, 정책 위반 신호 vs 높은 점수, 검증/평가 모순, 회피성 답변)를 `qwen3.5:4b`와 `llama3.2:3b`(Meta, 다른 계열)에 동일하게 태워 비교했다.

| 케이스 | qwen3.5:4b confidence | llama3.2:3b confidence |
|---|---|---|
| 1. 근거 상충 | 0.95 | 0.8 |
| 2. 정책위반 신호 | 0.95 | 0.9 |
| 3. 근거 모순 | 0.85 | 0.8 |
| 4. 회피성 답변 | 0.95 | **0.5 (escalation 발동)** |

**결론:**
- qwen3.5:4b는 4개 다 0.85 이상 — confidence를 사실상 낮출 줄 모름
- llama3.2:3b는 변동폭이 있지만(0.5~0.9), 근거 품질이 불안정함 — 특히 2번 케이스에서 실제 답변("100% 전액 환불")과 기대값("환불 제한될 수 있음")을 혼동해 틀린 근거로 PASS 판정 (confidence는 오히려 0.9로 높게 나옴)
- "confidence를 잘 낮추는 모델"이 "판정이 정확한 모델"과 반드시 같지 않다는 게 확인됨

## 6. 발견 3 — 스키마 필드 혼동 버그

두 모델 모두에서 `recommendedAction`이 `"RETRY"`, `"NONE"` 같은 단일 키워드로 나오는 회귀가 관찰됐다. `escalation`(고정 enum) 필드를 `recommendedAction`(자유 문장) 바로 옆에 추가하면서 모델이 두 필드의 값 형식을 혼동한 것으로 보임.

**수정(커밋 `ffd863c`):**
- 스키마 필드 순서 변경 — `escalation`을 `confidence` 옆으로, `recommendedAction`과 멀리 배치
- 두 필드 설명에 상호 참조 + 예시 추가 (`recommendedAction`에는 "PASS/FAIL/RETRY/NONE 같은 단일 키워드 금지" 명시)
- 프롬프트에 두 필드를 구분하는 규칙과 JSON 예시 추가

**검증:** 동일 4개 케이스를 두 모델에 재실행 → `recommendedAction`이 두 모델 모두에서 완전한 문장으로 복구됨. `pytest` 11개 회귀 없음.

## 7. 코드 기반 보조 신호 설계 — margin vs spread

confidence 단독으로는 한계가 뚜렷해서(발견 1, 2), LLM 자기평가에 의존하지 않는 객관적 코드 신호를 추가로 검토했다. 실제 DB 47건에 두 후보를 검증했다.

### 7.1 신호 A — `score`와 `pass_threshold`의 거리(margin) — 채택

```
threshold 0.7, score 0.65 → margin 0.05 → 실제 RETRY 판정 (시스템이 이미 애매하다고 봄)
threshold 0.8, score 0.70 → margin 0.10 → FAIL
threshold 0.8, score 0.65 → margin 0.15 → FAIL
나머지 40+건 → margin 0.17 이상 (명백한 PASS/FAIL)
```

가장 margin이 작았던 실제 케이스가 시스템에서 이미 RETRY로 처리됐다는 사실이 신호의 타당성을 뒷받침. **`margin ≤ 0.15`로 채택**(47건 중 3건, 6.4%가 해당).

### 7.2 신호 B — 지표별 점수 편차(spread) — 기각

```
score 0.26, criteria [0, 0.2, 1] → spread 1.0  (FAIL, 전혀 애매하지 않음)
score 0.30, criteria [0, 0.5, 0, 1, 0] → spread 1.0  (FAIL, 전혀 애매하지 않음)
score 0.92, criteria [0.94, 0.9, 0.86, 0.93, 1] → spread 0.14  (PASS, 전혀 애매하지 않음)
```

spread가 큰 케이스는 전부 평균 점수 자체가 낮아 PASS/FAIL 판정은 명백했다. spread 단독 사용 시 오탐(false positive)이 클 것으로 판단해 **기각**.

## 8. 구현 (2차) 및 최종 검증

```python
BORDERLINE_SCORE_MARGIN = 0.15  # 잠정치, Epic E 캘리브레이션 대상

if decision["confidence"] < AMBIGUITY_CONFIDENCE_THRESHOLD:
    decision["escalation"] = "ESCALATE_MULTI_JUDGE"
if abs(score - pass_threshold) <= BORDERLINE_SCORE_MARGIN + 1e-9:
    decision["escalation"] = "ESCALATE_MULTI_JUDGE"
```

`+ 1e-9`는 부동소수점 오차 보정이다. `score=0.85, pass_threshold=0.7`처럼 수학적으로는
margin이 정확히 0.15인 경계값 케이스가, 파이썬에서는 `abs(0.85 - 0.7)`이
`0.15000000000000002`가 되어 `<= 0.15`를 통과하지 못하는 회귀가 실제로
있었다(`scripts/compare_supervisor_ambiguity_signals.py`로 재현 스크립트를
만들다가 발견, `tests/test_supervisor.py::test_force_escalation_handles_floating_point_boundary`로
고정).

4개 케이스(qwen3.5:4b)로 최종 검증:

| 케이스 | score/threshold (margin) | confidence | escalation |
|---|---|---|---|
| A. 확실한 PASS | 0.92/0.7 (0.22) | 0.95 | NONE (정상) |
| **B. 실제 과거 경계 케이스 재현** | **0.65/0.7 (0.05)** | 0.95 | **ESCALATE_MULTI_JUDGE** |
| C. 확실한 FAIL | 0.1/0.7 (0.6) | 0.95 | NONE (정상) |
| D. threshold 바로 위 경계 | 0.75/0.7 (0.05) | 0.85 | **ESCALATE_MULTI_JUDGE** |

`pytest` 11개 회귀 없음.

## 9. 개선 수치 요약

| 지표 | Before (confidence 단독) | After (confidence + margin) |
|---|---|---|
| 과거 47건 소급 적용 시 escalation 발생률 | 0/47 (0%) | 3/47 (6.4%) |
| 실제 과거 경계 케이스(score 0.65/threshold 0.7) 재현 시 escalation 여부 | 미발동 (confidence 0.95로 유지) | **발동** |
| 명백한 케이스(A, C)에서 오탐 | - | 0건 (0/2) |
| `recommendedAction` 필드 오염(단일 키워드 출력) | qwen·llama 모두 발생 | 두 모델 모두 해소 |

## 10. 남은 질문 — confidence 자체는 여전히 해결 안 됨

margin 신호는 confidence가 못 잡는 케이스를 **코드가 대신 잡아주는 백스톱**이지, LLM의 confidence 자기평가 능력 자체를 개선한 것은 아니다. qwen3.5:4b는 여전히 어떤 입력을 줘도 0.85 밑으로 잘 안 내려간다.

이건 로컬 소형 모델 일반의 알려진 한계(자기 확신도 캘리브레이션 약함, structured output + temperature=0.0 조합이 "그럴듯한 확신"을 기본값으로 뱉는 경향)에 가깝고, 프롬프트 지시만으로는 잘 고쳐지지 않는다는 걸 오늘 데이터로 확인했다. 다만 이는 `#37` 에픽이 애초에 우회하려던 문제이기도 하다 — "모델 하나의 자기평가를 믿지 말고 여러 모델의 실제 판정 불일치를 신호로 쓰자"는 게 에픽의 설계 원칙이므로, 컨센서스 파이프라인(`#40`~`#43`)이 완성되면 confidence 캘리브레이션 문제 자체의 중요도는 낮아질 가능성이 있다.

향후 검토 가능한 대안(오늘 범위 밖):
- 더 크거나 다른 모델로 confidence 캘리브레이션 재테스트
- 같은 모델에게 다른 샘플링으로 두 번 물어 답이 흔들리는지 보는 self-consistency 체크
- Ollama가 지원하면, verbalized confidence 대신 실제 토큰 확률(logprob) 기반 신호 사용

## 11. 테스트 도구와 실행 방법

`_force_escalation_if_ambiguous`(§8의 강제 로직)를 재사용 가능한 순수
함수로 분리해 `apps/agent-engine/tests/test_supervisor.py`에 정식
회귀 테스트로 고정했다. 이 리포의 기존 관례(`test_groundedness_agent.py`
등)를 따라, mock 없이 두 종류로 나눈다.

| 종류 | 대상 | Ollama 필요 여부 |
|---|---|---|
| 기본 테스트 | `_force_escalation_if_ambiguous` 순수 로직(§8 가설 1~4 + 부동소수점 회귀), 규칙 기반 즉시 반환 4곳, Ollama 연결 실패 시 폴백 | 불필요 (닫힌 포트로 연결 거부를 결정론적으로 재현) |
| 통합 테스트 (`@pytest.mark.integration`) | 실제 경계 케이스가 confidence와 무관하게 escalation되는지, 명백한 케이스에서 오탐이 없는지, `recommendedAction` 필드 오염 회귀(§6)가 재발하지 않는지 | 필요 (로컬 `ollama serve` + `qwen3.5:4b`) |

```bash
cd apps/agent-engine
source venv/bin/activate

# 기본 테스트만 (Ollama 불필요, 1초 이내)
pytest tests/test_supervisor.py -v

# 통합 테스트까지 포함 (로컬 Ollama + qwen3.5:4b 필요, 수십 초)
pytest tests/test_supervisor.py -m integration -v

# 전체 스위트 (agent-engine 모든 테스트, 기본은 통합 테스트 제외)
pytest tests/
```

§5의 모델별 confidence 캘리브레이션 비교(qwen3.5:4b vs llama3.2:3b)는
정식 회귀 테스트로 넣지 않았다 — 거기서 보는 값(모델이 실제로 내는
confidence 수치)은 모델·버전마다 달라지는 탐색적 관찰이지, 코드가
보장해야 할 고정된 계약이 아니기 때문이다. 대신 재현 가능한 스크립트로
남겨뒀다.

```bash
cd apps/agent-engine
source venv/bin/activate
python scripts/compare_supervisor_ambiguity_signals.py
# 다른 모델로 비교하고 싶으면:
python scripts/compare_supervisor_ambiguity_signals.py --models qwen3.5:4b gemma2:2b
```

## 12. 관련 커밋

- `cbbad96` feat: add multi-judge escalation signal to Supervisor #38
- `ffd863c` fix: separate Supervisor's escalation enum from recommendedAction free text #38
- (미커밋) margin 기반 코드 신호 추가 + 부동소수점 보정 + 회귀 테스트/재현 스크립트
