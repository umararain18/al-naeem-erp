// READ-ONLY AUDIT SCRIPT - makes no writes of any kind. Safe to run
// against the production database for a one-time inspection; do NOT
// wire this into any cron/deploy step.
//
// Lists, for every DAILY_POSTING JournalEntry still in normal
// accounting (isDeleted: false):
//
//   1) "Multi Cash/Bank" entries - entries whose lines touch 2 or
//      more DISTINCT Cash/Bank-category accounts. Most of these are
//      legitimate (e.g. an Office Cash -> Bank transfer) and need no
//      action; a few may be the genuinely ambiguous/corrupted shape
//      the old "count distinct Cash/Bank accounts" heuristic used to
//      guess at. This list exists so a human can tell the two apart -
//      it does not itself flag anything as wrong.
//
//   2) "Would render with an empty lines table" entries - the ACTUAL
//      ambiguous case under the new, reliable JournalEntry.referenceId
//      -based Main Account detection (see lib/daily-posting-edit.ts
//      and app/daily-posting/page.tsx's buildExistingRow()): entries
//      whose referenceId is missing/stale, or points at a line whose
//      account is not Cash/Bank, or that otherwise have fewer than 2
//      lines. These are the ones Daily Posting will show with Edit
//      disabled and a Bin button, per this branch's fix - this list
//      lets someone locate and clean them up directly in the DB if
//      Bin isn't enough (e.g. the data predates referenceId existing
//      at all).
//
// Usage:  npx tsx scripts/daily-posting-ambiguous-audit.ts
// (reads DATABASE_URL from the environment exactly like the app
// itself - point it at whichever database you intend to inspect.)
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function isCashOrBank(category: string): boolean {
  return category === "CASH" || category === "BANK";
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function main() {
  const entries = await prisma.journalEntry.findMany({
    where: { referenceType: "DAILY_POSTING", isDeleted: false },
    include: {
      lines: { include: { account: { select: { id: true, accountName: true, category: true } } } },
      createdBy: { select: { username: true, fullName: true } },
    },
    orderBy: { entryDate: "desc" },
  });

  const multiCashBank: typeof entries = [];
  type Reason = "NO_REFERENCE_ID" | "REFERENCE_ID_NOT_ON_ENTRY" | "REFERENCE_NOT_CASH_BANK" | "FEWER_THAN_2_LINES";
  const emptyRender: { entry: (typeof entries)[number]; reason: Reason }[] = [];

  for (const entry of entries) {
    const cashBankAccountIds = new Set(
      entry.lines.filter((l) => isCashOrBank(l.account.category)).map((l) => l.accountId)
    );
    if (cashBankAccountIds.size >= 2) {
      multiCashBank.push(entry);
    }

    // Mirrors buildExistingRow()'s own "ambiguous" condition exactly -
    // see app/daily-posting/page.tsx - broken out by reason so the
    // referenceId-specific cases (what a legacy/pre-referenceId or
    // otherwise corrupted record looks like) can be counted on their
    // own, separately from the unrelated "no counter lines" case.
    const mainLine = entry.referenceId ? entry.lines.find((l) => l.accountId === entry.referenceId) : undefined;
    const reason: Reason | null = !entry.referenceId
      ? "NO_REFERENCE_ID"
      : !mainLine
      ? "REFERENCE_ID_NOT_ON_ENTRY"
      : !isCashOrBank(mainLine.account.category)
      ? "REFERENCE_NOT_CASH_BANK"
      : entry.lines.length < 2
      ? "FEWER_THAN_2_LINES"
      : null;
    if (reason) {
      emptyRender.push({ entry, reason });
    }
  }

  console.log(`\n=== Part 1: Multi Cash/Bank Daily Posting entries (${multiCashBank.length}) ===`);
  console.log("Most of these are legitimate transfers - not itself a problem list.\n");
  for (const entry of multiCashBank) {
    const accounts = [...new Set(entry.lines.map((l) => l.account.accountName))].join(", ");
    console.log(
      `id=${entry.id}  date=${formatDate(entry.entryDate)}  accounts=[${accounts}]  createdAt=${entry.createdAt.toISOString()}  createdBy=${entry.createdBy?.username ?? "?"} (${entry.createdBy?.fullName ?? "unknown"})`
    );
  }

  console.log(`\n=== Part 2: Entries that would render with an EMPTY lines table (${emptyRender.length}) ===`);
  console.log("These are genuinely ambiguous under the new referenceId-based detection and need a human look.");
  const reasonCounts: Record<Reason, number> = {
    NO_REFERENCE_ID: 0,
    REFERENCE_ID_NOT_ON_ENTRY: 0,
    REFERENCE_NOT_CASH_BANK: 0,
    FEWER_THAN_2_LINES: 0,
  };
  for (const { reason } of emptyRender) reasonCounts[reason]++;
  console.log(
    `  by reason: referenceId missing=${reasonCounts.NO_REFERENCE_ID}, referenceId stale (not on this entry)=${reasonCounts.REFERENCE_ID_NOT_ON_ENTRY}, referenceId not Cash/Bank=${reasonCounts.REFERENCE_NOT_CASH_BANK}, fewer than 2 lines=${reasonCounts.FEWER_THAN_2_LINES}\n`
  );
  for (const { entry, reason } of emptyRender) {
    const accounts = [...new Set(entry.lines.map((l) => l.account.accountName))].join(", ");
    console.log(
      `id=${entry.id}  date=${formatDate(entry.entryDate)}  reason=${reason}  accounts=[${accounts}]  referenceId=${entry.referenceId ?? "null"}  createdAt=${entry.createdAt.toISOString()}  createdBy=${entry.createdBy?.username ?? "?"} (${entry.createdBy?.fullName ?? "unknown"})`
    );
  }

  console.log(`\nTotal DAILY_POSTING entries scanned: ${entries.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
