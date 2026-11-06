-- Own Carrier - driver salary accrual + Engine Oil Stock costing.
-- Fully additive, no existing table/column/row touched or rewritten.
--
--   1. OwnCarrier: +7 nullable settings columns - driverMonthlySalary
--      (+ its own informational driverMonthlySalaryEffectiveFrom),
--      avgKmPerLiter, tankCapacityLiters (reference figures only),
--      and the three Engine Oil issue thresholds (oilIssueThresholdKm/
--      oilIssueLitersAboveThreshold/oilIssueLitersAtOrBelowThreshold -
--      default to 400/14/7 in code when null).
--   2. Account: +1 nullable 1:1 FK (ownCarrierSalaryPayableId) - a new
--      per-carrier "<carrier> — Driver Salary Payable" account,
--      mirroring the existing Driver Cash/Carrier Profit/Trip in
--      Progress 1:1 accounts.
--   3. CarrierTrip: +1 nullable column (distanceKm) - drives the
--      Engine Oil issue suggestion at Trip CLOSE.
--   4. JournalLine: +2 nullable columns (liters, ratePerLiter) -
--      meaningful only on Engine Oil Stock lines (sourceType
--      "ENGINE_OIL") - current stock liters and the moving weighted-
--      average rate are derived straight from these across every live
--      line on that account, no separate inventory table needed.
--   5. New table CarrierSalaryMonthAllocation - one row per calendar
--      month a carrier's driver salary gets allocated to (a closed
--      Trip's own day-based share, or the month-end "Allocate idle
--      salary" top-up), each tied 1:1 to its own JournalEntry so
--      "already allocated days for month M" is always read live
--      (filtered to journalEntry.isDeleted = false), never re-derived
--      from Trip date ranges.

-- AlterTable
ALTER TABLE "public"."OwnCarrier" ADD COLUMN     "driverMonthlySalary" DECIMAL(15,2),
ADD COLUMN     "driverMonthlySalaryEffectiveFrom" TIMESTAMP(3),
ADD COLUMN     "avgKmPerLiter" DECIMAL(10,2),
ADD COLUMN     "tankCapacityLiters" DECIMAL(10,2),
ADD COLUMN     "oilIssueThresholdKm" DECIMAL(10,2),
ADD COLUMN     "oilIssueLitersAboveThreshold" DECIMAL(10,2),
ADD COLUMN     "oilIssueLitersAtOrBelowThreshold" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "public"."Account" ADD COLUMN     "ownCarrierSalaryPayableId" TEXT;

-- AlterTable
ALTER TABLE "public"."CarrierTrip" ADD COLUMN     "distanceKm" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "public"."JournalLine" ADD COLUMN     "liters" DECIMAL(10,2),
ADD COLUMN     "ratePerLiter" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "public"."CarrierSalaryMonthAllocation" (
    "id" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "tripId" TEXT,
    "allocatedDays" INTEGER NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarrierSalaryMonthAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_ownCarrierSalaryPayableId_key" ON "public"."Account"("ownCarrierSalaryPayableId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierSalaryMonthAllocation_journalEntryId_key" ON "public"."CarrierSalaryMonthAllocation"("journalEntryId");

-- CreateIndex
CREATE INDEX "CarrierSalaryMonthAllocation_carrierId_month_idx" ON "public"."CarrierSalaryMonthAllocation"("carrierId", "month");

-- CreateIndex
CREATE INDEX "CarrierSalaryMonthAllocation_tripId_idx" ON "public"."CarrierSalaryMonthAllocation"("tripId");

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_ownCarrierSalaryPayableId_fkey" FOREIGN KEY ("ownCarrierSalaryPayableId") REFERENCES "public"."OwnCarrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSalaryMonthAllocation" ADD CONSTRAINT "CarrierSalaryMonthAllocation_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "public"."OwnCarrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSalaryMonthAllocation" ADD CONSTRAINT "CarrierSalaryMonthAllocation_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "public"."CarrierTrip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSalaryMonthAllocation" ADD CONSTRAINT "CarrierSalaryMonthAllocation_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "public"."JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSalaryMonthAllocation" ADD CONSTRAINT "CarrierSalaryMonthAllocation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
