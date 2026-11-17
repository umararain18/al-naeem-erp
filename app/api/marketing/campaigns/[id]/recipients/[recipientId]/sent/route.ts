import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// POST /api/marketing/campaigns/[id]/recipients/[recipientId]/sent -
// clicking the wa.me link opens WhatsApp; this marks that one send done.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string; recipientId: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.manage")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, recipientId } = await params;
    const recipient = await prisma.marketingCampaignRecipient.findFirst({ where: { id: recipientId, campaignId: id } });
    if (!recipient) return NextResponse.json({ success: false, message: "Recipient not found" }, { status: 404 });
    if (recipient.status !== "QUEUED") {
      return NextResponse.json({ success: false, message: "This recipient has already been sent" }, { status: 400 });
    }

    const now = new Date();
    const updated = await prisma.marketingCampaignRecipient.update({
      where: { id: recipientId },
      data: { status: "SENT", sentAt: now, statusUpdatedAt: now },
    });

    return NextResponse.json({ success: true, recipient: updated });
  } catch (error) {
    console.error("Mark marketing recipient sent error:", error);
    return NextResponse.json({ success: false, message: "Unable to mark as sent" }, { status: 500 });
  }
}
