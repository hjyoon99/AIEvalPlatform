-- CreateTable
CREATE TABLE "AIApplication" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'development',
    "sdkKeyHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SdkJob" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "testCase" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "output" JSONB,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SdkJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AIApplication_sdkKeyHash_key" ON "AIApplication"("sdkKeyHash");

-- CreateIndex
CREATE INDEX "AIApplication_projectId_idx" ON "AIApplication"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "SdkJob_idempotencyKey_key" ON "SdkJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SdkJob_applicationId_status_createdAt_idx" ON "SdkJob"("applicationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SdkJob_leaseExpiresAt_idx" ON "SdkJob"("leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "AIApplication" ADD CONSTRAINT "AIApplication_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SdkJob" ADD CONSTRAINT "SdkJob_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "AIApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
