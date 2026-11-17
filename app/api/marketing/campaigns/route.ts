import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { resolveSegmentContactIds } from "@/lib/marketing/campaign";

export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  if (!hasPermission(currentUser, "marketing.view")) {
    return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
  }

  const campaigns = await prisma.marketingCampaign.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { recipients: true } } },
  });

  const withStats = await Promise.all(
    campaigns.map(async (c) => {
      const grouped = await prisma.marketingCampaignRecipient.groupBy({
        by: ["status"],
        where: { campaignId: c.id },
        _count: true,
      });
      const counts: Record<string, number> = {};
      for (const g of grouped) counts[g.status] = g._count;
      return { ...c, recipientCount: c._count.recipients, statusCounts: counts };
    })
  );

  return NextResponse.json({ success: true, campaigns: withStats });
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  templateText: z.string().trim().min(1, "Template text is required"),
  dailyLimit: z.number().int().positive().default(50),
  segmentType: z.enum(["ACTIVE", "SLEEPING", "LOST", "ONE_TIME", "VIP", "ROUTE", "BROKER", "PARTY", "SAVED", "ALL"]),
  segmentParams: z.object({ route: z.string().optional(), savedSegmentId: z.string().optional() }).nullable().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.manage")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const result = createSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json({ success: false, message: result.error.issues[0]?.message || "Invalid request" }, { status: 400 });
    }
    const data = result.data;

    // Recipients are resolved ONCE here, at create time, and snapshotted
    // into MarketingCampaignRecipient rows - never re-resolved later, so
    // this campaign's own recipient list never shifts under it (see
    // lib/marketing/campaign.ts's own doc comment).
    const contactIds = await resolveSegmentContactIds(prisma, data.segmentType, data.segmentParams ?? null, new Date());
    if (contactIds.length === 0) {
      return NextResponse.json({ success: false, message: "No contacts match this segment" }, { status: 400 });
    }

    const campaign = await prisma.$transaction(async (tx) => {
      const created = await tx.marketingCampaign.create({
        data: {
          name: data.name,
          templateText: data.templateText,
          dailyLimit: data.dailyLimit,
          segmentType: data.segmentType,
          segmentParams: data.segmentParams ?? undefined,
          createdById: currentUser.userId,
        },
      });
      await tx.marketingCampaignRecipient.createMany({
        data: contactIds.map((contactId) => ({ campaignId: created.id, contactId })),
      });
      return created;
    });

    return NextResponse.json({ success: true, campaign, recipientCount: contactIds.length }, { status: 201 });
  } catch (error) {
    console.error("Create marketing campaign error:", error);
    return NextResponse.json({ success: false, message: "Unable to create campaign" }, { status: 500 });
  }
}
