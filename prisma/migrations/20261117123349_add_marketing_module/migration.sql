-- CreateEnum
CREATE TYPE "public"."MarketingContactRole" AS ENUM ('SENDER', 'RECEIVER', 'BILL_CLIENT', 'PARTY');

-- CreateEnum
CREATE TYPE "public"."MarketingSegmentType" AS ENUM ('ACTIVE', 'SLEEPING', 'LOST', 'ONE_TIME', 'VIP', 'ROUTE', 'BROKER', 'PARTY', 'SAVED', 'ALL');

-- CreateEnum
CREATE TYPE "public"."MarketingRecipientStatus" AS ENUM ('QUEUED', 'SENT', 'REPLIED', 'LEAD', 'NOT_INTERESTED', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "public"."MarketingLeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUOTED', 'BOOKED', 'LOST');

-- CreateEnum
CREATE TYPE "public"."MarketingLeadSource" AS ENUM ('CAMPAIGN', 'WEBSITE', 'REFERRAL', 'CALL');

-- CreateTable
CREATE TABLE "public"."MarketingContact" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roles" "public"."MarketingContactRole"[],
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "city" TEXT,
    "route" TEXT,
    "firstDate" TIMESTAMP(3) NOT NULL,
    "lastDate" TIMESTAMP(3) NOT NULL,
    "biltyCount" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "lastVehicle" TEXT,
    "linkedPartyId" TEXT,
    "isBroker" BOOLEAN NOT NULL DEFAULT false,
    "brokerReason" TEXT,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "optOutReason" TEXT,
    "optOutAt" TIMESTAMP(3),
    "optOutById" TEXT,
    "mergedIntoId" TEXT,
    "sourceless" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MarketingSettings" (
    "id" TEXT NOT NULL,
    "singleton" TEXT NOT NULL DEFAULT 'SINGLETON',
    "activeDays" INTEGER NOT NULL DEFAULT 30,
    "sleepingMinDays" INTEGER NOT NULL DEFAULT 60,
    "sleepingMaxDays" INTEGER NOT NULL DEFAULT 180,
    "lostDays" INTEGER NOT NULL DEFAULT 180,
    "vipPercentile" INTEGER NOT NULL DEFAULT 20,
    "defaultDailyLimit" INTEGER NOT NULL DEFAULT 50,
    "conversionWindowDays" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "MarketingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MarketingSavedSegment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filterJson" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingSavedSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MarketingCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateText" TEXT NOT NULL,
    "dailyLimit" INTEGER NOT NULL DEFAULT 50,
    "segmentType" "public"."MarketingSegmentType" NOT NULL,
    "segmentParams" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MarketingCampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "public"."MarketingRecipientStatus" NOT NULL DEFAULT 'QUEUED',
    "sentAt" TIMESTAMP(3),
    "statusUpdatedAt" TIMESTAMP(3),
    "leadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingCampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MarketingLead" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "stage" "public"."MarketingLeadStage" NOT NULL DEFAULT 'NEW',
    "source" "public"."MarketingLeadSource" NOT NULL,
    "campaignId" TEXT,
    "followUpDate" TIMESTAMP(3),
    "notes" TEXT,
    "convertedBiltyId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketingContact_phone_key" ON "public"."MarketingContact"("phone");

-- CreateIndex
CREATE INDEX "MarketingContact_isBroker_idx" ON "public"."MarketingContact"("isBroker");

-- CreateIndex
CREATE INDEX "MarketingContact_optedOut_idx" ON "public"."MarketingContact"("optedOut");

-- CreateIndex
CREATE INDEX "MarketingContact_lastDate_idx" ON "public"."MarketingContact"("lastDate");

-- CreateIndex
CREATE INDEX "MarketingContact_mergedIntoId_idx" ON "public"."MarketingContact"("mergedIntoId");

-- CreateIndex
CREATE INDEX "MarketingContact_linkedPartyId_idx" ON "public"."MarketingContact"("linkedPartyId");

-- CreateIndex
CREATE INDEX "MarketingContact_sourceless_idx" ON "public"."MarketingContact"("sourceless");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingSettings_singleton_key" ON "public"."MarketingSettings"("singleton");

-- CreateIndex
CREATE INDEX "MarketingCampaign_isActive_idx" ON "public"."MarketingCampaign"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaignRecipient_leadId_key" ON "public"."MarketingCampaignRecipient"("leadId");

-- CreateIndex
CREATE INDEX "MarketingCampaignRecipient_campaignId_status_idx" ON "public"."MarketingCampaignRecipient"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaignRecipient_campaignId_contactId_key" ON "public"."MarketingCampaignRecipient"("campaignId", "contactId");

-- CreateIndex
CREATE INDEX "MarketingLead_stage_idx" ON "public"."MarketingLead"("stage");

-- CreateIndex
CREATE INDEX "MarketingLead_followUpDate_idx" ON "public"."MarketingLead"("followUpDate");

-- CreateIndex
CREATE INDEX "MarketingLead_contactId_idx" ON "public"."MarketingLead"("contactId");

-- AddForeignKey
ALTER TABLE "public"."MarketingContact" ADD CONSTRAINT "MarketingContact_linkedPartyId_fkey" FOREIGN KEY ("linkedPartyId") REFERENCES "public"."Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarketingContact" ADD CONSTRAINT "MarketingContact_optOutById_fkey" FOREIGN KEY ("optOutById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarketingContact" ADD CONSTRAINT "MarketingContact_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "public"."MarketingContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarketingSettings" ADD CONSTRAINT "MarketingSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarketingSavedSegment" ADD CONSTRAINT "MarketingSavedSegment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarketingCampaignRecipient" ADD CONSTRAINT "MarketingCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "public"."MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarketingCampaignRecipient" ADD CONSTRAINT "MarketingCampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."MarketingContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarketingCampaignRecipient" ADD CONSTRAINT "MarketingCampaignRecipient_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "public"."MarketingLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarketingLead" ADD CONSTRAINT "MarketingLead_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."MarketingContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarketingLead" ADD CONSTRAINT "MarketingLead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "public"."MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarketingLead" ADD CONSTRAINT "MarketingLead_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
