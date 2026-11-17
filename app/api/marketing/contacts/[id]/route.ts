import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { toLocalMobile } from "@/lib/phone";

// GET /api/marketing/contacts/[id] - detail + Bilty/Bill document history
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const contact = await prisma.marketingContact.findUnique({
      where: { id },
      include: {
        linkedParty: { select: { id: true, partyName: true } },
        mergedFrom: { select: { id: true, phone: true, name: true } },
        mergedInto: { select: { id: true, phone: true, name: true } },
        leads: { orderBy: { createdAt: "desc" } },
        campaignRecipients: { include: { campaign: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } },
      },
    });
    if (!contact) {
      return NextResponse.json({ success: false, message: "Contact not found" }, { status: 404 });
    }

    const everyPhone = [contact.phone, ...contact.mergedFrom.map((m) => m.phone)];
    const bilties = await prisma.bilty.findMany({
      where: { isDeleted: false },
      select: {
        id: true,
        biltyNo: true,
        date: true,
        consignorPhone: true,
        consigneePhone: true,
        total: true,
        fromLocation: { select: { name: true } },
        toLocation: { select: { name: true } },
      },
    });
    const matchingBilties = bilties
      .filter((b) => everyPhone.includes(toLocalMobile(b.consignorPhone) ?? "") || everyPhone.includes(toLocalMobile(b.consigneePhone) ?? ""))
      .sort((a, b) => b.date.getTime() - a.date.getTime());

    const bills = await prisma.bill.findMany({
      where: { isDeleted: false },
      select: { id: true, billNo: true, date: true, clientPhone: true, items: { select: { rent: true, delivery: true, otherExpense: true } } },
    });
    const matchingBills = bills
      .filter((b) => everyPhone.includes(toLocalMobile(b.clientPhone) ?? ""))
      .map((b) => ({ id: b.id, billNo: b.billNo, date: b.date, total: b.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0) }))
      .sort((a, b) => b.date.getTime() - a.date.getTime());

    return NextResponse.json({
      success: true,
      contact: {
        ...contact,
        revenue: Number(contact.revenue),
      },
      bilties: matchingBilties.map((b) => ({
        id: b.id,
        biltyNo: b.biltyNo,
        date: b.date,
        total: Number(b.total),
        route: `${b.fromLocation.name} -> ${b.toLocation.name}`,
      })),
      bills: matchingBills,
    });
  } catch (error) {
    console.error("Get marketing contact error:", error);
    return NextResponse.json({ success: false, message: "Unable to load contact" }, { status: 500 });
  }
}
