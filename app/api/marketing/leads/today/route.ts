import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// GET /api/marketing/leads/today - "Today's follow-ups": every active
// (not Booked/Lost) Lead whose followUpDate is today or earlier (overdue
// follow-ups surface too, never silently dropped off the list).
export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  if (!hasPermission(currentUser, "marketing.view")) {
    return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
  }

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const leads = await prisma.marketingLead.findMany({
    where: {
      stage: { notIn: ["BOOKED", "LOST"] },
      followUpDate: { lte: endOfToday, not: null },
    },
    include: { contact: { select: { id: true, name: true, phone: true } }, campaign: { select: { id: true, name: true } } },
    orderBy: { followUpDate: "asc" },
  });

  return NextResponse.json({ success: true, leads });
}
