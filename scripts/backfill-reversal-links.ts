// --dry-run (default) / --apply --user=<username> metadata backfill
// for JournalEntry.reversesEntryId - a new, nullable, additive column
// that lets lib/challan-lifecycle.ts's reverseChallanSettlementEntries
// tell "already reversed" apart from "still live" by an exact,
// indexed link instead of a shape/date heuristic (see that function's
// own doc comment for the bug this fixes). Every SETTLEMENT_UNSETTLE_
// REVERSAL entry created BEFORE this field existed has
// reversesEntryId = NULL; this script fills it in for exactly those.
//
// NEVER touches a JournalEntry's financial content - debit, credit,
// accountId, description, referenceType/referenceId are untouched on
// every row this script writes to. The ONLY field ever set is the new
// reversesEntryId column on an EXISTING reversal entry, and only when
// an EXACT match is found (see below). No JournalLine is ever
// created, edited, or deleted here - that is what
// scripts/correct-double-reversed-settlements.ts is for.
//
// Detection, grouped by the raw JournalEntry.referenceId value
// (shared verbatim between an entry and its own reversal - see
// reverseChallanSettlementEntries) rather than by Challan, so this
// naturally covers both Challan-level (CARRIER_RENT) and Bilty-level
// (COLLECTION/PAID_RESPONSIBILITY_REASSIGNMENT) entries without a
// separate Challan<->Bilty join:
//   For each referenceId with at least one SETTLEMENT_UNSETTLE_
//   REVERSAL entry lacking reversesEntryId, matches it against the
//   oldest not-yet-consumed forward entry (any OTHER
//   SETTLEMENT_NET_REFERENCE_TYPES type, created before this
//   reversal) whose lines are this reversal's lines negated, exactly
//   (lib/challan-lifecycle.ts's matchReversalsToForwardEntries - same
//   exact-negation precedent used by the live Unsettle fix). A
//   reversal with no exact match is reported as UNMATCHED (left
//   alone, never guessed at). A reversal whose match was ambiguous
//   (2+ forward entries with the identical shape, at the time of
//   matching) is reported as AMBIGUOUS, listing every candidate - and
//   is SKIPPED by --apply (never auto-resolved) unless
//   --apply-ambiguous is also passed, picking the oldest candidate
//   (the EXACT same deterministic rule the live Unsettle fallback
//   itself already uses for this same ambiguity today, so applying it
//   here only makes the stored link match what the live code already
//   assumes).
//
// Usage:
//   npx tsx scripts/backfill-reversal-links.ts
//   npx tsx scripts/backfill-reversal-links.ts --dry-run
//   npx tsx scripts/backfill-reversal-links.ts --apply --user=<username>
//   npx tsx scripts/backfill-reversal-links.ts --apply --user=<username> --apply-ambiguous
import { PrismaClient } from "@prisma/client";
import { SETTLEMENT_NET_REFERENCE_TYPES } from "../lib/settlement-correction";
import {
  SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE,
  matchReversalsToForwardEntries,
  type EntryWithLines,
} from "../lib/challan-lifecycle";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

interface PlannedUpdate {
  reversalId: string;
  reversalDescription: string;
  matchedForwardEntryId: string;
}

interface ReportRow {
  referenceId: string;
  reversalId: string;
  reversalDate: Date;
  status: "MATCHED" | "AMBIGUOUS" | "UNMATCHED";
  matchedForwardEntryId: string | null;
  ambiguousCandidateIds: string[];
}

async function scan(): Promise<{ report: ReportRow[]; planned: PlannedUpdate[] }> {
  const unlinkedReversals = await prisma.journalEntry.findMany({
    where: { referenceType: SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE, reversesEntryId: null, isDeleted: false },
    select: { referenceId: true },
    distinct: ["referenceId"],
  });
  const referenceIds = unlinkedReversals.map((r) => r.referenceId).filter((id): id is string => !!id);

  const report: ReportRow[] = [];
  const planned: PlannedUpdate[] = [];

  for (const referenceId of referenceIds) {
    const entries: EntryWithLines[] = await prisma.journalEntry.findMany({
      where: { referenceType: { in: SETTLEMENT_NET_REFERENCE_TYPES }, referenceId, isDeleted: false },
      include: { lines: true },
      orderBy: { createdAt: "asc" },
    });

    const nonEmpty = entries.filter((e) => e.lines.length > 0);
    const forwardEntries = nonEmpty.filter((e) => e.referenceType !== SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE);
    const reversalEntries = nonEmpty.filter(
      (e) => e.referenceType === SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE && !e.reversesEntryId
    );
    if (reversalEntries.length === 0) continue;

    const matches = matchReversalsToForwardEntries(forwardEntries, reversalEntries);
    for (const m of matches) {
      const reversal = reversalEntries.find((r) => r.id === m.reversalId)!;
      const status: ReportRow["status"] = m.matchedForwardEntryId
        ? m.ambiguousCandidateIds.length > 0
          ? "AMBIGUOUS"
          : "MATCHED"
        : "UNMATCHED";
      report.push({
        referenceId,
        reversalId: reversal.id,
        reversalDate: reversal.createdAt,
        status,
        matchedForwardEntryId: m.matchedForwardEntryId,
        ambiguousCandidateIds: m.ambiguousCandidateIds,
      });
      if (status === "MATCHED") {
        planned.push({ reversalId: reversal.id, reversalDescription: reversal.description || "", matchedForwardEntryId: m.matchedForwardEntryId! });
      }
    }
  }

  return { report, planned };
}

function printReport(report: ReportRow[]) {
  console.log("=".repeat(100));
  console.log(`Unlinked SETTLEMENT_UNSETTLE_REVERSAL entries found: ${report.length}`);
  console.log("=".repeat(100));
  const byStatus = { MATCHED: 0, AMBIGUOUS: 0, UNMATCHED: 0 };
  for (const r of report) {
    byStatus[r.status]++;
    const dateStr = r.reversalDate.toISOString().slice(0, 10);
    if (r.status === "MATCHED") {
      console.log(`  MATCHED    referenceId=${r.referenceId} reversal=${r.reversalId} (${dateStr}) -> forward=${r.matchedForwardEntryId}`);
    } else if (r.status === "AMBIGUOUS") {
      console.log(
        `  AMBIGUOUS  referenceId=${r.referenceId} reversal=${r.reversalId} (${dateStr}) -> chosen=${r.matchedForwardEntryId}, also matches: ${r.ambiguousCandidateIds.join(", ")}`
      );
    } else {
      console.log(`  UNMATCHED  referenceId=${r.referenceId} reversal=${r.reversalId} (${dateStr}) - no exact-negation forward entry found`);
    }
  }
  if (report.length === 0) console.log("  (none - every reversal already linked or no history to backfill)");
  console.log();
  console.log(`Summary: ${byStatus.MATCHED} matched, ${byStatus.AMBIGUOUS} ambiguous, ${byStatus.UNMATCHED} unmatched.`);
  console.log();
}

async function apply(planned: PlannedUpdate[], report: ReportRow[], username: string, applyAmbiguous: boolean) {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true, username: true } });
  if (!user) {
    console.error(`No user found with username "${username}". Aborting - nothing was written.`);
    process.exit(1);
  }

  const toApply = [...planned];
  if (applyAmbiguous) {
    for (const r of report) {
      if (r.status === "AMBIGUOUS" && r.matchedForwardEntryId) {
        toApply.push({ reversalId: r.reversalId, reversalDescription: "", matchedForwardEntryId: r.matchedForwardEntryId });
      }
    }
  }

  console.log("=".repeat(100));
  console.log(`BACKFILLING reversesEntryId on ${toApply.length} reversal entry(ies) as user "${user.username}"...`);
  console.log("=".repeat(100));

  for (const p of toApply) {
    const result = await prisma.journalEntry.updateMany({
      where: { id: p.reversalId, reversesEntryId: null },
      data: { reversesEntryId: p.matchedForwardEntryId },
    });
    if (result.count > 0) {
      console.log(`  SET reversal=${p.reversalId} -> reversesEntryId=${p.matchedForwardEntryId}`);
    } else {
      console.log(`  SKIP reversal=${p.reversalId}: already linked (changed since scan?).`);
    }
  }
}

async function main() {
  const applyFlag = process.argv.includes("--apply");
  const applyAmbiguous = process.argv.includes("--apply-ambiguous");
  const username = arg("user");

  if (applyFlag && !username) {
    console.error("--apply requires --user=<username> (whoever is approving/running this backfill).");
    process.exit(1);
  }

  const { report, planned } = await scan();
  printReport(report);

  if (applyFlag && username) {
    await apply(planned, report, username, applyAmbiguous);
  } else {
    console.log(
      `Dry run only - ${planned.length} unambiguous link(s) would be set with --apply --user=<username>` +
        ` (add --apply-ambiguous to also resolve ambiguous cases, oldest-candidate rule).`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
