import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  if (!hasPermission(currentUser, "marketing.view")) {
    return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
  }
  const savedSegments = await prisma.marketingSavedSegment.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ success: true, savedSegments });
}

const filterSchema = z.object({
  roles: z.array(z.enum(["SENDER", "RECEIVER", "BILL_CLIENT", "PARTY"])).optional(),
  city: z.string().optional(),
  route: z.string().optional(),
  lastActivityWithinDays: z.number().int().positive().optional(),
  minRevenue: z.number().nonnegative().optional(),
  includeBrokers: z.boolean().optional(),
  includeParty: z.boolean().optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  filter: filterSchema,
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

    const savedSegment = await prisma.marketingSavedSegment.create({
      data: { name: result.data.name, filterJson: result.data.filter, createdById: currentUser.userId },
    });

    return NextResponse.json({ success: true, savedSegment }, { status: 201 });
  } catch (error) {
    console.error("Create saved segment error:", error);
    return NextResponse.json({ success: false, message: "Unable to create saved segment" }, { status: 500 });
  }
}
