import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// ============================================================
// GET /api/audit-log/[id]
//
// One AuditLog row's full detail, plus a best-effort resolved
// "record link" for the entity types that have a real ERP detail page
// (Section 11 of the audit log spec) - the UI shows "Record no longer
// available" instead of a dead link when the underlying row has since
// been permanently deleted. Entity types with no dedicated detail
// page (Account, User, Payslip, Employee, Settings rows, raw
// JournalLine/JournalEntry) simply get no link - never a guessed URL.
// Read-only, same as the list route - no PATCH/DELETE exists for this
// model anywhere in the app.
// ============================================================

type LinkResolver = (row: { entityId: string | null; documentNo: string | null }) => Promise<{ href: string; exists: boolean } | null>;

const LINK_RESOLVERS: Record<string, LinkResolver> = {
  Bill: async (row) => {
    if (!row.entityId) return null;
    const found = await prisma.bill.findUnique({ where: { id: row.entityId }, select: { isDeleted: true } });
    return { href: `/bill/${row.entityId}`, exists: !!found && !found.isDeleted };
  },
  Bilty: async (row) => {
    if (!row.entityId) return null;
    const found = await prisma.bilty.findUnique({ where: { id: row.entityId }, select: { isDeleted: true } });
    return { href: `/bilty/${row.entityId}`, exists: !!found && !found.isDeleted };
  },
  Challan: async (row) => {
    if (!row.entityId) return null;
    const found = await prisma.challan.findUnique({ where: { id: row.entityId }, select: { isDeleted: true } });
    return { href: `/challan/${row.entityId}`, exists: !!found && !found.isDeleted };
  },
  Party: async (row) => {
    if (!row.entityId) return null;
    const found = await prisma.party.findUnique({ where: { id: row.entityId }, select: { id: true } });
    return { href: `/parties/${row.entityId}/ledger`, exists: !!found };
  },
  PrivatePhonch: async (row) => {
    if (!row.entityId) return null;
    const found = await prisma.privatePhonch.findUnique({ where: { id: row.entityId }, select: { isDeleted: true } });
    return { href: `/private-phonch/${row.entityId}`, exists: !!found && !found.isDeleted };
  },
  Phonch: async (row) => {
    if (!row.entityId) return null;
    const found = await prisma.phonch.findUnique({ where: { id: row.entityId }, select: { isDeleted: true } });
    return { href: `/phonch/${row.entityId}`, exists: !!found && !found.isDeleted };
  },
  Account: async (row) => {
    if (!row.entityId) return null;
    const found = await prisma.account.findUnique({ where: { id: row.entityId }, select: { id: true } });
    return { href: `/accounts`, exists: !!found };
  },
  // A SettlementPayment's own detail lives on its parent Challan
  // (documentNo was set to the Challan's id at write time - see
  // app/api/challan/[id]/settlement-payments/route.ts) - never the
  // SettlementPayment row's own id, which has no detail page.
  SettlementPayment: async (row) => {
    if (!row.documentNo) return null;
    const found = await prisma.challan.findUnique({ where: { id: row.documentNo }, select: { isDeleted: true } });
    return { href: `/challan/${row.documentNo}`, exists: !!found && !found.isDeleted };
  },
  BusinessSettings: async () => ({ href: "/settings", exists: true }),
  DocumentTypeSettings: async () => ({ href: "/settings", exists: true }),
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "audit.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const row = await prisma.auditLog.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json({ success: false, message: "Audit Log entry not found" }, { status: 404 });
    }

    const resolver = LINK_RESOLVERS[row.entityType];
    const link = resolver ? await resolver({ entityId: row.entityId, documentNo: row.documentNo }) : null;

    return NextResponse.json({ success: true, entry: row, link });
  } catch (error) {
    console.error("Get audit log entry error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Audit Log entry" }, { status: 500 });
  }
}
