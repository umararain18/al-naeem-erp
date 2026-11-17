import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

const filterSchema = z.object({
  roles: z.array(z.enum(["SENDER", "RECEIVER", "BILL_CLIENT", "PARTY"])).optional(),
  city: z.string().optional(),
  route: z.string().optional(),
  lastActivityWithinDays: z.number().int().positive().optional(),
  minRevenue: z.number().nonnegative().optional(),
  includeBrokers: z.boolean().optional(),
  includeParty: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  filter: filterSchema.optional(),
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

    const savedSegment = await prisma.marketingSavedSegment.update({
      where: { id },
      data: {
        ...(result.data.name !== undefined && { name: result.data.name }),
        ...(result.data.filter !== undefined && { filterJson: result.data.filter }),
      },
    });

    return NextResponse.json({ success: true, savedSegment });
  } catch (error) {
    console.error("Update saved segment error:", error);
    return NextResponse.json({ success: false, message: "Unable to update saved segment" }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.manage")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    await prisma.marketingSavedSegment.delete({ where: { id } });

    return NextResponse.json({ success: true, message: "Saved segment deleted" });
  } catch (error) {
    console.error("Delete saved segment error:", error);
    return NextResponse.json({ success: false, message: "Unable to delete saved segment" }, { status: 500 });
  }
}
