-- CreateIndex
CREATE INDEX "Challan_isDeleted_isSettled_idx" ON "public"."Challan"("isDeleted", "isSettled");
