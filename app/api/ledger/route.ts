import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getAccountLedgerData, filterLedgerRowsBySearch, parseLedgerEntryType, PartyLedgerLookupError } from "@/lib/ledger-description";

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "accounts.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get("accountId");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const search = searchParams.get("search")?.trim();

    const accounts = await prisma.account.findMany({
      where: {
        isActive: true,
        ...(search
          ? {
              OR: [
                { accountName: { contains: search, mode: "insensitive" } },
                { accountCode: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        accountName: true,
        accountCode: true,
        accountType: true,
        category: true,
        isActive: true,
        partyId: true,
        party: {
          select: {
            id: true,
            partyName: true,
          },
        },
      },
      orderBy: {
        accountCode: "asc",
      },
    });

    if (!accountId) {
      return NextResponse.json({
        success: true,
        accounts,
        selectedAccount: null,
        entries: [],
        summary: null,
      });
    }

    const selectedAccount = accounts.find((a) => a.id === accountId);

    if (!selectedAccount) {
      return NextResponse.json(
        { success: false, message: "Account not found" },
        { status: 404 }
      );
    }

    // Same business-readable, duplicate-collapsing consolidation
    // Party Ledger already uses (lib/ledger-description.ts) - a
    // technical reclassification chain (Settlement default +
    // SettlementPayment + Collection/Carrier Rent Transition) that
    // nets to one real economic effect is shown as ONE row here too,
    // never as several raw JournalEntries. Never hides a genuine,
    // non-zero-net remainder - see buildUserFacingLedgerRows()'s own
    // guards.
    const documentType = parseLedgerEntryType(searchParams.get("type"));
    const data = await getAccountLedgerData(accountId, { from, to, order: "desc", documentType, includeOpeningBalanceRow: true });

    // Transaction search narrows which rows are DISPLAYED only - the
    // summary (opening/period/closing balance) above is computed from
    // the full, unfiltered selected date range (and, when a Type
    // filter is active, from only that type - see
    // getAccountLedgerData()'s own doc comment) and is never touched
    // by a search term. See filterLedgerRowsBySearch()'s own doc
    // comment (lib/ledger-description.ts). Search + Type therefore
    // combine with AND semantics: Type narrows data.ledger first,
    // then search narrows the already-type-filtered rows further.
    const transactionSearch = searchParams.get("q") || searchParams.get("transactionSearch");
    const entries = filterLedgerRowsBySearch(data.ledger, transactionSearch);

    return NextResponse.json({
      success: true,
      accounts,
      selectedAccount: {
        id: selectedAccount.id,
        accountName: selectedAccount.accountName,
        accountCode: selectedAccount.accountCode,
        accountType: selectedAccount.accountType,
        category: selectedAccount.category,
        party: selectedAccount.party,
      },
      entries,
      resultCount: transactionSearch?.trim() ? entries.length : null,
      summary: {
        openingBalance: data.summary.openingBalance,
        totalDebit: data.summary.periodDebit,
        totalCredit: data.summary.periodCredit,
        closingBalance: data.summary.closingBalance,
        balanceType: data.summary.balanceType,
      },
      filters: { ...data.filters, search: transactionSearch || null },
    });
  } catch (error) {
    if (error instanceof PartyLedgerLookupError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 404 });
    }
    console.error("General Ledger API error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load ledger" },
      { status: 500 }
    );
  }
}
