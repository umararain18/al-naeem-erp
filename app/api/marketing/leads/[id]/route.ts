import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  if (!hasPermission(currentUser, "marketing.view")) {
    return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const lead = await prisma.marketingLead.findUnique({
    where: { id },
    include: { contact: true, campaign: { select: { id: true, name: true } } },
  });
  if (!lead) return NextResponse.json({ success: false, message: "Lead not found" }, { status: 404 });

  return NextResponse.json({ success: true, lead });
}

const updateSchema = z.object({
  stage: z.enum(["NEW", "CONTACTED", "QUOTED", "BOOKED", "LOST"]).optional(),
  notes: z.string().optional().or(z.literal("")),
  followUpDate: z.string().optional().or(z.literal("")).nullable(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.manage")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json();
    const result = updateSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json({ success: false, message: result.error.issues[0]?.message || "Invalid request" }, { status: 400 });
    }

    const lead = await prisma.marketingLead.update({
      where: { id },
      data: {
        ...(result.data.stage !== undefined && { stage: result.data.stage }),
        ...(result.data.notes !== undefined && { notes: result.data.notes || null }),
        ...(result.data.followUpDate !== undefined && {
          followUpDate: result.data.followUpDate ? new Date(result.data.followUpDate) : null,
        }),
      },
    });

    return NextResponse.json({ success: true, lead });
  } catch (error) {
    console.error("Update marketing lead error:", error);
    return NextResponse.json({ success: false, message: "Unable to update lead" }, { status: 500 });
  }
}
