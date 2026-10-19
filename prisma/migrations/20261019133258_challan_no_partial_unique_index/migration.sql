-- Replace the global unique constraint on "Challan"."challanNo" with a
-- PARTIAL unique index scoped to active (non-deleted) Challans only.
-- This lets a brand-new Challan reuse a Bin'd Challan's exact number -
-- Prisma's declarative schema cannot express a WHERE clause on a
-- unique constraint, so this is a hand-written, additive migration
-- (see prisma/schema.prisma's own comment on the Challan.challanNo
-- field).
DROP INDEX IF EXISTS "Challan_challanNo_key";

CREATE UNIQUE INDEX "Challan_challanNo_active_key" ON "Challan"("challanNo") WHERE "isDeleted" = false;
