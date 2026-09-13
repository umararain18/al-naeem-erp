-- AlterTable
ALTER TABLE "Bilty" DROP COLUMN IF EXISTS "agentAccountId",
ADD COLUMN     "agentPartyId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Bilty_agentPartyId_idx" ON "Bilty"("agentPartyId");

-- AddForeignKey
ALTER TABLE "Bilty" ADD CONSTRAINT "Bilty_agentPartyId_fkey"
  FOREIGN KEY ("agentPartyId") REFERENCES "Party"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "Bilty" DROP CONSTRAINT IF EXISTS "Bilty_agentAccountId_fkey";
