-- Additive only - new nullable columns + a non-null boolean with a
-- DEFAULT true (so every existing row is unaffected), one FK, two
-- indexes. No column drops, no data rewrite, no table/enum changes.
-- Safe for `prisma migrate deploy` on production.

-- AlterTable
ALTER TABLE "public"."SettlementPayment"
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "deactivatedAt" TIMESTAMP(3),
  ADD COLUMN "deactivatedById" TEXT,
  ADD COLUMN "deactivationReason" TEXT;

-- CreateIndex
CREATE INDEX "SettlementPayment_challanId_component_isActive_idx" ON "public"."SettlementPayment"("challanId", "component", "isActive");

-- CreateIndex
CREATE INDEX "SettlementPayment_biltyId_component_isActive_idx" ON "public"."SettlementPayment"("biltyId", "component", "isActive");

-- AddForeignKey
ALTER TABLE "public"."SettlementPayment" ADD CONSTRAINT "SettlementPayment_deactivatedById_fkey" FOREIGN KEY ("deactivatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
