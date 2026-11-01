-- Own Carrier, part 3 - fully additive, no existing table/column/row
-- touched or rewritten. Adds:
--   1. CarrierTripLine.isDiesel/liters/ratePerLiter/pumpPartyId - a
--      Diesel purchase is still EXPENSE_CASH/EXPENSE_OFFICE/
--      EXPENSE_CREDIT by payment source, same as before; isDiesel
--      just flags which row IS one, so the Diesel box/total/profit
--      report can filter by this column instead of a "Diesel - ..."
--      description-text prefix. pumpPartyId is informational only
--      (ON DELETE SET NULL) and independent of the existing
--      vendorPartyId (the real Udhaar payable party).
--   2. OwnCarrier.defaultPumpPartyId/defaultPaidFrom - pure UI
--      prefill defaults for a new Diesel entry, never required and
--      never assumed by any posting function itself.

-- AlterTable
ALTER TABLE "public"."CarrierTripLine" ADD COLUMN     "isDiesel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "liters" DECIMAL(10,2),
ADD COLUMN     "ratePerLiter" DECIMAL(10,2),
ADD COLUMN     "pumpPartyId" TEXT;

-- AlterTable
ALTER TABLE "public"."OwnCarrier" ADD COLUMN     "defaultPumpPartyId" TEXT,
ADD COLUMN     "defaultPaidFrom" TEXT;

-- CreateIndex
CREATE INDEX "CarrierTripLine_isDiesel_idx" ON "public"."CarrierTripLine"("isDiesel");

-- AddForeignKey
ALTER TABLE "public"."CarrierTripLine" ADD CONSTRAINT "CarrierTripLine_pumpPartyId_fkey" FOREIGN KEY ("pumpPartyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OwnCarrier" ADD CONSTRAINT "OwnCarrier_defaultPumpPartyId_fkey" FOREIGN KEY ("defaultPumpPartyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
