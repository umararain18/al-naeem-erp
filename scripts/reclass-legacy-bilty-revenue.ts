// Finds every Bilty that is still PENDING (never dispatched via a
// Challan) but whose own booking JournalEntry (referenceType
// "BILTY_BOOKING") already credited a BOOKING_INCOME-category account
// directly - i.e. every Bilty booked under the OLD rule (before the
// Unearned Revenue change) that has NOT yet earned that income under
// the NEW rule (Unearned Revenue until first dispatch). This is the
// same detection query as scripts/unearned-revenue-historical-impact.ts
// (left in place as a simpler read-only check) - this script adds the
// actual, auditable correction.
//
// DEFAULT (no flag): DRY-RUN. Lists every flagged Bilty (biltyNo,
// date, amount, total) and makes NO writes.
//
// --apply: for each flagged Bilty NOT already corrected, posts ONE
// NEW balanced JournalEntry - Dr Booking Income / Cr Unearned Revenue,
// for that Bilty's own `total`, dated the Bilty's OWN `date` (not
// "now") - tagged with referenceType "BILTY_REVENUE_DEFERRAL"
// (lib/bilty-revenue-recognition.ts's BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE,
// which recognizeBiltyBookingIncome() checks for before recognizing a
// legacy Bilty's income a second time at dispatch), plus one AuditLog
// row. The original BILTY_BOOKING entry is NEVER touched/mutated -
// corrections are always new, append-only entries.
//
// Idempotent: a Bilty with an existing (non-deleted)
// BILTY_REVENUE_DEFERRAL entry is skipped on every subsequent run,
// in both dry-run and --apply modes.
//
// Usage:
//   npx tsx scripts/reclass-legacy-bilty-revenue.ts                 (dry-run)
//   npx tsx scripts/reclass-legacy-bilty-revenue.ts --apply          (writes)
//   npx tsx scripts/reclass-legacy-bilty-revenue.ts --apply --user=umar  (attribute to a specific username; defaults to the first active SUPER_ADMIN)
// (reads DATABASE_URL from the environment exactly like the app itself.)
import { PrismaClient } from "@prisma/client";
import { getUnearnedRevenueAccountId } from "../lib/gross-accounts";
import { BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE } from "../lib/bilty-revenue-recognition";
import { auditPost, actorFromUser } from "../lib/audit-log";

const prisma = new PrismaClient();

const apply = process.argv.includes("--apply");
const userArg = process.argv.find((a) => a.startsWith("--user="));
const requestedUsername = userArg ? userArg.slice("--user=".length) : null;

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function resolveActor() {
  const user = requestedUsername
    ? await prisma.user.findFirst({ where: { username: requestedUsername, isActive: true } })
    : await prisma.user.findFirst({ where: { role: "SUPER_ADMIN", isActive: true }, orderBy: { createdAt: "asc" } });

  if (!user) {
    throw new Error(
      requestedUsername
        ? `No active user found with username "${requestedUsername}".`
        : "No active SUPER_ADMIN user found - pass --user=<username> explicitly."
    );
  }
  return user;
}

async function findFlaggedBilties() {
  const pendingBilties = await prisma.bilty.findMany({
    where: { status: "PENDING", isDeleted: false },
    select: { id: true, biltyNo: true, date: true, total: true },
    orderBy: { date: "asc" },
  });
  if (pendingBilties.length === 0) return [];

  const biltyIds = pendingBilties.map((b) => b.id);

  const bookingEntries = await prisma.journalEntry.findMany({
    where: { referenceType: "BILTY_BOOKING", referenceId: { in: biltyIds }, isDeleted: false },
    select: {
      referenceId: true,
      lines: { select: { credit: true, account: { select: { category: true } } } },
    },
  });
  const bookingEntryByBiltyId = new Map(bookingEntries.map((e) => [e.referenceId as string, e]));

  const alreadyReclassified = await prisma.journalEntry.findMany({
    where: { referenceType: BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE, referenceId: { in: biltyIds }, isDeleted: false },
    select: { referenceId: true },
  });
  const reclassifiedIds = new Set(alreadyReclassified.map((e) => e.referenceId as string));

  const flagged: { bilty: (typeof pendingBilties)[number]; creditedAmount: number }[] = [];
  for (const bilty of pendingBilties) {
    if (reclassifiedIds.has(bilty.id)) continue; // already corrected - idempotent skip

    const entry = bookingEntryByBiltyId.get(bilty.id);
    if (!entry) continue; // no booking entry at all (e.g. total was 0) - nothing to flag

    const bookingIncomeLine = entry.lines.find((l) => l.account.category === "BOOKING_INCOME");
    if (!bookingIncomeLine) continue; // already correctly on Unearned Revenue - fine

    flagged.push({ bilty, creditedAmount: Number(bookingIncomeLine.credit) });
  }
  return flagged;
}

async function main() {
  const flagged = await findFlaggedBilties();

  if (flagged.length === 0) {
    console.log("No un-reclassified legacy Bilties found - nothing to do.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n=== ${apply ? "APPLYING reclass to" : "DRY-RUN - would reclass"} ${flagged.length} legacy Bilty(s) ===\n`);
  for (const { bilty, creditedAmount } of flagged) {
    console.log(`biltyNo=${bilty.biltyNo}  date=${formatDate(bilty.date)}  amount=${creditedAmount}  total=${Number(bilty.total)}`);
  }

  if (!apply) {
    console.log(`\nDry-run only - no writes made. Re-run with --apply to post the correcting entries.\n`);
    await prisma.$disconnect();
    return;
  }

  const actorUser = await resolveActor();
  const actor = actorFromUser({ userId: actorUser.id, username: actorUser.username, role: actorUser.role });

  let posted = 0;
  for (const { bilty, creditedAmount } of flagged) {
    await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction - idempotent even if this
      // script is somehow run twice concurrently.
      const existing = await tx.journalEntry.findFirst({
        where: { referenceType: BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE, referenceId: bilty.id, isDeleted: false },
        select: { id: true },
      });
      if (existing) return;

      const bookingIncomeAccount = await tx.account.findFirst({
        where: { category: "BOOKING_INCOME", isActive: true },
        select: { id: true },
      });
      if (!bookingIncomeAccount) throw new Error("No active BOOKING_INCOME account configured.");

      const unearnedRevenueAccountId = await getUnearnedRevenueAccountId(tx);
      const description = `Legacy Reclass - ${bilty.biltyNo} - Booking Income recognized before dispatch, moved to Unearned Revenue`;

      const entry = await tx.journalEntry.create({
        data: {
          entryDate: bilty.date,
          referenceType: BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE,
          referenceId: bilty.id,
          description,
          createdById: actorUser.id,
          lines: {
            create: [
              {
                accountId: bookingIncomeAccount.id,
                debit: creditedAmount,
                credit: 0,
                description,
                sourceType: "BILTY",
                sourceId: bilty.id,
                sourceNumber: bilty.biltyNo,
              },
              {
                accountId: unearnedRevenueAccountId,
                debit: 0,
                credit: creditedAmount,
                description,
                sourceType: "BILTY",
                sourceId: bilty.id,
                sourceNumber: bilty.biltyNo,
              },
            ],
          },
        },
      });

      await auditPost(tx, {
        actor,
        module: "BILTY",
        entityType: "JournalEntry",
        entityId: entry.id,
        documentNo: bilty.biltyNo,
        description: `Reclassified legacy Booking Income to Unearned Revenue for Bilty ${bilty.biltyNo} (Rs. ${creditedAmount}) via scripts/reclass-legacy-bilty-revenue.ts`,
        newValues: { biltyId: bilty.id, amount: creditedAmount, referenceType: BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE },
      });
    });
    posted++;
  }

  console.log(`\nPosted ${posted} correcting JournalEntry(s), attributed to user "${actorUser.username}". Original BILTY_BOOKING entries were not touched.\n`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
