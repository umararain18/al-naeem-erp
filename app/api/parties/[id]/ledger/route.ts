import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getPartyLedgerData, PartyLedgerLookupError } from "@/lib/ledger-description";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    if (!hasPermission(currentUser, "parties.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    // Normal browser Party Ledger screen: newest -> oldest, like
    // every other normal ERP transaction/list screen. The
    // client-facing PDF/Excel export (ledger/pdf, ledger/excel) is
    // the ONLY place that stays chronological (oldest -> newest) -
    // see getPartyLedgerData()'s own doc comment.
    const data = await getPartyLedgerData(id, { from, to, order: "desc" });

    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    if (error instanceof PartyLedgerLookupError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 404 });
    }

    console.error("Party ledger error:", error);

    return NextResponse.json({ success: false, message: "Unable to load party ledger" }, { status: 500 });
  }
}
