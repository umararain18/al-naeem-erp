-- Own Carrier accounts simplification - fully additive, no existing
-- table/column/row touched or rewritten. Adds:
--   1. CarrierExpenseCategory enum (DIESEL/TOLL/KHANA/MARAMMAT/SALARY/OTHER).
--   2. CarrierTripLine.category - nullable, set only on
--      EXPENSE_CASH/EXPENSE_OFFICE/EXPENSE_CREDIT/DRIVER_SALARY lines
--      (null for COLLECTION/CASH_FROM_OFFICE/DEPOSIT_TO_OFFICE).
--      Becomes the primary breakdown key for the Trip report/carrier
--      page going forward, replacing expenseAccountId (which stays in
--      the schema, unused by new code, since every expense/salary
--      line now debits the SAME "<carrier> — Carrier Profit" account
--      instead of a user-picked account).

-- CreateEnum
CREATE TYPE "public"."CarrierExpenseCategory" AS ENUM ('DIESEL', 'TOLL', 'KHANA', 'MARAMMAT', 'SALARY', 'OTHER');

-- AlterTable
ALTER TABLE "public"."CarrierTripLine" ADD COLUMN "category" "public"."CarrierExpenseCategory";

-- CreateIndex
CREATE INDEX "CarrierTripLine_category_idx" ON "public"."CarrierTripLine"("category");
