import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// GET /api/marketing/dashboard - per-campaign sent/replied/leads/
// bookings/revenue/conversion%, plus a few headline totals.
export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const campaigns = await prisma.marketingCampaign.findMany({ orderBy: { createdAt: "desc" } });

    const campaignStats = await Promise.all(
      campaigns.map(async (c) => {
        const recipients = await prisma.marketingCampaignRecipient.findMany({
          where: { campaignId: c.id },
          include: { lead: { select: { stage: true, convertedBiltyId: true } } },
        });
        const sent = recipients.filter((r) => r.status !== "QUEUED").length;
        const replied = recipients.filter((r) => r.status === "REPLIED" || r.status === "LEAD").length;
        const leads = recipients.filter((r) => r.leadId !== null).length;
        const bookedBiltyIds = recipients
          .filter((r) => r.lead?.stage === "BOOKED" && r.lead.convertedBiltyId)
          .map((r) => r.lead!.convertedBiltyId!);
        const bilties = bookedBiltyIds.length > 0 ? await prisma.bilty.findMany({ where: { id: { in: bookedBiltyIds } }, select: { total: true } }) : [];
        const revenue = bilties.reduce((sum, b) => sum + Number(b.total), 0);

        return {
          id: c.id,
          name: c.name,
          sent,
          replied,
          leads,
          bookings: bookedBiltyIds.length,
          revenue,
          conversionRate: sent > 0 ? (bookedBiltyIds.length / sent) * 100 : 0,
        };
      })
    );

    const [totalContacts, totalLeads, followUpsDue] = await Promise.all([
      prisma.marketingContact.count({ where: { mergedIntoId: null } }),
      prisma.marketingLead.count({ where: { stage: { notIn: ["BOOKED", "LOST"] } } }),
      prisma.marketingLead.count({ where: { stage: { notIn: ["BOOKED", "LOST"] }, followUpDate: { lte: new Date() } } }),
    ]);

    return NextResponse.json({
      success: true,
      totals: { totalContacts, activeLeads: totalLeads, followUpsDue },
      campaigns: campaignStats,
    });
  } catch (error) {
    console.error("Marketing dashboard error:", error);
    return NextResponse.json({ success: false, message: "Unable to load dashboard" }, { status: 500 });
  }
}
