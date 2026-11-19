import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getFifoMismatchCount } from "@/lib/reports/daily-summary";
import { getCached } from "@/lib/reports/report-cache";

// GET /api/reports/daily-summary/fifo-mismatch - lazy, fetched by the
// Dashboard's Alerts card AFTER the main summary has rendered (see
// getFifoMismatchCount()'s own doc comment for why this is split out:
// a full FIFO reconciliation sweep is too slow to be on the main
// dashboard's load path). Ungated beyond login, same as the rest of
// the Alerts card - not one of the sections named in this app's own
// financial/operational permission split.
export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const fifoMismatchCount = await getCached("fifo-mismatch-count", getFifoMismatchCount);
    return NextResponse.json({ success: true, fifoMismatchCount });
  } catch (error) {
    console.error("FIFO mismatch count error:", error);
    return NextResponse.json({ success: false, message: "Unable to load FIFO mismatch count" }, { status: 500 });
  }
}
