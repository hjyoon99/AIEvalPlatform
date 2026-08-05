# AIEvalPlatform 기술 문서

이 디렉터리는 설치 방법보다 한 단계 깊은 설계 배경과 구현 맥락을 설명한다. 처음 실행하는 방법은 루트의 [README](../README.md)를 먼저 참고한다.

## 문서 목록

1. [아키텍처와 기술 선택](./architecture.md)
   - 시스템 경계와 데이터 구조
   - 검토했던 배치 대안
   - LangGraph와 AutoGen 비교
   - 현재 구조를 선택한 이유와 한계
2. [실행 구조와 데이터 흐름](./runtime-flow.md)
   - 프로세스 및 포트
   - 프로젝트 생성부터 평가 결과 저장까지의 호출 순서
   - 평가 그래프의 상태와 분기
   - 실패 시 상태 변화
3. [모델과 에이전트 역할](./models.md)
   - 사용 모델과 런타임
   - 에이전트별 프롬프트, 온도, 구조화 출력
   - 점수 계산과 안전장치
4. [설계 변화와 구현 이야기](./design-evolution.md)
   - 빈 골격에서 현재 구조로 발전한 과정
   - 단순 평가에서 프로젝트·정책·시나리오 중심 구조로 바뀐 이유
   - 자동화와 사람 검토의 경계
5. [문제 해결과 트러블슈팅](./troubleshooting.md)
   - 실제 구현 및 검증 과정에서 드러난 문제
   - 원인 분석, 해결 방법, 재발 방지

6. [SDK 실행 프로토콜](./SDK-Execution-Protocol.md)
   - HTTP와 JSON을 포함하는 실행 계약
   - SDK 인증, Job claim, lease, 완료와 실패 처리
   - TypeScript SDK Worker 사용법
7. [평가 어댑터 MVP 설계](./Evaluation-Adapter-MVP-Design.md)
   - 기존 고객 AI를 수정하지 않는 별도 어댑터 구조
   - `invoke()` 기반 고객 payload와 표준 결과 매핑
   - 배포, 보안, 오류 처리와 MVP 완료 기준
8. [평가 실행 자동화 데이터 및 오케스트레이션 설계](./Evaluation-Run-Automation-Design.md)
   - `EvalRun`, `EvalRunCase`, `SdkJob`, `JudgeJob`, `EvalResult` 관계
   - ADAPTER/PROVIDED_OUTPUT 실행과 REFERENCE_BASED/RUBRIC_ONLY 평가
   - 상태 전이, 트랜잭션, 최종 상태 집계와 사용자 가치
9. [자동 평가 사용 방법](./Automated-Evaluation-Usage.md)
   - PostgreSQL, Ollama, Agent Engine, Backend와 Dashboard 실행
   - PROVIDED_OUTPUT 및 ADAPTER 자동 Run 생성
   - Mock Judge/Adapter 테스트와 상태별 문제 해결
10. [Docker Compose 통합 실행 및 고객사 배포](./Docker-Compose-Deployment-Plan.md)
   - Mock 평가 서비스를 한 번에 실행하는 방법
   - Mock/실제 고객사 프로필과 컨테이너 네트워크
   - Adapter, Ollama, 환경변수 및 통합 구현 완료 기준
11. [고객 AI Adapter 연동 가이드](./Customer-Adapter-Integration-Guide.md)
   - 대시보드에서 Application 등록 및 SDK Key 발급
   - 고객 프로젝트의 Adapter 디렉터리와 파일 구성
   - Chat/RAG/세션/도구 호출 API 매핑과 전체 평가 실행
12. [TGZ SDK 고객사 설치 및 연동 가이드](./Customer-SDK-TGZ-Setup-Guide.md)
   - 전달받은 `.tgz` 검증과 로컬 npm 설치
   - Adapter 환경변수, 고객 AI 매핑, 실행 및 문제 해결
13. [Python 고객사 Sidecar 설치 가이드](./Python-Customer-Sidecar-Setup-Guide.md)
   - Node.js SDK와 Python AI를 분리한 Sidecar 구성
   - 로컬, Docker Compose 및 Kubernetes 동일 Pod 배포
   - Secret, 네트워크, timeout, 확장 및 버전 업그레이드
14. [대시보드 리소스 추가·삭제 가이드](./Dashboard-Resource-Management.md)
   - 프로젝트, 평가 실행, 시나리오, 정책, 어댑터 관리
   - 삭제 영향 범위와 MVP의 권한·복구 제한

## 문서의 사실 범위

코드, Prisma 마이그레이션, Git 이력으로 확인되는 내용은 현재 구현 사실로 기술했다. 별도의 ADR(Architecture Decision Record)이 남아 있지 않은 초기 의사결정은 현재 코드에서 역추적한 설계 판단이다. 특히 LangGraph와 AutoGen 비교는 현재 요구사항을 기준으로 두 선택지를 재평가한 기록이며, 과거 회의 발언을 그대로 옮긴 문서는 아니다.

이 구분은 “그럴듯한 개발 서사”와 “재현 가능한 기술 기록”을 섞지 않기 위해 필요하다.
