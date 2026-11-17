import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { refreshMarketingContacts } from "@/lib/marketing/contact-refresh";

// POST /api/marketing/contacts/refresh - manual "Refresh Now" admin
// button. Unlike the per-write hooks, this is a direct, explicit user
// action, so its errors DO surface to the UI rather than being
// swallowed with a console.warn.
export async function POST() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  if (!hasPermission(currentUser, "marketing.manage")) {
    return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
  }

  try {
    await refreshMarketingContacts(prisma, {});
    const count = await prisma.marketingContact.count();
    return NextResponse.json({ success: true, message: `Refreshed ${count} contacts` });
  } catch (error) {
    console.error("Manual marketing contact refresh error:", error);
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : "Unable to refresh contacts" },
      { status: 500 }
    );
  }
}
