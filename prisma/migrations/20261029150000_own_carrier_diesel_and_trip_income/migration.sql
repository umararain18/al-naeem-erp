-- Own Carrier, part 2 - fully additive, no existing table/column/row
-- touched or rewritten. Adds:
--   1. CarrierTripLineType.EXPENSE_OFFICE - a Trip expense paid
--      directly from an office Cash/Bank account (Diesel's "Office
--      account" payment source, and any other expense that should
--      never touch Driver Cash).
--   2. Challan.ownCarrierId - marks a Challan as an Own Carrier
--      dispatch instead of an external Transporter Party (mutually
--      exclusive with transporterPartyId, enforced at the app layer).
--   3. Account.ownCarrierIncomeId - the per-carrier "<carrier> — Own
--      Carrier Income" account, 1:1 with OwnCarrier (a second,
--      independent relation from the existing Driver Cash one).
--   4. CarrierTripDocument.carrierRentAmount - the manually-entered
--      Carrier Rent for one linked (own-carrier) Challan on one Trip,
--      editable until that Trip closes.

-- AlterEnum
ALTER TYPE "public"."CarrierTripLineType" ADD VALUE 'EXPENSE_OFFICE';

-- AlterTable
ALTER TABLE "public"."Challan" ADD COLUMN     "ownCarrierId" TEXT;

-- AlterTable
ALTER TABLE "public"."Account" ADD COLUMN     "ownCarrierIncomeId" TEXT;

-- AlterTable
ALTER TABLE "public"."CarrierTripDocument" ADD COLUMN     "carrierRentAmount" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Challan_ownCarrierId_idx" ON "public"."Challan"("ownCarrierId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_ownCarrierIncomeId_key" ON "public"."Account"("ownCarrierIncomeId");

-- AddForeignKey
ALTER TABLE "public"."Challan" ADD CONSTRAINT "Challan_ownCarrierId_fkey" FOREIGN KEY ("ownCarrierId") REFERENCES "public"."OwnCarrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_ownCarrierIncomeId_fkey" FOREIGN KEY ("ownCarrierIncomeId") REFERENCES "public"."OwnCarrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
