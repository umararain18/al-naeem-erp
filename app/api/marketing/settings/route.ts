import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getMarketingSettings } from "@/lib/marketing/settings";

export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  if (!hasPermission(currentUser, "marketing.view")) {
    return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
  }
  const settings = await getMarketingSettings(prisma);
  return NextResponse.json({ success: true, settings });
}

const updateSchema = z.object({
  activeDays: z.number().int().positive(),
  sleepingMinDays: z.number().int().positive(),
  sleepingMaxDays: z.number().int().positive(),
  lostDays: z.number().int().positive(),
  vipPercentile: z.number().int().min(1).max(100),
  defaultDailyLimit: z.number().int().positive(),
  conversionWindowDays: z.number().int().positive(),
});

export async function PUT(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.manage")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const result = updateSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json({ success: false, message: result.error.issues[0]?.message || "Invalid request" }, { status: 400 });
    }
    if (result.data.sleepingMinDays > result.data.sleepingMaxDays) {
      return NextResponse.json({ success: false, message: "Sleeping minimum days cannot exceed maximum days" }, { status: 400 });
    }

    const existing = await getMarketingSettings(prisma);
    const settings = await prisma.marketingSettings.update({
      where: { id: existing.id },
      data: { ...result.data, updatedById: currentUser.userId },
    });

    return NextResponse.json({ success: true, settings });
  } catch (error) {
    console.error("Update marketing settings error:", error);
    return NextResponse.json({ success: false, message: "Unable to update settings" }, { status: 500 });
  }
}
