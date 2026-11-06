-- Own Carrier Trip - Owner/Office expense types. Fully additive, no
-- existing table/column/row touched or rewritten. Adds:
--   1. Two new CarrierTripLineType values - OWNER_DRAWING (the
--      Owner's own personal expense, Dr an OWNER_DRAWING-category
--      Account / Cr Driver Cash) and OFFICE_OVERHEAD (a genuine
--      office overhead expense, Dr a selected non-carrier EXPENSE
--      Account / Cr Driver Cash). Both reduce Driver Cash like any
--      other trip expense, but are deliberately excluded from Trip
--      in Progress/Carrier Profit/the Profit Report/Trip CLOSE's own
--      Entry B - see lib/carrier-trip.ts's
--      recognizeCarrierTripExpenseClearing.
--   2. No new column - both types reuse CarrierTripLine.
--      expenseAccountId (added by an earlier, never-actually-used
--      design; see that column's own updated schema comment) as the
--      selected Account to Dr.

-- AlterEnum
ALTER TYPE "public"."CarrierTripLineType" ADD VALUE 'OWNER_DRAWING';
ALTER TYPE "public"."CarrierTripLineType" ADD VALUE 'OFFICE_OVERHEAD';
