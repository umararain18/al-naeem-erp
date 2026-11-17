import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { toLocalMobile } from "@/lib/phone";

// GET /api/marketing/contacts/invalid - computed, read-only. Never its
// own table (see prisma/schema.prisma's own Marketing module doc
// comment) - a live scan over current Bilty/Bill rows whose phone fails
// to normalize, so it can never drift from its own source.
export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const rows: { source: string; sourceId: string; name: string; rawPhone: string | null; date: Date }[] = [];

    const bilties = await prisma.bilty.findMany({
      where: { isDeleted: false },
      select: { id: true, date: true, consignorName: true, consignorPhone: true, consigneeName: true, consigneePhone: true },
    });
    for (const b of bilties) {
      if (toLocalMobile(b.consignorPhone) === null) {
        rows.push({ source: "BILTY_SENDER", sourceId: b.id, name: b.consignorName, rawPhone: b.consignorPhone, date: b.date });
      }
      if (toLocalMobile(b.consigneePhone) === null) {
        rows.push({ source: "BILTY_RECEIVER", sourceId: b.id, name: b.consigneeName, rawPhone: b.consigneePhone, date: b.date });
      }
    }

    const bills = await prisma.bill.findMany({
      where: { isDeleted: false },
      select: { id: true, date: true, clientName: true, clientPhone: true },
    });
    for (const b of bills) {
      if (toLocalMobile(b.clientPhone) === null) {
        rows.push({ source: "BILL_CLIENT", sourceId: b.id, name: b.clientName, rawPhone: b.clientPhone, date: b.date });
      }
    }

    rows.sort((a, b) => b.date.getTime() - a.date.getTime());

    return NextResponse.json({ success: true, invalid: rows });
  } catch (error) {
    console.error("List invalid marketing phones error:", error);
    return NextResponse.json({ success: false, message: "Unable to load invalid numbers" }, { status: 500 });
  }
}
