import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

const statusSchema = z.object({
  status: z.enum(["REPLIED", "LEAD", "NOT_INTERESTED", "OPTED_OUT"]),
});

// POST /api/marketing/campaigns/[id]/recipients/[recipientId]/status -
// the 4 quick-status buttons on a SENT recipient. "LEAD" creates a
// MarketingLead (source: CAMPAIGN, stage: NEW) and links it. "OPTED_OUT"
// also sets the Contact's own global optedOut flag (permanent, every
// campaign) - "NOT_INTERESTED" is scoped to just this one campaign.
export async function POST(request: Request, { params }: { params: Promise<{ id: string; recipientId: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.manage")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, recipientId } = await params;
    const body = await request.json();
    const result = statusSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json({ success: false, message: "Invalid status" }, { status: 400 });
    }

    const recipient = await prisma.marketingCampaignRecipient.findFirst({ where: { id: recipientId, campaignId: id } });
    if (!recipient) return NextResponse.json({ success: false, message: "Recipient not found" }, { status: 404 });
    if (recipient.status === "QUEUED") {
      return NextResponse.json({ success: false, message: "Mark this recipient as Sent first" }, { status: 400 });
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      if (result.data.status === "LEAD" && !recipient.leadId) {
        const lead = await tx.marketingLead.create({
          data: { contactId: recipient.contactId, stage: "NEW", source: "CAMPAIGN", campaignId: id, createdById: currentUser.userId },
        });
        return tx.marketingCampaignRecipient.update({
          where: { id: recipientId },
          data: { status: "LEAD", leadId: lead.id, statusUpdatedAt: now },
        });
      }
      if (result.data.status === "OPTED_OUT") {
        await tx.marketingContact.update({
          where: { id: recipient.contactId },
          data: { optedOut: true, optOutReason: "Opted out via campaign", optOutAt: now, optOutById: currentUser.userId },
        });
      }
      return tx.marketingCampaignRecipient.update({
        where: { id: recipientId },
        data: { status: result.data.status, statusUpdatedAt: now },
      });
    });

    return NextResponse.json({ success: true, recipient: updated });
  } catch (error) {
    console.error("Update marketing recipient status error:", error);
    return NextResponse.json({ success: false, message: "Unable to update status" }, { status: 500 });
  }
}
