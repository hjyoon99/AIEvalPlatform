-- CreateTable
CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalResult" (
    "id" TEXT NOT NULL,
    "evalRunId" TEXT NOT NULL,
    "inputPrompt" TEXT NOT NULL,
    "outputAnswer" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalResult_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_evalRunId_fkey" FOREIGN KEY ("evalRunId") REFERENCES "EvalRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
