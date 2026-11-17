import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { refreshMarketingContacts } from "@/lib/marketing/contact-refresh";

const mergeSchema = z.object({
  primaryId: z.string().min(1),
  secondaryId: z.string().min(1),
});

// POST /api/marketing/contacts/merge - manual Merge: secondaryId's own
// phone is the SAME real contact as primaryId's. secondaryId's row is
// NEVER deleted (see lib/marketing/contact-refresh.ts's own doc comment)
// - just pointed at the primary via mergedIntoId, so its own documents
// roll up into the primary's aggregate on the next refresh, and it is
// hidden from every list in favor of the primary.
export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.manage")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const result = mergeSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json({ success: false, message: result.error.issues[0]?.message || "Invalid request" }, { status: 400 });
    }
    const { primaryId, secondaryId } = result.data;
    if (primaryId === secondaryId) {
      return NextResponse.json({ success: false, message: "Cannot merge a contact into itself" }, { status: 400 });
    }

    const [primary, secondary] = await Promise.all([
      prisma.marketingContact.findUnique({ where: { id: primaryId } }),
      prisma.marketingContact.findUnique({ where: { id: secondaryId } }),
    ]);
    if (!primary || !secondary) {
      return NextResponse.json({ success: false, message: "Contact not found" }, { status: 404 });
    }

    // Always merge into the ULTIMATE root, never creating a chain longer
    // than one level - if the chosen primary is itself already merged
    // into something else, resolve up to that root first.
    let root = primary;
    if (primary.mergedIntoId) {
      const found = await prisma.marketingContact.findUnique({ where: { id: primary.mergedIntoId } });
      if (found) root = found;
    }
    const rootId = root.id;

    await prisma.marketingContact.update({
      where: { id: secondaryId },
      data: { mergedIntoId: rootId },
    });
    // Anything that was itself merged into the secondary now points at
    // the same root too, so the root's union picks it up directly.
    await prisma.marketingContact.updateMany({
      where: { mergedIntoId: secondaryId },
      data: { mergedIntoId: rootId },
    });

    await refreshMarketingContacts(prisma, { phones: [root.phone, primary.phone, secondary.phone] });

    return NextResponse.json({ success: true, message: "Contacts merged" });
  } catch (error) {
    console.error("Merge marketing contacts error:", error);
    return NextResponse.json({ success: false, message: "Unable to merge contacts" }, { status: 500 });
  }
}
