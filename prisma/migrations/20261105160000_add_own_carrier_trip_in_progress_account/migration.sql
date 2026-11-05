-- Adds Account.ownCarrierTripInProgressId - a 1:1 relation to
-- OwnCarrier's own dedicated "<carrier> — Trip in Progress" clearing
-- account (ASSET/OTHER_ASSET), alongside the existing Driver Cash
-- (ownCarrierId) and Carrier Profit (ownCarrierIncomeId) accounts.
-- Every trip expense/diesel/salary line debits this account instead
-- of Carrier Profit directly, so an open Trip's own expenses never
-- touch Carrier Profit (and therefore never show in P&L) until the
-- Trip actually CLOSES.

-- AlterTable
ALTER TABLE "public"."Account" ADD COLUMN     "ownCarrierTripInProgressId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Account_ownCarrierTripInProgressId_key" ON "public"."Account"("ownCarrierTripInProgressId");

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_ownCarrierTripInProgressId_fkey" FOREIGN KEY ("ownCarrierTripInProgressId") REFERENCES "public"."OwnCarrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
