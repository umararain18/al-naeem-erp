import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

export async function GET(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  if (!hasPermission(currentUser, "marketing.view")) {
    return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const stage = searchParams.get("stage");
  const source = searchParams.get("source");

  const leads = await prisma.marketingLead.findMany({
    where: {
      ...(stage ? { stage: stage as "NEW" | "CONTACTED" | "QUOTED" | "BOOKED" | "LOST" } : {}),
      ...(source ? { source: source as "CAMPAIGN" | "WEBSITE" | "REFERRAL" | "CALL" } : {}),
    },
    include: { contact: { select: { id: true, name: true, phone: true } }, campaign: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ success: true, leads });
}

const createSchema = z.object({
  contactId: z.string().min(1),
  source: z.enum(["WEBSITE", "REFERRAL", "CALL"]), // CAMPAIGN leads are only ever created by the quick-status "Lead" action
  notes: z.string().optional().or(z.literal("")),
  followUpDate: z.string().optional().or(z.literal("")),
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

    const lead = await prisma.marketingLead.create({
      data: {
        contactId: result.data.contactId,
        source: result.data.source,
        notes: result.data.notes || null,
        followUpDate: result.data.followUpDate ? new Date(result.data.followUpDate) : null,
        createdById: currentUser.userId,
      },
    });

    return NextResponse.json({ success: true, lead }, { status: 201 });
  } catch (error) {
    console.error("Create marketing lead error:", error);
    return NextResponse.json({ success: false, message: "Unable to create lead" }, { status: 500 });
  }
}
