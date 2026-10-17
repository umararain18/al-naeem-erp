Loaded Prisma config from prisma.config.ts.

-- CreateEnum
CREATE TYPE "public"."CarrierSlipStatus" AS ENUM ('IN_PROGRESS', 'TRIP_COMPLETED', 'RETURNED');

-- CreateEnum
CREATE TYPE "public"."CollectionCollectedBy" AS ENUM ('DRIVER', 'OFFICE');

-- CreateEnum
CREATE TYPE "public"."CollectionMethod" AS ENUM ('CASH', 'BANK_ONLINE');

-- CreateEnum
CREATE TYPE "public"."CarrierExpensePaymentType" AS ENUM ('NAQAD', 'KHATA', 'OFFICE_PAID');

-- AlterTable
ALTER TABLE "public"."Account" ADD COLUMN     "ownCarrierId" TEXT;

-- CreateTable
CREATE TABLE "public"."OwnCarrier" (
    "id" TEXT NOT NULL,
    "carrierNumber" TEXT NOT NULL,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnCarrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CarrierSlip" (
    "id" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "slipNo" TEXT NOT NULL,
    "departureDate" TIMESTAMP(3) NOT NULL,
    "returnDate" TIMESTAMP(3),
    "route" TEXT,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "status" "public"."CarrierSlipStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "linkedChallanId" TEXT,
    "linkedBiltyId" TEXT,
    "manualTotalBiltyRent" DECIMAL(15,2),
    "manualCarrierRent" DECIMAL(15,2),
    "notes" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarrierSlip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CarrierSlipCollection" (
    "id" TEXT NOT NULL,
    "slipId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "collectedBy" "public"."CollectionCollectedBy" NOT NULL,
    "method" "public"."CollectionMethod" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarrierSlipCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CarrierSlipExpense" (
    "id" TEXT NOT NULL,
    "slipId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "paymentType" "public"."CarrierExpensePaymentType" NOT NULL,
    "vendorPartyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarrierSlipExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnCarrier_carrierNumber_key" ON "public"."OwnCarrier"("carrierNumber");

-- CreateIndex
CREATE INDEX "OwnCarrier_isActive_idx" ON "public"."OwnCarrier"("isActive");

-- CreateIndex
CREATE INDEX "OwnCarrier_isDeleted_idx" ON "public"."OwnCarrier"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierSlip_linkedChallanId_key" ON "public"."CarrierSlip"("linkedChallanId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierSlip_linkedBiltyId_key" ON "public"."CarrierSlip"("linkedBiltyId");

-- CreateIndex
CREATE INDEX "CarrierSlip_carrierId_idx" ON "public"."CarrierSlip"("carrierId");

-- CreateIndex
CREATE INDEX "CarrierSlip_isDeleted_idx" ON "public"."CarrierSlip"("isDeleted");

-- CreateIndex
CREATE INDEX "CarrierSlip_departureDate_idx" ON "public"."CarrierSlip"("departureDate");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierSlip_carrierId_slipNo_key" ON "public"."CarrierSlip"("carrierId", "slipNo");

-- CreateIndex
CREATE INDEX "CarrierSlipCollection_slipId_idx" ON "public"."CarrierSlipCollection"("slipId");

-- CreateIndex
CREATE INDEX "CarrierSlipExpense_slipId_idx" ON "public"."CarrierSlipExpense"("slipId");

-- CreateIndex
CREATE INDEX "CarrierSlipExpense_accountId_idx" ON "public"."CarrierSlipExpense"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_ownCarrierId_key" ON "public"."Account"("ownCarrierId");

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_ownCarrierId_fkey" FOREIGN KEY ("ownCarrierId") REFERENCES "public"."OwnCarrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OwnCarrier" ADD CONSTRAINT "OwnCarrier_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OwnCarrier" ADD CONSTRAINT "OwnCarrier_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OwnCarrier" ADD CONSTRAINT "OwnCarrier_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSlip" ADD CONSTRAINT "CarrierSlip_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "public"."OwnCarrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSlip" ADD CONSTRAINT "CarrierSlip_linkedChallanId_fkey" FOREIGN KEY ("linkedChallanId") REFERENCES "public"."Challan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSlip" ADD CONSTRAINT "CarrierSlip_linkedBiltyId_fkey" FOREIGN KEY ("linkedBiltyId") REFERENCES "public"."Bilty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSlip" ADD CONSTRAINT "CarrierSlip_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSlip" ADD CONSTRAINT "CarrierSlip_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSlip" ADD CONSTRAINT "CarrierSlip_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSlipCollection" ADD CONSTRAINT "CarrierSlipCollection_slipId_fkey" FOREIGN KEY ("slipId") REFERENCES "public"."CarrierSlip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSlipExpense" ADD CONSTRAINT "CarrierSlipExpense_slipId_fkey" FOREIGN KEY ("slipId") REFERENCES "public"."CarrierSlip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSlipExpense" ADD CONSTRAINT "CarrierSlipExpense_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierSlipExpense" ADD CONSTRAINT "CarrierSlipExpense_vendorPartyId_fkey" FOREIGN KEY ("vendorPartyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

