// READ-ONLY AUDIT SCRIPT - makes no writes of any kind. Safe to run
// against any database (including production) for a one-time
// inspection. Do NOT wire this into any cron/deploy step, and do NOT
// use it to automatically correct anything.
//
// Lists every historical correction JournalEntry whose own entryDate
// differs from the document it corrects:
//
//  - BILTY_BOOKING_CORRECTION (referenceId = Bilty id)  -> Bilty.date
//  - CHALLAN_DISPATCH_CORRECTION (referenceId = Challan id) -> Challan.loadingDate
//  - SETTLEMENT_CORRECTION (referenceId = Challan id) -> Challan.loadingDate
//
// Before this change, the not-yet-settled branch of
// lib/settlement-correction.ts's applySettlementCorrection()
// hardcoded entryDate = today (the date the edit happened to be
// made) for BILTY_BOOKING_CORRECTION/CHALLAN_DISPATCH_CORRECTION -
// this script finds every entry posted under that old behavior.
// SETTLEMENT_CORRECTION already used the Challan date before this
// change too, so any mismatch found there points to a different,
// pre-existing issue (e.g. the Challan's own loadingDate was edited
// AFTER the correction was posted) rather than this one.
//
// This script ONLY REPORTS (count + total corrected amount per
// referenceType); it never re-dates anything. Per the "do not re-date
// historical correction entries" rule, nothing it finds should be
// written back automatically - any fix would be a separate, reviewed,
// one-off migration script.
//
// Usage:  npx tsx scripts/correction-entry-date-mismatch-report.ts
// (reads DATABASE_URL from the environment exactly like the app
// itself - point it at whichever database you intend to inspect.)
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function reportForDocumentType(
  referenceType: string,
  documentLabel: string,
  loadDocumentDates: (ids: string[]) => Promise<Map<string, Date>>
) {
  const entries = await prisma.journalEntry.findMany({
    where: { referenceType, isDeleted: false },
    select: {
      id: true,
      entryDate: true,
      referenceId: true,
      description: true,
      lines: { select: { debit: true, credit: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (entries.length === 0) {
    console.log(`${referenceType}: no entries exist - nothing to inspect.`);
    return;
  }

  const ids = [...new Set(entries.map((e) => e.referenceId).filter((id): id is string => !!id))];
  const documentDates = await loadDocumentDates(ids);

  const mismatched = entries.filter((e) => {
    const docDate = e.referenceId ? documentDates.get(e.referenceId) : undefined;
    if (!docDate) return false; // document no longer exists / orphaned - not this script's concern
    return dateOnly(e.entryDate) !== dateOnly(docDate);
  });

  const totalAmount = mismatched.reduce(
    (sum, e) => sum + e.lines.reduce((s, l) => s + Number(l.debit), 0),
    0
  );

  console.log(`\n${referenceType} (${documentLabel}):`);
  console.log(`  Total entries:      ${entries.length}`);
  console.log(`  Date mismatches:    ${mismatched.length}`);
  console.log(`  Total amount (mismatched entries, debit side): Rs. ${totalAmount.toLocaleString()}`);

  for (const e of mismatched) {
    const docDate = documentDates.get(e.referenceId!)!;
    console.log(
      `    - JournalEntry ${e.id}: entryDate ${dateOnly(e.entryDate)} vs document date ${dateOnly(docDate)} | ${e.description ?? ""}`
    );
  }
}

async function main() {
  await reportForDocumentType("BILTY_BOOKING_CORRECTION", "Bilty.date", async (ids) => {
    const bilties = await prisma.bilty.findMany({ where: { id: { in: ids } }, select: { id: true, date: true } });
    return new Map(bilties.map((b) => [b.id, b.date]));
  });

  await reportForDocumentType("CHALLAN_DISPATCH_CORRECTION", "Challan.loadingDate", async (ids) => {
    const challans = await prisma.challan.findMany({ where: { id: { in: ids } }, select: { id: true, loadingDate: true } });
    return new Map(challans.map((c) => [c.id, c.loadingDate]));
  });

  await reportForDocumentType("SETTLEMENT_CORRECTION", "Challan.loadingDate", async (ids) => {
    const challans = await prisma.challan.findMany({ where: { id: { in: ids } }, select: { id: true, loadingDate: true } });
    return new Map(challans.map((c) => [c.id, c.loadingDate]));
  });

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
