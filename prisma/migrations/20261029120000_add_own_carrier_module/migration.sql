-- Own Carrier module - fully additive, no existing table/column
-- touched, no data rewrite. The OwnCarrier/CarrierSlip* tables that
-- previously existed in this database (from the abandoned,
-- never-merged feature/own-carrier-register branch, PR #16) were
-- already dropped separately, outside this migration, before this
-- was written - they were never tracked here in the first place.

-- CreateEnum
CREATE TYPE "public"."CarrierTripStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "public"."CarrierTripLineType" AS ENUM ('COLLECTION', 'CASH_FROM_OFFICE', 'EXPENSE_CASH', 'EXPENSE_CREDIT', 'DRIVER_SALARY', 'DEPOSIT_TO_OFFICE');

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
    "currentDriverId" TEXT,
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
CREATE TABLE "public"."CarrierTrip" (
    "id" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "tripNo" TEXT NOT NULL,
    "route" TEXT,
    "dateFrom" TIMESTAMP(3) NOT NULL,
    "dateTo" TIMESTAMP(3),
    "notes" TEXT,
    "status" "public"."CarrierTripStatus" NOT NULL DEFAULT 'OPEN',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarrierTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CarrierTripDocument" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkedById" TEXT,
    "unlinkedAt" TIMESTAMP(3),
    "unlinkedById" TEXT,

    CONSTRAINT "CarrierTripDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CarrierTripLine" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "lineType" "public"."CarrierTripLineType" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "documentType" TEXT,
    "documentId" TEXT,
    "expenseAccountId" TEXT,
    "vendorPartyId" TEXT,
    "employeeId" TEXT,
    "officeAccountId" TEXT,
    "journalEntryId" TEXT NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarrierTripLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnCarrier_carrierNumber_key" ON "public"."OwnCarrier"("carrierNumber");

-- CreateIndex
CREATE INDEX "OwnCarrier_isActive_idx" ON "public"."OwnCarrier"("isActive");

-- CreateIndex
CREATE INDEX "OwnCarrier_isDeleted_idx" ON "public"."OwnCarrier"("isDeleted");

-- CreateIndex
CREATE INDEX "CarrierTrip_carrierId_idx" ON "public"."CarrierTrip"("carrierId");

-- CreateIndex
CREATE INDEX "CarrierTrip_isDeleted_idx" ON "public"."CarrierTrip"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierTrip_carrierId_tripNo_key" ON "public"."CarrierTrip"("carrierId", "tripNo");

-- CreateIndex
CREATE INDEX "CarrierTripDocument_tripId_idx" ON "public"."CarrierTripDocument"("tripId");

-- CreateIndex
CREATE INDEX "CarrierTripDocument_documentType_documentId_idx" ON "public"."CarrierTripDocument"("documentType", "documentId");

-- CreateIndex (PARTIAL unique - "one currently-ACTIVE Trip link per
-- document" - not expressible declaratively in schema.prisma, same
-- precedent as Challan.challanNo's own partial unique index. A
-- document with no active link at all (every past link row has
-- unlinkedAt set) is correctly excluded from this index entirely, so
-- it can be relinked to a later Trip without limit.)
CREATE UNIQUE INDEX "CarrierTripDocument_active_document_key" ON "public"."CarrierTripDocument"("documentType", "documentId") WHERE "unlinkedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "CarrierTripLine_journalEntryId_key" ON "public"."CarrierTripLine"("journalEntryId");

-- CreateIndex
CREATE INDEX "CarrierTripLine_tripId_idx" ON "public"."CarrierTripLine"("tripId");

-- CreateIndex
CREATE INDEX "CarrierTripLine_lineType_idx" ON "public"."CarrierTripLine"("lineType");

-- CreateIndex
CREATE INDEX "CarrierTripLine_documentType_documentId_idx" ON "public"."CarrierTripLine"("documentType", "documentId");

-- CreateIndex
CREATE INDEX "CarrierTripLine_isDeleted_idx" ON "public"."CarrierTripLine"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "Account_ownCarrierId_key" ON "public"."Account"("ownCarrierId");

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_ownCarrierId_fkey" FOREIGN KEY ("ownCarrierId") REFERENCES "public"."OwnCarrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OwnCarrier" ADD CONSTRAINT "OwnCarrier_currentDriverId_fkey" FOREIGN KEY ("currentDriverId") REFERENCES "public"."Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OwnCarrier" ADD CONSTRAINT "OwnCarrier_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OwnCarrier" ADD CONSTRAINT "OwnCarrier_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OwnCarrier" ADD CONSTRAINT "OwnCarrier_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTrip" ADD CONSTRAINT "CarrierTrip_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "public"."OwnCarrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTrip" ADD CONSTRAINT "CarrierTrip_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTrip" ADD CONSTRAINT "CarrierTrip_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTrip" ADD CONSTRAINT "CarrierTrip_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTripDocument" ADD CONSTRAINT "CarrierTripDocument_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "public"."CarrierTrip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTripDocument" ADD CONSTRAINT "CarrierTripDocument_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTripDocument" ADD CONSTRAINT "CarrierTripDocument_unlinkedById_fkey" FOREIGN KEY ("unlinkedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTripLine" ADD CONSTRAINT "CarrierTripLine_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "public"."CarrierTrip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTripLine" ADD CONSTRAINT "CarrierTripLine_expenseAccountId_fkey" FOREIGN KEY ("expenseAccountId") REFERENCES "public"."Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTripLine" ADD CONSTRAINT "CarrierTripLine_vendorPartyId_fkey" FOREIGN KEY ("vendorPartyId") REFERENCES "public"."Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTripLine" ADD CONSTRAINT "CarrierTripLine_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "public"."Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTripLine" ADD CONSTRAINT "CarrierTripLine_officeAccountId_fkey" FOREIGN KEY ("officeAccountId") REFERENCES "public"."Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTripLine" ADD CONSTRAINT "CarrierTripLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "public"."JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTripLine" ADD CONSTRAINT "CarrierTripLine_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CarrierTripLine" ADD CONSTRAINT "CarrierTripLine_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
