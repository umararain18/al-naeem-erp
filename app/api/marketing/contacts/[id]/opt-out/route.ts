import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

const optOutSchema = z.object({
  reason: z.string().optional().or(z.literal("")),
  optedOut: z.boolean().default(true),
});

// POST /api/marketing/contacts/[id]/opt-out - { optedOut: true, reason }
// to opt out (always excluded from every segment/campaign from then on),
// or { optedOut: false } to reverse it.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.manage")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const result = optOutSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json({ success: false, message: "Invalid request" }, { status: 400 });
    }

    const contact = await prisma.marketingContact.findUnique({ where: { id } });
    if (!contact) return NextResponse.json({ success: false, message: "Contact not found" }, { status: 404 });

    const updated = await prisma.marketingContact.update({
      where: { id },
      data: result.data.optedOut
        ? { optedOut: true, optOutReason: result.data.reason || null, optOutAt: new Date(), optOutById: currentUser.userId }
        : { optedOut: false, optOutReason: null, optOutAt: null, optOutById: null },
    });

    return NextResponse.json({ success: true, contact: { id: updated.id, optedOut: updated.optedOut } });
  } catch (error) {
    console.error("Opt-out marketing contact error:", error);
    return NextResponse.json({ success: false, message: "Unable to update opt-out status" }, { status: 500 });
  }
}
