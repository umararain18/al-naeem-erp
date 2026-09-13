-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('SUPER_ADMIN', 'MANAGER', 'VIEWER');

-- CreateEnum
CREATE TYPE "public"."PartyType" AS ENUM ('CUSTOMER', 'VENDOR', 'BOTH', 'TRANSPORTER', 'CLEARING_AGENT');

-- CreateEnum
CREATE TYPE "public"."BalanceType" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "public"."AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE', 'PARTY');

-- CreateEnum
CREATE TYPE "public"."AccountCategory" AS ENUM ('CASH', 'BANK', 'RECEIVABLE', 'PAYABLE', 'OTHER_ASSET', 'TRANSPORTER_PAYABLE', 'DELIVERY_POINT_PAYABLE', 'VENDOR_PAYABLE', 'EMPLOYEE_PAYABLE', 'OTHER_LIABILITY', 'OWNER_CAPITAL', 'OWNER_DRAWING', 'OTHER_EQUITY', 'BOOKING_INCOME', 'DELIVERY_INCOME', 'CARRIER_INCOME', 'OTHER_INCOME', 'CARRIER_RENT', 'FUEL', 'OFFICE_RENT', 'SALARY', 'ELECTRICITY', 'TEA_REFRESHMENT', 'REPAIR_MAINTENANCE', 'OTHER_EXPENSE', 'PARTY');

-- CreateEnum
CREATE TYPE "public"."BiltyStatus" AS ENUM ('PENDING', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ChallanStatus" AS ENUM ('IN_TRANSIT', 'DELIVERED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "public"."Role" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLogin" TIMESTAMP(3),
    "phone" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Party" (
    "id" TEXT NOT NULL,
    "partyName" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "cnicNtn" TEXT,
    "address" TEXT,
    "openingBalance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "openingBalanceType" "public"."BalanceType",
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "partyTypes" "public"."PartyType"[],

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Employee" (
    "id" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT,
    "phone" TEXT,
    "joiningDate" TIMESTAMP(3),
    "monthlySalary" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Payslip" (
    "id" TEXT NOT NULL,
    "payslipNo" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "payrollMonth" TEXT NOT NULL,
    "payDate" TIMESTAMP(3) NOT NULL,
    "grossPay" DECIMAL(15,2) NOT NULL,
    "deduction" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(15,2) NOT NULL,
    "contribution" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Account" (
    "id" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountCode" TEXT,
    "accountType" "public"."AccountType" NOT NULL,
    "category" "public"."AccountCategory" NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "parentId" TEXT,
    "partyId" TEXT,
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Bilty" (
    "id" TEXT NOT NULL,
    "biltyNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "consignorPartyId" TEXT,
    "consignorName" TEXT NOT NULL,
    "consignorPhone" TEXT,
    "consigneePartyId" TEXT,
    "consigneeName" TEXT NOT NULL,
    "consigneePhone" TEXT,
    "vehicleType" TEXT,
    "vehicleModel" TEXT,
    "vehicleColor" TEXT,
    "engineNumber" TEXT,
    "chassisNumber" TEXT,
    "registrationNumber" TEXT,
    "clearingAgentPartyId" TEXT,
    "clearingAgentName" TEXT,
    "rent" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "insurance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "expense" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "advance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "toPay" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "paidResponsiblePartyId" TEXT,
    "agentPartyId" TEXT,
    "agentCommission" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "agentDescription" TEXT,
    "notes" TEXT,
    "status" "public"."BiltyStatus" NOT NULL DEFAULT 'PENDING',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bilty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JournalEntry" (
    "id" TEXT NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JournalLine" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "description" TEXT,
    "debit" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceId" TEXT,
    "sourceNumber" TEXT,
    "sourceType" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PaymentAllocation" (
    "id" TEXT NOT NULL,
    "journalLineId" TEXT NOT NULL,
    "targetSourceType" TEXT NOT NULL,
    "targetSourceId" TEXT NOT NULL,
    "allocatedAmount" DECIMAL(15,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SettlementPayment" (
    "id" TEXT NOT NULL,
    "challanId" TEXT,
    "biltyId" TEXT,
    "component" TEXT NOT NULL,
    "payerAccountId" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Challan" (
    "id" TEXT NOT NULL,
    "challanNo" TEXT NOT NULL,
    "loadingDate" TIMESTAMP(3) NOT NULL,
    "status" "public"."ChallanStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "transporterPartyId" TEXT,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "carrierNumber" TEXT,
    "carrierRent" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "remarks" TEXT,
    "isSettled" BOOLEAN NOT NULL DEFAULT false,
    "settledAt" TIMESTAMP(3),
    "settledById" TEXT,
    "settlementNotes" TEXT,
    "settlementJournalEntryId" TEXT,
    "clearingAgentPaysDriver" BOOLEAN NOT NULL DEFAULT false,
    "commissionRecoveryFrom" TEXT,
    "outstandingReceivable" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "outstandingPayable" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "isFinanciallyCleared" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Challan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ChallanBilty" (
    "id" TEXT NOT NULL,
    "challanId" TEXT NOT NULL,
    "biltyId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChallanBilty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Phonch" (
    "id" TEXT NOT NULL,
    "phonchNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "transporterPartyId" TEXT NOT NULL,
    "carrierNumber" TEXT,
    "description" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Phonch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PhonchVehicle" (
    "id" TEXT NOT NULL,
    "phonchId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "biltyNo" TEXT,
    "challanNo" TEXT,
    "chassisNumber" TEXT,
    "engineNumber" TEXT,
    "vehicleName" TEXT,
    "partyId" TEXT,
    "deliveryCharges" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "otherExpenseAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "otherExpenseReason" TEXT,
    "claimAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "claimReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhonchVehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "public"."User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeCode_key" ON "public"."Employee"("employeeCode");

-- CreateIndex
CREATE INDEX "Employee_isActive_idx" ON "public"."Employee"("isActive");

-- CreateIndex
CREATE INDEX "Employee_isDeleted_idx" ON "public"."Employee"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_payslipNo_key" ON "public"."Payslip"("payslipNo");

-- CreateIndex
CREATE INDEX "Payslip_payrollMonth_idx" ON "public"."Payslip"("payrollMonth");

-- CreateIndex
CREATE INDEX "Payslip_employeeId_idx" ON "public"."Payslip"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_employeeId_payrollMonth_key" ON "public"."Payslip"("employeeId", "payrollMonth");

-- CreateIndex
CREATE UNIQUE INDEX "Account_accountCode_key" ON "public"."Account"("accountCode");

-- CreateIndex
CREATE UNIQUE INDEX "Account_partyId_key" ON "public"."Account"("partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_employeeId_key" ON "public"."Account"("employeeId");

-- CreateIndex
CREATE INDEX "Account_accountType_idx" ON "public"."Account"("accountType");

-- CreateIndex
CREATE INDEX "Account_category_idx" ON "public"."Account"("category");

-- CreateIndex
CREATE INDEX "Account_parentId_idx" ON "public"."Account"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Location_name_key" ON "public"."Location"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Bilty_biltyNo_key" ON "public"."Bilty"("biltyNo");

-- CreateIndex
CREATE INDEX "Bilty_date_idx" ON "public"."Bilty"("date");

-- CreateIndex
CREATE INDEX "Bilty_status_idx" ON "public"."Bilty"("status");

-- CreateIndex
CREATE INDEX "Bilty_isDeleted_deletedAt_idx" ON "public"."Bilty"("isDeleted", "deletedAt");

-- CreateIndex
CREATE INDEX "Bilty_fromLocationId_idx" ON "public"."Bilty"("fromLocationId");

-- CreateIndex
CREATE INDEX "Bilty_toLocationId_idx" ON "public"."Bilty"("toLocationId");

-- CreateIndex
CREATE INDEX "JournalEntry_entryDate_idx" ON "public"."JournalEntry"("entryDate");

-- CreateIndex
CREATE INDEX "JournalEntry_referenceType_idx" ON "public"."JournalEntry"("referenceType");

-- CreateIndex
CREATE INDEX "JournalEntry_referenceId_idx" ON "public"."JournalEntry"("referenceId");

-- CreateIndex
CREATE INDEX "JournalEntry_createdById_idx" ON "public"."JournalEntry"("createdById");

-- CreateIndex
CREATE INDEX "JournalEntry_isDeleted_idx" ON "public"."JournalEntry"("isDeleted");

-- CreateIndex
CREATE INDEX "JournalEntry_deletedById_idx" ON "public"."JournalEntry"("deletedById");

-- CreateIndex
CREATE INDEX "JournalLine_journalEntryId_idx" ON "public"."JournalLine"("journalEntryId");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "public"."JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalLine_sourceType_idx" ON "public"."JournalLine"("sourceType");

-- CreateIndex
CREATE INDEX "JournalLine_sourceId_idx" ON "public"."JournalLine"("sourceId");

-- CreateIndex
CREATE INDEX "JournalLine_sourceNumber_idx" ON "public"."JournalLine"("sourceNumber");

-- CreateIndex
CREATE INDEX "PaymentAllocation_journalLineId_idx" ON "public"."PaymentAllocation"("journalLineId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_targetSourceType_targetSourceId_idx" ON "public"."PaymentAllocation"("targetSourceType", "targetSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementPayment_journalEntryId_key" ON "public"."SettlementPayment"("journalEntryId");

-- CreateIndex
CREATE INDEX "SettlementPayment_challanId_component_idx" ON "public"."SettlementPayment"("challanId", "component");

-- CreateIndex
CREATE INDEX "SettlementPayment_biltyId_component_idx" ON "public"."SettlementPayment"("biltyId", "component");

-- CreateIndex
CREATE INDEX "SettlementPayment_payerAccountId_idx" ON "public"."SettlementPayment"("payerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Challan_challanNo_key" ON "public"."Challan"("challanNo");

-- CreateIndex
CREATE INDEX "Challan_loadingDate_idx" ON "public"."Challan"("loadingDate");

-- CreateIndex
CREATE INDEX "Challan_status_idx" ON "public"."Challan"("status");

-- CreateIndex
CREATE INDEX "Challan_isDeleted_deletedAt_idx" ON "public"."Challan"("isDeleted", "deletedAt");

-- CreateIndex
CREATE INDEX "Challan_challanNo_idx" ON "public"."Challan"("challanNo");

-- CreateIndex
CREATE INDEX "ChallanBilty_biltyId_idx" ON "public"."ChallanBilty"("biltyId");

-- CreateIndex
CREATE UNIQUE INDEX "ChallanBilty_challanId_biltyId_key" ON "public"."ChallanBilty"("challanId", "biltyId");

-- CreateIndex
CREATE UNIQUE INDEX "Phonch_phonchNo_key" ON "public"."Phonch"("phonchNo");

-- CreateIndex
CREATE INDEX "Phonch_date_idx" ON "public"."Phonch"("date");

-- CreateIndex
CREATE INDEX "Phonch_isDeleted_deletedAt_idx" ON "public"."Phonch"("isDeleted", "deletedAt");

-- CreateIndex
CREATE INDEX "Phonch_transporterPartyId_idx" ON "public"."Phonch"("transporterPartyId");

-- CreateIndex
CREATE INDEX "PhonchVehicle_phonchId_idx" ON "public"."PhonchVehicle"("phonchId");

-- AddForeignKey
ALTER TABLE "public"."Employee" ADD CONSTRAINT "Employee_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Employee" ADD CONSTRAINT "Employee_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payslip" ADD CONSTRAINT "Payslip_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "public"."Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payslip" ADD CONSTRAINT "Payslip_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payslip" ADD CONSTRAINT "Payslip_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "public"."Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bilty" ADD CONSTRAINT "Bilty_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "public"."Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bilty" ADD CONSTRAINT "Bilty_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "public"."Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bilty" ADD CONSTRAINT "Bilty_consignorPartyId_fkey" FOREIGN KEY ("consignorPartyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bilty" ADD CONSTRAINT "Bilty_consigneePartyId_fkey" FOREIGN KEY ("consigneePartyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bilty" ADD CONSTRAINT "Bilty_clearingAgentPartyId_fkey" FOREIGN KEY ("clearingAgentPartyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bilty" ADD CONSTRAINT "Bilty_paidResponsiblePartyId_fkey" FOREIGN KEY ("paidResponsiblePartyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bilty" ADD CONSTRAINT "Bilty_agentPartyId_fkey" FOREIGN KEY ("agentPartyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bilty" ADD CONSTRAINT "Bilty_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bilty" ADD CONSTRAINT "Bilty_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bilty" ADD CONSTRAINT "Bilty_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalLine" ADD CONSTRAINT "JournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "public"."JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_journalLineId_fkey" FOREIGN KEY ("journalLineId") REFERENCES "public"."JournalLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementPayment" ADD CONSTRAINT "SettlementPayment_challanId_fkey" FOREIGN KEY ("challanId") REFERENCES "public"."Challan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementPayment" ADD CONSTRAINT "SettlementPayment_biltyId_fkey" FOREIGN KEY ("biltyId") REFERENCES "public"."Bilty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementPayment" ADD CONSTRAINT "SettlementPayment_payerAccountId_fkey" FOREIGN KEY ("payerAccountId") REFERENCES "public"."Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementPayment" ADD CONSTRAINT "SettlementPayment_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "public"."JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SettlementPayment" ADD CONSTRAINT "SettlementPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Challan" ADD CONSTRAINT "Challan_transporterPartyId_fkey" FOREIGN KEY ("transporterPartyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Challan" ADD CONSTRAINT "Challan_settledById_fkey" FOREIGN KEY ("settledById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Challan" ADD CONSTRAINT "Challan_settlementJournalEntryId_fkey" FOREIGN KEY ("settlementJournalEntryId") REFERENCES "public"."JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Challan" ADD CONSTRAINT "Challan_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Challan" ADD CONSTRAINT "Challan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Challan" ADD CONSTRAINT "Challan_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChallanBilty" ADD CONSTRAINT "ChallanBilty_challanId_fkey" FOREIGN KEY ("challanId") REFERENCES "public"."Challan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChallanBilty" ADD CONSTRAINT "ChallanBilty_biltyId_fkey" FOREIGN KEY ("biltyId") REFERENCES "public"."Bilty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Phonch" ADD CONSTRAINT "Phonch_transporterPartyId_fkey" FOREIGN KEY ("transporterPartyId") REFERENCES "public"."Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Phonch" ADD CONSTRAINT "Phonch_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Phonch" ADD CONSTRAINT "Phonch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Phonch" ADD CONSTRAINT "Phonch_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PhonchVehicle" ADD CONSTRAINT "PhonchVehicle_phonchId_fkey" FOREIGN KEY ("phonchId") REFERENCES "public"."Phonch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PhonchVehicle" ADD CONSTRAINT "PhonchVehicle_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
