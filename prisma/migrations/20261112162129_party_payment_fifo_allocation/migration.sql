-- Auto FIFO allocation of lumpsum party payments/receipts.
-- Fully additive, no existing table/column/row dropped or rewritten.
--
--   1. JournalLine: +1 nullable column (allocationMode) - null/"AUTO"
--      (default) means lib/party-payment-fifo.ts's own
--      rerunFifoForParty() keeps rebuilding this payment's own
--      allocations automatically; "MANUAL" exempts it from every
--      future auto rebuild until the user picks "Back to Auto".
--   2. PaymentAllocation: +1 column (origin, NOT NULL) recording
--      which mechanism wrote each row - "FIFO" (the rebuild engine,
--      going forward), "MANUAL" (a user's own explicit pick),
--      "LEGACY" (every row that already existed before this column),
--      or "SETTLEMENT" (reserved, no current writer). Every
--      pre-existing row is backfilled to 'LEGACY' by the ADD COLUMN
--      DEFAULT itself (see below) - the column's own DEFAULT is then
--      switched to 'FIFO' for every row inserted from this point on,
--      so rerunFifoForParty() never needs to pass an explicit origin
--      for its own writes to land correctly, though it always does
--      anyway (defensive, never relies on the column default alone).

-- AlterTable
ALTER TABLE "public"."JournalLine" ADD COLUMN     "allocationMode" TEXT;

-- AlterTable
ALTER TABLE "public"."PaymentAllocation" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "public"."PaymentAllocation" ALTER COLUMN "origin" SET DEFAULT 'FIFO';
