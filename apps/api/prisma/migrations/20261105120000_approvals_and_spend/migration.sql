-- AlterTable
ALTER TABLE "mandates" ADD COLUMN "spentMinorUnits" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN "resolvedBy" TEXT;
