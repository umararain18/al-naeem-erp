import type { Prisma, PrismaClient } from "@prisma/client";
import { getMarketingSettings } from "./settings";

type Tx = PrismaClient | Prisma.TransactionClient;

export type RecipientForConversion = {
  id: string;
  status: "QUEUED" | "SENT" | "REPLIED" | "LEAD" | "NOT_INTERESTED" | "OPTED_OUT";
  sentAt: Date | null;
  leadId: string | null;
  campaignId?: string;
};

/**
 * Pure: among a contact's own campaign-recipient rows, picks the most
 * recent `SENT` one whose `sentAt` is within `windowDays` of `now` - or
 * null if none qualifies. "Most recent" so a contact sent several
 * campaigns always converts against the freshest outreach.
 */
export function findConvertibleRecipient(recipients: RecipientForConversion[], now: Date, windowDays: number): RecipientForConversion | null {
  const eligible = recipients.filter((r) => r.status === "SENT" && r.sentAt !== null && daysBetween(r.sentAt, now) <= windowDays);
  if (eligible.length === 0) return null;
  return eligible.reduce((latest, r) => (r.sentAt! > latest.sentAt! ? r : latest));
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

export interface AutoConvertLeadForBiltyParams {
  contactIds: string[];
  biltyId: string;
  createdById: string | null;
  now?: Date;
}

/**
 * For each contact who may have just booked after being contacted: finds
 * its most recent eligible SENT recipient (within the configured
 * conversion window) and marks the resulting Lead BOOKED, linked to this
 * Bilty - creating a new Lead if that recipient had none yet, or
 * advancing its existing linked Lead if it did (never duplicating).
 * Contacts with no convertible recipient are silently skipped - this is
 * an opportunistic enrichment, never a requirement for the Bilty save.
 */
export async function autoConvertLeadForBilty(tx: Tx, params: AutoConvertLeadForBiltyParams): Promise<void> {
  if (params.contactIds.length === 0) return;
  const settings = await getMarketingSettings(tx);
  const now = params.now ?? new Date();

  for (const contactId of params.contactIds) {
    const recipients = await tx.marketingCampaignRecipient.findMany({
      where: { contactId, status: "SENT" },
      select: { id: true, status: true, sentAt: true, leadId: true, campaignId: true },
    });
    const winner = findConvertibleRecipient(recipients, now, settings.conversionWindowDays);
    if (!winner) continue;

    if (winner.leadId) {
      await tx.marketingLead.update({
        where: { id: winner.leadId },
        data: { stage: "BOOKED", convertedBiltyId: params.biltyId, convertedAt: now },
      });
    } else {
      const lead = await tx.marketingLead.create({
        data: {
          contactId,
          stage: "BOOKED",
          source: "CAMPAIGN",
          campaignId: winner.campaignId,
          convertedBiltyId: params.biltyId,
          convertedAt: now,
          createdById: params.createdById,
        },
      });
      await tx.marketingCampaignRecipient.update({
        where: { id: winner.id },
        data: { leadId: lead.id },
      });
    }
  }
}
