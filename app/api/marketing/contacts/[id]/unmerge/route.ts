import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { refreshMarketingContacts } from "@/lib/marketing/contact-refresh";

// POST /api/marketing/contacts/[id]/unmerge - clears mergedIntoId; the
// next refresh naturally "splits it back out" since the former root's
// own union no longer includes this phone's documents (see lib/
// marketing/contact-refresh.ts's own doc comment - no special-case
// recompute needed).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.manage")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const contact = await prisma.marketingContact.findUnique({ where: { id } });
    if (!contact) return NextResponse.json({ success: false, message: "Contact not found" }, { status: 404 });
    if (!contact.mergedIntoId) {
      return NextResponse.json({ success: false, message: "This contact is not merged into anything" }, { status: 400 });
    }

    const rootId = contact.mergedIntoId;
    const root = await prisma.marketingContact.findUnique({ where: { id: rootId } });

    await prisma.marketingContact.update({ where: { id }, data: { mergedIntoId: null } });

    await refreshMarketingContacts(prisma, { phones: [contact.phone, ...(root ? [root.phone] : [])] });

    return NextResponse.json({ success: true, message: "Contact unmerged" });
  } catch (error) {
    console.error("Unmerge marketing contact error:", error);
    return NextResponse.json({ success: false, message: "Unable to unmerge contact" }, { status: 500 });
  }
}
