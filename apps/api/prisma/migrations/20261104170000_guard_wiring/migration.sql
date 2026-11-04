-- AlterTable
ALTER TABLE "orders" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "orders" ADD COLUMN "merchant" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "orders" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "orders" ADD COLUMN "items" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "orders" ADD COLUMN "feeMinorUnits" INTEGER NOT NULL DEFAULT 0;

-- Backfill
UPDATE "orders" SET "idempotencyKey" = 'legacy-' || "id";

ALTER TABLE "orders" ALTER COLUMN "idempotencyKey" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "merchant" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "items" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotencyKey_key" ON "orders"("idempotencyKey");
