-- CreateEnum
CREATE TYPE "DecisionVerdict" AS ENUM ('ALLOW', 'BLOCK', 'REQUIRE_APPROVAL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'APPROVED', 'CAPTURED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- CreateEnum
CREATE TYPE "AttackRunStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'FAILED');

-- CreateTable
CREATE TABLE "mandates" (
    "id" TEXT NOT NULL,
    "totalBudgetMinorUnits" INTEGER NOT NULL,
    "perPurchaseCapMinorUnits" INTEGER NOT NULL,
    "approvalThresholdMinorUnits" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "allowedMerchants" TEXT[],
    "allowedCategories" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mandates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "orderId" TEXT,
    "verdict" "DecisionVerdict" NOT NULL,
    "reason" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "requestPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "paypalOrderId" TEXT,
    "amountMinorUnits" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "approvalLink" TEXT,
    "captureId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "orderId" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attack_runs" (
    "id" TEXT NOT NULL,
    "mandateId" TEXT,
    "name" TEXT NOT NULL,
    "status" "AttackRunStatus" NOT NULL DEFAULT 'PENDING',
    "totalScenarios" INTEGER NOT NULL DEFAULT 0,
    "passedScenarios" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "attack_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decisions_mandateId_createdAt_idx" ON "decisions"("mandateId", "createdAt");

-- CreateIndex
CREATE INDEX "decisions_orderId_idx" ON "decisions"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_paypalOrderId_key" ON "orders"("paypalOrderId");

-- CreateIndex
CREATE INDEX "orders_mandateId_createdAt_idx" ON "orders"("mandateId", "createdAt");

-- CreateIndex
CREATE INDEX "approvals_mandateId_status_idx" ON "approvals"("mandateId", "status");

-- CreateIndex
CREATE INDEX "approvals_orderId_idx" ON "approvals"("orderId");

-- CreateIndex
CREATE INDEX "attack_runs_mandateId_startedAt_idx" ON "attack_runs"("mandateId", "startedAt");

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "mandates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "mandates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "mandates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attack_runs" ADD CONSTRAINT "attack_runs_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "mandates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
