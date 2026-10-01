-- CreateEnum
CREATE TYPE "public"."BillSourceType" AS ENUM ('PRIVATE_PHONCH', 'SHOWROOM_PHONCH');

-- CreateEnum
CREATE TYPE "public"."LogoPosition" AS ENUM ('LEFT', 'CENTER', 'RIGHT');

-- CreateEnum
CREATE TYPE "public"."HeaderAlignment" AS ENUM ('LEFT', 'CENTER', 'RIGHT');

-- CreateEnum
CREATE TYPE "public"."PdfPageSize" AS ENUM ('A4', 'A5');

-- CreateEnum
CREATE TYPE "public"."PdfOrientation" AS ENUM ('PORTRAIT', 'LANDSCAPE');

-- CreateEnum
CREATE TYPE "public"."SettingsDocumentType" AS ENUM ('BILTY', 'CHALLAN', 'BILL', 'PRIVATE_PHONCH', 'SHOWROOM_PHONCH', 'RECEIPT', 'PARTY_STATEMENT', 'REPORTS');

-- CreateEnum
CREATE TYPE "public"."AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'POST', 'PAYMENT', 'RECEIPT', 'SETTLEMENT', 'SETTLEMENT_PAYMENT', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT', 'EXPORT', 'SETTINGS_CHANGE', 'PERMISSION_CHANGE');

-- CreateTable
CREATE TABLE "public"."PrivatePhonch" (
    "id" TEXT NOT NULL,
    "phonchNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "transporterPartyId" TEXT NOT NULL,
    "billNo" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivatePhonch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PrivatePhonchVehicle" (
    "id" TEXT NOT NULL,
    "phonchId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "biltyNo" TEXT,
    "challanNo" TEXT,
    "chassisNumber" TEXT,
    "engineNumber" TEXT,
    "vehicleName" TEXT,
    "clearingAgentPartyId" TEXT,
    "totalRent" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "deliveryCharges" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "carrierPayable" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "deliveryRecoveryParty" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivatePhonchVehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Bill" (
    "id" TEXT NOT NULL,
    "billNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "clientPartyId" TEXT,
    "clientName" TEXT NOT NULL,
    "clientPhone" TEXT,
    "sourceType" "public"."BillSourceType",
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BillItem" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "vehicleName" TEXT,
    "fromText" TEXT,
    "toText" TEXT,
    "engineNumber" TEXT,
    "chassisNumber" TEXT,
    "regdNumber" TEXT,
    "rent" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "delivery" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "otherExpense" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BillSourceLink" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "billItemId" TEXT NOT NULL,
    "sourceType" "public"."BillSourceType" NOT NULL,
    "privatePhonchVehicleId" TEXT,
    "phonchVehicleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillSourceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BusinessSettings" (
    "id" TEXT NOT NULL,
    "singleton" TEXT NOT NULL DEFAULT 'SINGLETON',
    "businessName" TEXT NOT NULL DEFAULT '',
    "legalName" TEXT,
    "shortName" TEXT,
    "phone1" TEXT,
    "phone2" TEXT,
    "whatsapp" TEXT,
    "email" TEXT,
    "website" TEXT,
    "address" TEXT,
    "city" TEXT,
    "province" TEXT,
    "country" TEXT,
    "ntnNumber" TEXT,
    "registrationNumber" TEXT,
    "mainLogoUrl" TEXT,
    "smallLogoUrl" TEXT,
    "faviconUrl" TEXT,
    "signatureUrl" TEXT,
    "stampUrl" TEXT,
    "brandPrimaryColor" TEXT,
    "brandSecondaryColor" TEXT,
    "headerShowLogo" BOOLEAN NOT NULL DEFAULT true,
    "headerShowBusinessName" BOOLEAN NOT NULL DEFAULT true,
    "headerShowAddress" BOOLEAN NOT NULL DEFAULT true,
    "headerShowPhone" BOOLEAN NOT NULL DEFAULT true,
    "headerShowWhatsapp" BOOLEAN NOT NULL DEFAULT false,
    "headerShowEmail" BOOLEAN NOT NULL DEFAULT false,
    "headerShowWebsite" BOOLEAN NOT NULL DEFAULT false,
    "headerLogoPosition" "public"."LogoPosition" NOT NULL DEFAULT 'LEFT',
    "headerAlignment" "public"."HeaderAlignment" NOT NULL DEFAULT 'CENTER',
    "headerSubtitle" TEXT,
    "defaultUseHeader" BOOLEAN NOT NULL DEFAULT true,
    "defaultUseFooter" BOOLEAN NOT NULL DEFAULT true,
    "defaultUseLogo" BOOLEAN NOT NULL DEFAULT true,
    "footerText" TEXT,
    "footerShowPhone" BOOLEAN NOT NULL DEFAULT true,
    "footerShowAddress" BOOLEAN NOT NULL DEFAULT false,
    "footerShowWebsite" BOOLEAN NOT NULL DEFAULT false,
    "footerShowPageNumber" BOOLEAN NOT NULL DEFAULT true,
    "footerShowGeneratedDate" BOOLEAN NOT NULL DEFAULT true,
    "termsAndConditions" TEXT,
    "invoiceTitle" TEXT NOT NULL DEFAULT 'BILL',
    "invoiceNumberPrefix" TEXT,
    "currencyLabel" TEXT NOT NULL DEFAULT 'Rs.',
    "paymentInstructions" TEXT,
    "defaultTermsAndConditions" TEXT,
    "authorizedByLabel" TEXT NOT NULL DEFAULT 'Authorized Signature',
    "signatureLabel" TEXT NOT NULL DEFAULT 'Signature',
    "pdfPageSize" "public"."PdfPageSize" NOT NULL DEFAULT 'A4',
    "pdfOrientation" "public"."PdfOrientation" NOT NULL DEFAULT 'PORTRAIT',
    "pdfDefaultFont" TEXT,
    "pdfDefaultFontSize" INTEGER NOT NULL DEFAULT 10,
    "pdfTableBorderStyle" TEXT,
    "pdfShowWatermark" BOOLEAN NOT NULL DEFAULT false,
    "pdfWatermarkText" TEXT,
    "pdfShowPageNumber" BOOLEAN NOT NULL DEFAULT true,
    "pdfShowGeneratedDate" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "BusinessSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DocumentTypeSettings" (
    "id" TEXT NOT NULL,
    "businessSettingsId" TEXT NOT NULL,
    "documentType" "public"."SettingsDocumentType" NOT NULL,
    "useHeader" BOOLEAN,
    "useFooter" BOOLEAN,
    "useLogo" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTypeSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "userNameSnapshot" TEXT,
    "userRoleSnapshot" TEXT,
    "action" "public"."AuditAction" NOT NULL,
    "module" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "documentNo" TEXT,
    "description" TEXT NOT NULL,
    "oldValues" JSONB,
    "newValues" JSONB,
    "changedFields" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrivatePhonch_phonchNo_key" ON "public"."PrivatePhonch"("phonchNo");

-- CreateIndex
CREATE INDEX "PrivatePhonch_date_idx" ON "public"."PrivatePhonch"("date");

-- CreateIndex
CREATE INDEX "PrivatePhonch_isDeleted_deletedAt_idx" ON "public"."PrivatePhonch"("isDeleted", "deletedAt");

-- CreateIndex
CREATE INDEX "PrivatePhonch_transporterPartyId_idx" ON "public"."PrivatePhonch"("transporterPartyId");

-- CreateIndex
CREATE INDEX "PrivatePhonchVehicle_phonchId_idx" ON "public"."PrivatePhonchVehicle"("phonchId");

-- CreateIndex
CREATE INDEX "PrivatePhonchVehicle_clearingAgentPartyId_idx" ON "public"."PrivatePhonchVehicle"("clearingAgentPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_billNo_key" ON "public"."Bill"("billNo");

-- CreateIndex
CREATE INDEX "Bill_clientPartyId_idx" ON "public"."Bill"("clientPartyId");

-- CreateIndex
CREATE INDEX "Bill_isDeleted_deletedAt_idx" ON "public"."Bill"("isDeleted", "deletedAt");

-- CreateIndex
CREATE INDEX "Bill_date_idx" ON "public"."Bill"("date");

-- CreateIndex
CREATE INDEX "BillItem_billId_idx" ON "public"."BillItem"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "BillSourceLink_billItemId_key" ON "public"."BillSourceLink"("billItemId");

-- CreateIndex
CREATE INDEX "BillSourceLink_billId_idx" ON "public"."BillSourceLink"("billId");

-- CreateIndex
CREATE INDEX "BillSourceLink_privatePhonchVehicleId_idx" ON "public"."BillSourceLink"("privatePhonchVehicleId");

-- CreateIndex
CREATE INDEX "BillSourceLink_phonchVehicleId_idx" ON "public"."BillSourceLink"("phonchVehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessSettings_singleton_key" ON "public"."BusinessSettings"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTypeSettings_businessSettingsId_documentType_key" ON "public"."DocumentTypeSettings"("businessSettingsId", "documentType");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "public"."AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "public"."AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "public"."AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_module_idx" ON "public"."AuditLog"("module");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "public"."AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_documentNo_idx" ON "public"."AuditLog"("documentNo");

-- AddForeignKey
ALTER TABLE "public"."PrivatePhonch" ADD CONSTRAINT "PrivatePhonch_transporterPartyId_fkey" FOREIGN KEY ("transporterPartyId") REFERENCES "public"."Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrivatePhonch" ADD CONSTRAINT "PrivatePhonch_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrivatePhonch" ADD CONSTRAINT "PrivatePhonch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrivatePhonch" ADD CONSTRAINT "PrivatePhonch_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrivatePhonchVehicle" ADD CONSTRAINT "PrivatePhonchVehicle_phonchId_fkey" FOREIGN KEY ("phonchId") REFERENCES "public"."PrivatePhonch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrivatePhonchVehicle" ADD CONSTRAINT "PrivatePhonchVehicle_clearingAgentPartyId_fkey" FOREIGN KEY ("clearingAgentPartyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bill" ADD CONSTRAINT "Bill_clientPartyId_fkey" FOREIGN KEY ("clientPartyId") REFERENCES "public"."Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bill" ADD CONSTRAINT "Bill_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bill" ADD CONSTRAINT "Bill_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bill" ADD CONSTRAINT "Bill_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BillItem" ADD CONSTRAINT "BillItem_billId_fkey" FOREIGN KEY ("billId") REFERENCES "public"."Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BillSourceLink" ADD CONSTRAINT "BillSourceLink_billId_fkey" FOREIGN KEY ("billId") REFERENCES "public"."Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BillSourceLink" ADD CONSTRAINT "BillSourceLink_billItemId_fkey" FOREIGN KEY ("billItemId") REFERENCES "public"."BillItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BillSourceLink" ADD CONSTRAINT "BillSourceLink_privatePhonchVehicleId_fkey" FOREIGN KEY ("privatePhonchVehicleId") REFERENCES "public"."PrivatePhonchVehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BillSourceLink" ADD CONSTRAINT "BillSourceLink_phonchVehicleId_fkey" FOREIGN KEY ("phonchVehicleId") REFERENCES "public"."PhonchVehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BusinessSettings" ADD CONSTRAINT "BusinessSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DocumentTypeSettings" ADD CONSTRAINT "DocumentTypeSettings_businessSettingsId_fkey" FOREIGN KEY ("businessSettingsId") REFERENCES "public"."BusinessSettings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
