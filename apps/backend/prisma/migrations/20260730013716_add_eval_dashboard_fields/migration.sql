/*
  Warnings:

  - Added the required column `verdict` to the `EvalResult` table without a default value. This is not possible if the table is not empty.
  - Added the required column `agentName` to the `EvalRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `model` to the `EvalRun` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "EvalResult" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "expectedOutput" TEXT,
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "supervision" JSONB,
ADD COLUMN     "verdict" TEXT NOT NULL,
ADD COLUMN     "verification" JSONB;

-- AlterTable
ALTER TABLE "EvalRun" ADD COLUMN     "agentName" TEXT NOT NULL,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "maxRetries" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "model" TEXT NOT NULL,
ADD COLUMN     "passThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7;
