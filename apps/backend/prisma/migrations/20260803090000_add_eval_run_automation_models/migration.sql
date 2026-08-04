-- CreateEnum
CREATE TYPE "EvalRunExecutionMode" AS ENUM ('ADAPTER', 'PROVIDED_OUTPUT');

-- CreateEnum
CREATE TYPE "EvalRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EvalCaseEvaluationMode" AS ENUM ('REFERENCE_BASED', 'RUBRIC_ONLY');

-- CreateEnum
CREATE TYPE "EvalRunCaseStatus" AS ENUM ('WAITING_FOR_EXECUTION', 'EXECUTING', 'ANSWER_COMPLETED', 'WAITING_FOR_JUDGE', 'JUDGING', 'COMPLETED', 'REVIEW_REQUIRED', 'EXECUTION_FAILED', 'JUDGE_FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JudgeJobStatus" AS ENUM ('PENDING', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED');

-- EvalRun을 자동 평가 실행의 집계 단위로 확장한다.
ALTER TABLE "EvalRun"
ADD COLUMN "applicationId" TEXT,
ADD COLUMN "executionMode" "EvalRunExecutionMode" NOT NULL DEFAULT 'PROVIDED_OUTPUT',
ADD COLUMN "judgeModel" TEXT,
ADD COLUMN "judgeConfig" JSONB,
ADD COLUMN "totalCases" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "completedCases" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failedCases" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reviewCases" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "startedAt" TIMESTAMP(3);

-- 기존 model 값은 Judge 모델로 사용되어 왔으므로 재현 정보로 보존한다.
UPDATE "EvalRun"
SET "judgeModel" = "model"
WHERE "judgeModel" IS NULL;

-- 기존 상태 문자열을 새 상태 enum으로 안전하게 변환한다.
ALTER TABLE "EvalRun" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "EvalRun"
ALTER COLUMN "status" TYPE "EvalRunStatus"
USING (
  CASE
    WHEN "status" = 'PENDING' THEN 'QUEUED'
    WHEN "status" IN ('RUNNING', 'COMPLETED', 'FAILED') THEN "status"
    ELSE 'FAILED'
  END
)::"EvalRunStatus";

ALTER TABLE "EvalRun"
ALTER COLUMN "status" SET DEFAULT 'QUEUED';

UPDATE "EvalRun"
SET "startedAt" = "createdAt"
WHERE "status" <> 'QUEUED' AND "startedAt" IS NULL;

-- 기존 EvalResult가 있는 Run의 집계값을 초기화한다.
UPDATE "EvalRun" AS run
SET
  "totalCases" = counts."totalCases",
  "completedCases" = counts."completedCases",
  "reviewCases" = counts."reviewCases"
FROM (
  SELECT
    "evalRunId",
    COUNT(*)::INTEGER AS "totalCases",
    COUNT(*)::INTEGER AS "completedCases",
    COUNT(*) FILTER (WHERE "verdict" = 'RETRY')::INTEGER AS "reviewCases"
  FROM "EvalResult"
  GROUP BY "evalRunId"
) AS counts
WHERE run."id" = counts."evalRunId";

-- CreateTable
CREATE TABLE "EvalRunCase" (
    "id" TEXT NOT NULL,
    "evalRunId" TEXT NOT NULL,
    "caseIndex" INTEGER NOT NULL,
    "externalCaseId" TEXT,
    "evaluationMode" "EvalCaseEvaluationMode" NOT NULL,
    "status" "EvalRunCaseStatus" NOT NULL DEFAULT 'WAITING_FOR_EXECUTION',
    "input" JSONB NOT NULL,
    "expected" JSONB,
    "rubricSnapshot" JSONB,
    "outputAnswer" TEXT,
    "executionMetadata" JSONB,
    "executionError" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "executionStartedAt" TIMESTAMP(3),
    "answerCompletedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EvalRunCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JudgeJob" (
    "id" TEXT NOT NULL,
    "evalRunCaseId" TEXT NOT NULL,
    "status" "JudgeJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgeJob_pkey" PRIMARY KEY ("id")
);

-- 기존 실행 모델에 Case 관계와 Judge 재현 정보를 추가한다.
ALTER TABLE "SdkJob"
ADD COLUMN "evalRunCaseId" TEXT;

ALTER TABLE "EvalResult"
ADD COLUMN "evalRunCaseId" TEXT,
ADD COLUMN "judgeModel" TEXT,
ADD COLUMN "judgePromptVersion" TEXT,
ADD COLUMN "judgeAttempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "schemaValid" BOOLEAN NOT NULL DEFAULT true;

-- 기존 EvalResult의 Judge 모델은 부모 EvalRun에서 역으로 채운다.
UPDATE "EvalResult" AS result
SET "judgeModel" = run."model"
FROM "EvalRun" AS run
WHERE result."evalRunId" = run."id"
  AND result."judgeModel" IS NULL;

-- CreateIndex
CREATE INDEX "EvalRun_applicationId_status_idx" ON "EvalRun"("applicationId", "status");

-- CreateIndex
CREATE INDEX "EvalRun_projectId_createdAt_idx" ON "EvalRun"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvalRunCase_evalRunId_caseIndex_key" ON "EvalRunCase"("evalRunId", "caseIndex");

-- CreateIndex
CREATE INDEX "EvalRunCase_evalRunId_status_idx" ON "EvalRunCase"("evalRunId", "status");

-- CreateIndex
CREATE INDEX "EvalRunCase_status_updatedAt_idx" ON "EvalRunCase"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SdkJob_evalRunCaseId_key" ON "SdkJob"("evalRunCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "EvalResult_evalRunCaseId_key" ON "EvalResult"("evalRunCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "JudgeJob_evalRunCaseId_key" ON "JudgeJob"("evalRunCaseId");

-- CreateIndex
CREATE INDEX "JudgeJob_status_availableAt_idx" ON "JudgeJob"("status", "availableAt");

-- CreateIndex
CREATE INDEX "JudgeJob_leaseExpiresAt_idx" ON "JudgeJob"("leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "AIApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRunCase" ADD CONSTRAINT "EvalRunCase_evalRunId_fkey" FOREIGN KEY ("evalRunId") REFERENCES "EvalRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SdkJob" ADD CONSTRAINT "SdkJob_evalRunCaseId_fkey" FOREIGN KEY ("evalRunCaseId") REFERENCES "EvalRunCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JudgeJob" ADD CONSTRAINT "JudgeJob_evalRunCaseId_fkey" FOREIGN KEY ("evalRunCaseId") REFERENCES "EvalRunCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_evalRunCaseId_fkey" FOREIGN KEY ("evalRunCaseId") REFERENCES "EvalRunCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
