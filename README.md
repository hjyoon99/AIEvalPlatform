# AIEvalPlatform

AI 에이전트의 답변 품질을 시나리오와 평가 정책에 따라 검증하는 로컬 평가 플랫폼입니다.

- `dashboard`: React 기반 평가 관리 화면
- `backend`: NestJS 기반 프로젝트·시나리오·평가 실행 API
- `agent-engine`: FastAPI, LangGraph, Ollama 기반 다중 에이전트 평가 엔진
- `postgres`: 프로젝트, 정책, 시나리오 및 평가 결과 저장소

설계 배경, 실행 흐름, 모델 구성과 문제 해결 기록은 [기술 문서](./docs/README.md)에서 확인할 수 있습니다.

## 1. 사전 준비

아래 프로그램이 필요합니다.

- Node.js 20 이상
- pnpm 11.13 이상
- Python 3.11 이상
- Docker 및 Docker Compose
- [Ollama](https://ollama.com/)

설치 여부를 확인합니다.

```bash
node --version
pnpm --version
python3 --version
docker --version
ollama --version
```

pnpm이 설치되어 있지 않다면 Corepack으로 활성화할 수 있습니다.

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
```

## 2. 프로젝트 설치

저장소를 내려받고 의존성을 설치합니다.

```bash
git clone https://github.com/hjyoon99/AIEvalPlatform.git
cd AIEvalPlatform
pnpm install
```

Python 가상환경을 만들고 평가 엔진 의존성을 설치합니다.

macOS 또는 Linux:

```bash
cd apps/agent-engine
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ../..
```

Windows PowerShell:

```powershell
cd apps/agent-engine
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ../..
```

## 3. 환경변수 설정

### 백엔드

`apps/backend/.env` 파일을 생성합니다.

```env
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/eval_platform?schema=public
AGENT_ENGINE_URL=http://127.0.0.1:8000
DASHBOARD_URL=http://localhost:5173
```

### 평가 엔진

`apps/agent-engine/.env` 파일을 생성합니다.

```env
OLLAMA_HOST=http://localhost:11434
```

### 대시보드

로컬 기본 주소를 사용할 때는 별도 설정이 필요하지 않습니다. 백엔드 주소를 변경했다면 `apps/dashboard/.env` 파일을 생성합니다.

```env
VITE_API_URL=http://localhost:3000/api/v1
```

## 4. 데이터베이스 준비

프로젝트 루트에서 PostgreSQL 컨테이너를 실행합니다.

```bash
docker compose up -d postgres
docker compose ps
```

Prisma Client를 생성하고 마이그레이션을 적용합니다.

```bash
pnpm --filter backend exec prisma generate
pnpm --filter backend exec prisma migrate deploy
```

데이터베이스를 종료하려면 다음 명령을 사용합니다.

```bash
docker compose down
```

데이터까지 모두 삭제하는 `docker compose down -v` 명령은 기존 평가 결과도 제거하므로 주의해야 합니다.

## 5. Ollama 모델 준비

Ollama를 실행하고 프로젝트의 기본 모델을 내려받습니다.

```bash
ollama serve
```

새 터미널에서:

```bash
ollama pull qwen3.5:4b
ollama list
```

이미 Ollama 데스크톱 앱이 실행 중이라면 `ollama serve`를 별도로 실행하지 않아도 됩니다.

## 6. 서비스 실행

PostgreSQL과 Ollama가 실행된 상태에서 세 개의 터미널을 사용합니다.

### 터미널 1: 평가 엔진

macOS 또는 Linux:

```bash
cd apps/agent-engine
source .venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Windows PowerShell:

```powershell
cd apps/agent-engine
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 터미널 2: 백엔드

프로젝트 루트에서:

```bash
pnpm dev:backend
```

### 터미널 3: 대시보드

프로젝트 루트에서:

```bash
pnpm dev:dashboard
```

실행 후 브라우저에서 다음 주소를 엽니다.

```text
http://localhost:5173
```

## 7. 정상 실행 확인

각 서비스의 기본 주소는 다음과 같습니다.

| 서비스 | 주소 |
| --- | --- |
| 대시보드 | `http://localhost:5173` |
| 백엔드 API | `http://localhost:3000/api/v1` |
| 평가 엔진 상태 | `http://localhost:8000/health` |
| 평가 엔진 Swagger | `http://localhost:8000/docs` |
| PostgreSQL | `localhost:5433` |
| Ollama | `http://localhost:11434` |

터미널에서도 상태를 확인할 수 있습니다.

```bash
curl http://localhost:8000/health
curl http://localhost:3000/api/v1
curl http://localhost:11434/api/tags
```

## 8. 처음 평가하는 방법

대시보드에서 다음 순서로 진행합니다.

1. 프로젝트를 생성합니다.
2. 평가 정책에서 평가 항목, 가중치, 통과 기준과 최대 재시도 횟수를 설정합니다.
3. 시나리오 화면에서 AI 평가 시나리오를 생성합니다.
4. 생성된 프롬프트, 예상 출력과 평가 루브릭을 검토하고 필요한 내용을 수정합니다.
5. 사용할 시나리오를 승인합니다.
6. 평가 실행 화면에서 프로젝트, 정책, 승인된 시나리오와 모델을 선택합니다.
7. 평가를 실행하고 점수, 통과 여부, 검증 사유와 감독 결과를 확인합니다.

시나리오에 테스트 출력이 입력되어 있으면 해당 답변을 평가합니다. 테스트 출력이 비어 있으면 평가 엔진이 선택된 Ollama 모델로 답변을 먼저 생성한 뒤 평가합니다.

## 9. 빌드 및 검사

전체 프런트엔드와 백엔드를 빌드합니다.

```bash
pnpm build
```

서비스별로 검사하려면 다음 명령을 사용합니다.

```bash
pnpm --filter backend exec eslint src
pnpm --filter backend exec tsc -p tsconfig.json --noEmit
pnpm --filter dashboard build
```

Python 파일의 문법을 검사합니다.

```bash
cd apps/agent-engine
python3 -m compileall -q app
```

## 10. 자주 발생하는 문제

### `DATABASE_URL environment variable is not defined`

`apps/backend/.env` 파일이 있는지 확인하고 백엔드를 다시 실행합니다.

### PostgreSQL 연결 오류

컨테이너 상태와 포트를 확인합니다.

```bash
docker compose ps
docker compose logs postgres
```

`DATABASE_URL`의 포트는 컨테이너 내부 포트 `5432`가 아니라 로컬에 공개된 `5433`이어야 합니다.

### `Agent engine request failed` 또는 HTTP 502

평가 엔진이 `8000` 포트에서 실행 중인지 확인합니다.

```bash
curl http://localhost:8000/health
```

### Ollama 모델을 찾지 못하는 오류

모델 이름과 설치 상태를 확인합니다.

```bash
ollama list
ollama pull qwen3.5:4b
```

### Prisma 타입이 에디터에서 오류로 표시되는 경우

Prisma Client를 다시 생성한 뒤 에디터의 TypeScript 서버를 재시작합니다.

```bash
pnpm --filter backend exec prisma generate
```

### 포트가 이미 사용 중인 경우

`3000`, `5173`, `8000`, `5433`, `11434` 포트를 사용하는 프로세스가 있는지 확인하거나 각 서비스의 환경변수와 실행 포트를 변경합니다.
