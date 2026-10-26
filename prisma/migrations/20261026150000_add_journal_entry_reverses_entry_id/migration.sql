-- Additive only: nullable self-referencing column + index + FK on
-- JournalEntry. No data rewrite, no column drops, no existing row
-- touched - every pre-existing row gets reversesEntryId = NULL.
--
-- Lets an Unsettle-reversal entry point at the EXACT JournalEntry it
-- reverses, so a later Unsettle can check "has this entry already
-- been reversed" with an exact, indexed lookup instead of re-scanning
-- every entry ever posted for the Challan (see
-- lib/challan-lifecycle.ts's reverseChallanSettlementEntries and
-- scripts/backfill-reversal-links.ts for historical rows).

-- AlterTable
ALTER TABLE "public"."JournalEntry" ADD COLUMN "reversesEntryId" TEXT;

-- CreateIndex
CREATE INDEX "JournalEntry_reversesEntryId_idx" ON "public"."JournalEntry"("reversesEntryId");

-- AddForeignKey
ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "public"."JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
