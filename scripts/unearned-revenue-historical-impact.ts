// READ-ONLY AUDIT SCRIPT - makes no writes of any kind. Safe to run
// against the production database for a one-time inspection; do NOT
// wire this into any cron/deploy step, and do NOT use it to
// automatically correct anything.
//
// Finds every Bilty that is still PENDING (never dispatched via a
// Challan) but whose own booking JournalEntry (referenceType
// "BILTY_BOOKING") already credited a BOOKING_INCOME-category account
// directly - i.e. every Bilty booked under the OLD rule (before this
// change) that has NOT yet earned that income under the NEW rule
// (Unearned Revenue until first dispatch). These amounts are
// currently counted in Total Income/Net Profit/Trial Balance as
// Booking Income even though the corresponding carriage has not
// happened - the exact problem this script exists to surface.
//
// It does NOT touch anything created by Bilties booked AFTER this
// change lands (those correctly credit Unearned Revenue, never
// Booking Income, until dispatch) - only genuinely historical,
// already-recognized-too-early entries.
//
// A SAFE, AUDITABLE, IDEMPOTENT correction (for separate review/
// approval, never run automatically) would be: for each flagged
// Bilty, post a reversing JournalEntry - Dr Booking Income / Cr
// Unearned Revenue, for that Bilty's own `total` - tagged with a new,
// dedicated referenceType (e.g. "BILTY_BOOKING_INCOME_RECLASS") so a
// second run of the correction can detect and skip any Bilty it has
// already corrected (the same idempotency pattern
// lib/bilty-revenue-recognition.ts already uses for the forward
// case). This script only REPORTS the set that would need it; it
// never writes the correction itself.
//
// Usage:  npx tsx scripts/unearned-revenue-historical-impact.ts
// (reads DATABASE_URL from the environment exactly like the app
// itself - point it at whichever database you intend to inspect.)
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function main() {
  const pendingBilties = await prisma.bilty.findMany({
    where: { status: "PENDING", isDeleted: false },
    select: { id: true, biltyNo: true, date: true, total: true, createdAt: true },
    orderBy: { date: "asc" },
  });

  if (pendingBilties.length === 0) {
    console.log("No PENDING (undispatched) Bilties exist - nothing to inspect.");
    await prisma.$disconnect();
    return;
  }

  const biltyIds = pendingBilties.map((b) => b.id);

  // Every BILTY_BOOKING entry for these Bilties, with its own lines'
  // account category - a Bilty booked under the OLD rule has a line
  // whose account.category is "BOOKING_INCOME" (credited directly);
  // one booked under the NEW rule has "OTHER_LIABILITY" (Unearned
  // Revenue) instead. Scoped to isDeleted: false - a Binned/reversed
  // booking entry contributes nothing to any live financial view
  // already, so it is correctly excluded here too.
  const bookingEntries = await prisma.journalEntry.findMany({
    where: {
      referenceType: "BILTY_BOOKING",
      referenceId: { in: biltyIds },
      isDeleted: false,
    },
    select: {
      referenceId: true,
      lines: {
        select: {
          debit: true,
          credit: true,
          account: { select: { category: true, accountName: true } },
        },
      },
    },
  });

  const bookingEntryByBiltyId = new Map(bookingEntries.map((e) => [e.referenceId as string, e]));

  const flagged: { bilty: (typeof pendingBilties)[number]; creditedAmount: number }[] = [];

  for (const bilty of pendingBilties) {
    const entry = bookingEntryByBiltyId.get(bilty.id);
    if (!entry) continue; // no booking entry at all (e.g. total was 0) - nothing to flag

    const bookingIncomeLine = entry.lines.find((l) => l.account.category === "BOOKING_INCOME");
    if (!bookingIncomeLine) continue; // already correctly on Unearned Revenue (booked under the new rule) - fine

    flagged.push({ bilty, creditedAmount: Number(bookingIncomeLine.credit) });
  }

  console.log(`\n=== PENDING Bilties with Booking Income already recognized under the OLD rule (${flagged.length} of ${pendingBilties.length} PENDING Bilties) ===\n`);

  let totalImpact = 0;
  for (const { bilty, creditedAmount } of flagged) {
    totalImpact += creditedAmount;
    console.log(
      `id=${bilty.id}  biltyNo=${bilty.biltyNo}  date=${formatDate(bilty.date)}  total=${Number(bilty.total)}  creditedToBookingIncome=${creditedAmount}  createdAt=${bilty.createdAt.toISOString()}`
    );
  }

  console.log(`\nTotal prematurely-recognized Booking Income (still undispatched): Rs. ${totalImpact.toFixed(2)}`);
  console.log(`This amount is currently included in Total Income / Net Profit / Trial Balance's Booking Income balance.`);
  console.log(`No correction was made - see this script's own header comment for a proposed, separately-reviewable correction.\n`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
