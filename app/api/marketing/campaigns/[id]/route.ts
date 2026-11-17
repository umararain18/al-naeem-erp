import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// GET /api/marketing/campaigns/[id] - detail + performance stats (sent,
// replied, leads, bookings, revenue, conversion%). Revenue/bookings come
// from every recipient's linked Lead that reached BOOKED and carries a
// convertedBiltyId (lib/marketing/conversion.ts's own auto-conversion).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const campaign = await prisma.marketingCampaign.findUnique({ where: { id } });
    if (!campaign) return NextResponse.json({ success: false, message: "Campaign not found" }, { status: 404 });

    const recipients = await prisma.marketingCampaignRecipient.findMany({
      where: { campaignId: id },
      include: { contact: { select: { id: true, name: true, phone: true } }, lead: true },
      orderBy: { createdAt: "asc" },
    });

    const sent = recipients.filter((r) => r.status !== "QUEUED").length;
    const replied = recipients.filter((r) => r.status === "REPLIED" || r.status === "LEAD").length;
    const leads = recipients.filter((r) => r.leadId !== null).length;
    const bookedRecipients = recipients.filter((r) => r.lead?.stage === "BOOKED");
    const bookings = bookedRecipients.length;

    const biltyIds = bookedRecipients.map((r) => r.lead!.convertedBiltyId).filter((v): v is string => v !== null);
    const bilties = biltyIds.length > 0 ? await prisma.bilty.findMany({ where: { id: { in: biltyIds } }, select: { id: true, total: true } }) : [];
    const revenue = bilties.reduce((sum, b) => sum + Number(b.total), 0);

    const conversionRate = sent > 0 ? (bookings / sent) * 100 : 0;
    const leadRate = sent > 0 ? (leads / sent) * 100 : 0;

    return NextResponse.json({
      success: true,
      campaign,
      stats: { sent, replied, leads, bookings, revenue, conversionRate, leadRate, total: recipients.length },
      recipients: recipients.map((r) => ({
        id: r.id,
        status: r.status,
        sentAt: r.sentAt,
        statusUpdatedAt: r.statusUpdatedAt,
        contact: r.contact,
        lead: r.lead ? { id: r.lead.id, stage: r.lead.stage, convertedBiltyId: r.lead.convertedBiltyId } : null,
      })),
    });
  } catch (error) {
    console.error("Get marketing campaign error:", error);
    return NextResponse.json({ success: false, message: "Unable to load campaign" }, { status: 500 });
  }
}
