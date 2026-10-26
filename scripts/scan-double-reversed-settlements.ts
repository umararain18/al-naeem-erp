// READ-ONLY SCAN for production - run first, always. Finds every
// Challan where Unsettle (lib/challan-lifecycle.ts's
// reverseChallanSettlementEntries, BEFORE its "reverse at most once"
// fix) reversed the same settlement JournalEntry more than once, or
// where total reversals for some entry shape exceed how many
// originals of that shape actually exist.
//
// Never writes anything. Never deletes/edits a JournalEntry/
// JournalLine. Safe to run against production as-is.
//
// Detection, per referenceId (the raw value shared verbatim between
// an entry and its own reversal - a Challan id for CARRIER_RENT, a
// Bilty id for COLLECTION/PAID_RESPONSIBILITY_REASSIGNMENT):
//   1. Fetch every non-deleted JournalEntry with a
//      SETTLEMENT_NET_REFERENCE_TYPES referenceType for this
//      referenceId, with its lines.
//   2. Bucket the FORWARD entries (every type except
//      SETTLEMENT_UNSETTLE_REVERSAL) by their own canonical line-set
//      shape (accountId:debit:credit, sorted - see
//      lib/challan-lifecycle.ts's canonicalLineSet); count how many
//      real originals of each shape exist.
//   3. Bucket the REVERSAL entries by their own NEGATED shape (the
//      shape an exact reversal of that bucket's originals would
//      have); count how many reversals of each shape exist.
//   4. Any shape where reversalCount > forwardCount is over-reversed
//      by exactly (reversalCount - forwardCount) extra, unmatched
//      reversal(s) - the oldest (reversalCount - forwardCount)
//      reversals of that shape, by creation order, are the excess
//      ones carried forward into the report (an arbitrary but stable,
//      deterministic choice among identically-shaped candidates -
//      which SPECIFIC reversal is "the extra one" is inherently
//      ambiguous when several share the exact same shape; which
//      ACCOUNT/AMOUNT needs correcting is not, since the whole bucket
//      shares it).
//
// Resolves a referenceId back to "Challan No" for the report via a
// direct Challan lookup, or (for a Bilty-level referenceId) via
// ChallanBilty's CURRENT link - same resolution lib/challan-
// lifecycle.ts's own reverseChallanSettlementEntries relies on, so
// this scan's scope matches what the live fix can already see (a
// Bilty since unlinked from its Challan is a known, pre-existing
// limitation shared with the live fix, not a new gap).
//
// Usage:
//   npx tsx scripts/scan-double-reversed-settlements.ts
import { PrismaClient } from "@prisma/client";
import { SETTLEMENT_NET_REFERENCE_TYPES } from "../lib/settlement-correction";
import { SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE, canonicalLineSet, canonicalNegatedLineSet, type EntryWithLines } from "../lib/challan-lifecycle";

const prisma = new PrismaClient();

function fmtMoney(n: number): string {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface ExcessReversal {
  referenceId: string;
  challanNo: string | null;
  shapeKey: string;
  forwardCount: number;
  reversalCount: number;
  excessCount: number;
  /** The excess reversal entries themselves (oldest N of the shape's
   * reversal bucket, N = excessCount) - these are what
   * scripts/correct-double-reversed-settlements.ts posts one
   * correcting entry per. */
  excessReversalEntries: EntryWithLines[];
  /** One representative forward entry of this shape, for its own
   * description/date/lines - every entry in a shape bucket has
   * identical lines by construction, so any one of them fully
   * describes the amounts/accounts involved. */
  sampleForwardEntry: EntryWithLines | null;
}

async function resolveChallanNo(referenceId: string): Promise<string | null> {
  const direct = await prisma.challan.findUnique({ where: { id: referenceId }, select: { challanNo: true } });
  if (direct) return direct.challanNo;
  const link = await prisma.challanBilty.findFirst({
    where: { biltyId: referenceId },
    select: { challan: { select: { challanNo: true } } },
  });
  return link?.challan.challanNo ?? null;
}

export async function scan(): Promise<ExcessReversal[]> {
  const reversalReferenceIdRows = await prisma.journalEntry.findMany({
    where: { referenceType: SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE, isDeleted: false },
    select: { referenceId: true },
    distinct: ["referenceId"],
  });
  const referenceIds = reversalReferenceIdRows.map((r) => r.referenceId).filter((id): id is string => !!id);

  const results: ExcessReversal[] = [];

  for (const referenceId of referenceIds) {
    const entries: EntryWithLines[] = await prisma.journalEntry.findMany({
      where: { referenceType: { in: SETTLEMENT_NET_REFERENCE_TYPES }, referenceId, isDeleted: false },
      include: { lines: true },
      orderBy: { createdAt: "asc" },
    });
    const nonEmpty = entries.filter((e) => e.lines.length > 0);
    const forwardEntries = nonEmpty.filter((e) => e.referenceType !== SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE);
    const reversalEntries = nonEmpty.filter((e) => e.referenceType === SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE);
    if (reversalEntries.length === 0) continue;

    const forwardByShape = new Map<string, EntryWithLines[]>();
    for (const f of forwardEntries) {
      const key = canonicalLineSet(f.lines);
      const arr = forwardByShape.get(key) || [];
      arr.push(f);
      forwardByShape.set(key, arr);
    }
    const reversalByShape = new Map<string, EntryWithLines[]>(); // keyed by the shape it REVERSES (its own negated shape)
    for (const r of reversalEntries) {
      const key = canonicalNegatedLineSet(r.lines);
      const arr = reversalByShape.get(key) || [];
      arr.push(r);
      reversalByShape.set(key, arr);
    }

    let challanNo: string | null | undefined;
    for (const [shapeKey, reversalsOfShape] of reversalByShape) {
      const forwardsOfShape = forwardByShape.get(shapeKey) || [];
      const excessCount = reversalsOfShape.length - forwardsOfShape.length;
      if (excessCount <= 0) continue;

      if (challanNo === undefined) challanNo = await resolveChallanNo(referenceId);

      // Oldest-first - reversalsOfShape preserves createdAt-asc order
      // (reversalEntries/entries were fetched orderBy createdAt asc).
      const excessReversalEntries = reversalsOfShape.slice(0, excessCount);

      results.push({
        referenceId,
        challanNo: challanNo ?? null,
        shapeKey,
        forwardCount: forwardsOfShape.length,
        reversalCount: reversalsOfShape.length,
        excessCount,
        excessReversalEntries,
        sampleForwardEntry: forwardsOfShape[0] ?? null,
      });
    }
  }

  return results;
}

async function describeAccount(accountId: string): Promise<string> {
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { accountName: true } });
  return account?.accountName || accountId;
}

async function printReport(results: ExcessReversal[]) {
  console.log("=".repeat(100));
  console.log(`Over-reversed settlement shapes found: ${results.length}`);
  console.log("=".repeat(100));

  for (const r of results) {
    const challanLabel = r.challanNo ?? "(Challan/Bilty record no longer exists - see entry description below for its original No.)";
    console.log(`\nChallan ${challanLabel} (referenceId=${r.referenceId}):`);
    console.log(`  Shape reversed ${r.reversalCount}x but only ${r.forwardCount} original(s) of this shape exist - ${r.excessCount} excess reversal(s).`);
    if (r.sampleForwardEntry) {
      console.log(`  Original shape (from entry ${r.sampleForwardEntry.id}, ${r.sampleForwardEntry.createdAt.toISOString().slice(0, 10)}, "${r.sampleForwardEntry.description}"):`);
      for (const l of r.sampleForwardEntry.lines) {
        const accountName = await describeAccount(l.accountId);
        console.log(`    "${accountName}": Dr ${fmtMoney(Number(l.debit))} / Cr ${fmtMoney(Number(l.credit))}`);
      }
    }
    for (const excess of r.excessReversalEntries) {
      console.log(`  EXCESS reversal ${excess.id} (${excess.createdAt.toISOString().slice(0, 10)}): "${excess.description}"`);
      for (const l of excess.lines) {
        const accountName = await describeAccount(l.accountId);
        console.log(`    "${accountName}": Dr ${fmtMoney(Number(l.debit))} / Cr ${fmtMoney(Number(l.credit))}`);
      }
    }
  }

  if (results.length === 0) console.log("  (none found)");
  console.log();
  console.log(
    `Total excess reversals: ${results.reduce((s, r) => s + r.excessCount, 0)} across ${new Set(results.map((r) => r.referenceId)).size} referenceId(s).`
  );
  console.log(
    results.length > 0
      ? "Run scripts/correct-double-reversed-settlements.ts --dry-run to see the proposed correcting entries (never applies without --apply --user=<username>)."
      : ""
  );
}

async function main() {
  const results = await scan();
  await printReport(results);
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
