-- CreateIndex
CREATE INDEX "JournalEntry_referenceType_referenceId_idx" ON "public"."JournalEntry"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "JournalLine_sourceType_sourceId_idx" ON "public"."JournalLine"("sourceType", "sourceId");
