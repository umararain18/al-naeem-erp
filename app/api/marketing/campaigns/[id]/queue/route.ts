import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { renderTemplate, buildWaLink } from "@/lib/marketing/campaign";

// GET /api/marketing/campaigns/[id]/queue - "Today's queue": up to
// (dailyLimit - sentToday) QUEUED recipients, personalized text + wa.me
// link, in the order they were snapshotted at campaign-create time.
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

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

    const todayStart = startOfDay(new Date());
    const sentToday = await prisma.marketingCampaignRecipient.count({
      where: { campaignId: id, status: { not: "QUEUED" }, statusUpdatedAt: { gte: todayStart } },
    });
    const remaining = Math.max(0, campaign.dailyLimit - sentToday);

    const queued = await prisma.marketingCampaignRecipient.findMany({
      where: { campaignId: id, status: "QUEUED" },
      include: { contact: true },
      orderBy: { createdAt: "asc" },
      take: remaining,
    });

    const items = queued.map((r) => {
      const message = renderTemplate(campaign.templateText, {
        name: r.contact.name,
        city: r.contact.city,
        lastVehicle: r.contact.lastVehicle,
        lastDate: r.contact.lastDate,
        roles: r.contact.roles,
        route: r.contact.route,
      });
      return {
        recipientId: r.id,
        contact: { id: r.contact.id, name: r.contact.name, phone: r.contact.phone },
        message,
        waLink: buildWaLink(r.contact.phone, message),
      };
    });

    return NextResponse.json({ success: true, items, sentToday, dailyLimit: campaign.dailyLimit, remaining: items.length });
  } catch (error) {
    console.error("Get marketing campaign queue error:", error);
    return NextResponse.json({ success: false, message: "Unable to load queue" }, { status: 500 });
  }
}
