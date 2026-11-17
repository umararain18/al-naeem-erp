import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// GET /api/marketing/contacts/export/google-csv - plain CSV, standard
// minimal Google Contacts column set (no library, hand-built - a CSV
// needs no spreadsheet-generation library either way).
function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const contacts = await prisma.marketingContact.findMany({
      where: { mergedIntoId: null, optedOut: false },
      orderBy: { name: "asc" },
    });

    const header = ["Name", "Given Name", "Family Name", "Group Membership", "Phone 1 - Type", "Phone 1 - Value"];
    const lines = [header.join(",")];
    for (const c of contacts) {
      const firstSpace = c.name.indexOf(" ");
      const givenName = firstSpace === -1 ? c.name : c.name.slice(0, firstSpace);
      const familyName = firstSpace === -1 ? "" : c.name.slice(firstSpace + 1);
      lines.push(
        [c.name, givenName, familyName, "* My Contacts", "Mobile", c.phone].map((v) => csvField(v)).join(",")
      );
    }

    return new NextResponse(lines.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=Marketing-Contacts-Google.csv",
      },
    });
  } catch (error) {
    console.error("Marketing contacts Google CSV export error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate export" }, { status: 500 });
  }
}
