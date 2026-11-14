// REPORT: DOCUMENT vs LEDGER DRIFT (read-only, never writes anything)
//
// Root-causes WHY a party's reconciliation (see lib/party-payment-
// fifo.ts's checkPartyReconciliation, shared with scripts/backfill-
// fifo-allocation.ts and the live rerunFifoForParty warning) comes
// back MISMATCH even though every individual ledger line classifies
// cleanly (0 unexplained lines) - confirmed on the restored prod copy
// for every one of the 15 MISMATCH parties as of the last dry run
// (Al furqan, Ansari And Sons, AR Goods, Khalid Goods, MRK Faisalabad,
// MTS, Nawab Broker, Niazi Cargo Karachi, NKB, Noman Cargo Karachi,
// Raheel & Rayan - RRR, Raheel & Reyan Tarnol, RH International Goods,
// Shoib Niazi cargo, Zaheer Maluk Godam Karachi): the gap is an
// AGGREGATE drift between a document's own recorded total (Bilty's
// Collection+Commission, Challan's Carrier Rent - the "document field
// total") and what that document's own tagged lines actually posted
// to the responsible party's account over its lifetime (the "ledger-
// derived total"), accumulated through historical Settlement
// correction/unsettle-reversal cycles in the pre-existing multi-payer
// subsystem. This is NOT dynamically limited to a hardcoded party
// list (per the live-engine warning's own "no new exclusion list"
// rule) - it re-derives the current MISMATCH set fresh, every run, so
// it stays correct as data changes.
//
// For every party whose combined reconciliation is MISMATCH, scans
// every BILTY/BILTY_PAID/CHALLAN document resolved on that party's
// account and reports, per document: documentFieldTotal (totalDue),
// ledgerDerivedTotal (abs of the net debit-credit its own tagged
// lines produced on this party's account), diff, and every
// contributing ledger line (date, entry, referenceType - the
// Settlement/correction/unsettle-reversal entries that produced that
// net) so a human can trace exactly which historical correction moved
// the ledger without the document's own field following, or vice
// versa. Only documents with a nonzero diff are included.
//
// Usage:
//   npx tsx scripts/report-document-ledger-drift.ts                  (every active party)
//   npx tsx scripts/report-document-ledger-drift.ts --party="NKB"    (restrict to one party, case-insensitive substring match)
//
// Output: CSV written to <home>/drift-report.csv (never prints the
// full table to the console - only a short summary).

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getOpeningBalanceBreakdown, getPartyDocumentStates, type AllocationDirection } from "../lib/payment-allocation";
import { computePartyFifoPreview, checkPartyReconciliation, sourceTypeTagForTarget, type PartyFifoPreview } from "../lib/party-payment-fifo";

const prisma = new PrismaClient();

const partyArg = process.argv.find((a) => a.startsWith("--party="));
const requestedPartyName = partyArg ? partyArg.slice("--party=".length).replace(/^"|"$/g, "") : null;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Only Bilty/Challan are in scope per this report's own remit - Bill,
 * Phonch, and Private Phonch each have their own, separately-computed
 * balance model (not a single "field total" that can drift from a
 * simple tagged-line sum the way a Bilty/Challan's own total can). */
const DRIFT_SCOPE_TARGET_TYPES = new Set(["BILTY", "BILTY_PAID", "CHALLAN"]);

interface DriftRow {
  party: string;
  direction: AllocationDirection;
  targetSourceType: string;
  targetSourceId: string;
  documentNo: string;
  documentDate: string;
  documentFieldTotal: number;
  ledgerDerivedTotal: number;
  diff: number;
  entryDate: string;
  entryId: string;
  referenceType: string;
  referenceId: string;
  debit: number;
  credit: number;
}

function csvEscape(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(rows: DriftRow[], outPath: string) {
  const columns: (keyof DriftRow)[] = [
    "party",
    "direction",
    "targetSourceType",
    "targetSourceId",
    "documentNo",
    "documentDate",
    "documentFieldTotal",
    "ledgerDerivedTotal",
    "diff",
    "entryDate",
    "entryId",
    "referenceType",
    "referenceId",
    "debit",
    "credit",
  ];
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(","));
  }
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf-8");
}

async function findDriftForParty(partyName: string, accountId: string, direction: AllocationDirection, rows: DriftRow[]) {
  const documents = await getPartyDocumentStates(prisma, accountId, direction, { onlyWithRemainingBalance: false });

  for (const doc of documents) {
    if (!DRIFT_SCOPE_TARGET_TYPES.has(doc.targetSourceType)) continue;
    const tag = sourceTypeTagForTarget(doc.targetSourceType);
    if (!tag) continue;

    const lines = await prisma.journalLine.findMany({
      where: {
        accountId,
        sourceType: tag,
        sourceId: doc.targetSourceId,
        journalEntry: { isDeleted: false },
      },
      select: {
        debit: true,
        credit: true,
        journalEntry: { select: { id: true, entryDate: true, referenceType: true, referenceId: true } },
      },
      orderBy: { journalEntry: { entryDate: "asc" } },
    });

    let ledgerNet = 0;
    for (const line of lines) {
      ledgerNet += Number(line.debit) - Number(line.credit);
    }
    const ledgerDerivedTotal = round2(Math.abs(ledgerNet));
    const diff = round2(doc.totalDue - ledgerDerivedTotal);
    if (Math.abs(diff) <= 0.01) continue; // this document isn't contributing to the drift.

    if (lines.length === 0) {
      rows.push({
        party: partyName,
        direction,
        targetSourceType: doc.targetSourceType,
        targetSourceId: doc.targetSourceId,
        documentNo: doc.documentNo,
        documentDate: doc.documentDate.toISOString().slice(0, 10),
        documentFieldTotal: doc.totalDue,
        ledgerDerivedTotal,
        diff,
        entryDate: "",
        entryId: "",
        referenceType: "(no contributing ledger lines found)",
        referenceId: "",
        debit: 0,
        credit: 0,
      });
      continue;
    }

    for (const line of lines) {
      rows.push({
        party: partyName,
        direction,
        targetSourceType: doc.targetSourceType,
        targetSourceId: doc.targetSourceId,
        documentNo: doc.documentNo,
        documentDate: doc.documentDate.toISOString().slice(0, 10),
        documentFieldTotal: doc.totalDue,
        ledgerDerivedTotal,
        diff,
        entryDate: line.journalEntry.entryDate.toISOString().slice(0, 10),
        entryId: line.journalEntry.id,
        referenceType: line.journalEntry.referenceType ?? "",
        referenceId: line.journalEntry.referenceId ?? "",
        debit: Number(line.debit),
        credit: Number(line.credit),
      });
    }
  }
}

async function main() {
  const parties = await prisma.party.findMany({
    where: {
      isActive: true,
      account: { isActive: true },
      ...(requestedPartyName ? { partyName: { contains: requestedPartyName, mode: "insensitive" } } : {}),
    },
    select: { id: true, partyName: true, account: { select: { id: true } } },
    orderBy: { partyName: "asc" },
  });

  const rows: DriftRow[] = [];
  const mismatchParties: { partyName: string; diff: number }[] = [];
  let partiesScanned = 0;

  for (const party of parties) {
    if (!party.account) continue;
    partiesScanned++;

    const openingBreakdown = await getOpeningBalanceBreakdown(prisma, party.id);

    const directionReports: { direction: AllocationDirection; preview: PartyFifoPreview }[] = [];
    for (const direction of ["RECEIVABLE", "PAYABLE"] as const) {
      const preview = await computePartyFifoPreview(prisma, party.account.id, direction);
      if (!preview) continue;
      directionReports.push({ direction, preview });
    }

    const nonSkippedReports = directionReports.filter((r) => !r.preview.noFifoDocuments);
    if (!openingBreakdown && nonSkippedReports.length === 0) continue; // out of FIFO's own scope entirely.

    const reconciliation = await checkPartyReconciliation(prisma, party.account.id, nonSkippedReports);
    if (reconciliation.isMatch) continue;

    mismatchParties.push({ partyName: party.partyName, diff: reconciliation.diff });

    for (const direction of ["RECEIVABLE", "PAYABLE"] as const) {
      await findDriftForParty(party.partyName, party.account.id, direction, rows);
    }
  }

  const outPath = path.join(os.homedir(), "drift-report.csv");
  writeCsv(rows, outPath);

  console.log(`Scanned ${partiesScanned} active part${partiesScanned === 1 ? "y" : "ies"}.`);
  console.log(`${mismatchParties.length} part${mismatchParties.length === 1 ? "y" : "ies"} with a reconciliation MISMATCH:`);
  for (const m of mismatchParties) {
    console.log(`  - ${m.partyName} (diff=${m.diff})`);
  }
  console.log(`${rows.length} drifted-document ledger line row(s) written to ${outPath}`);
  console.log(`\nRead-only - no writes made.`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
