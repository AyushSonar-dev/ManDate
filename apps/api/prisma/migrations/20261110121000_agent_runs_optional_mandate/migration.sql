-- DropForeignKey
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_mandateId_fkey";

-- AlterTable
ALTER TABLE "agent_runs" ALTER COLUMN "mandateId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "mandates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
