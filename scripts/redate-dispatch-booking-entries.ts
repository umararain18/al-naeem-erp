// REDATE CHALLAN_DISPATCH / BILTY_BOOKING ENTRIES
//
// A Challan's own CHALLAN_DISPATCH entry (Carrier Rent, posted at
// Challan creation) and a Bilty's own BILTY_BOOKING entry (posted at
// Bilty creation) are each dated at their document's own
// loadingDate/date AT THAT MOMENT. Editing loadingDate/date afterward
// used to leave the already-posted entry on its OLD date forever -
// confirmed in production on Challan 6403 (loadingDate 2026-10-04,
// its own CHALLAN_DISPATCH entry still dated 2026-04-10). The Bilty
// side of this was already fixed (app/api/bilty/[id]/route.ts
// re-dates BILTY_BOOKING whenever `date` changes); the Challan side
// is now fixed the same way (app/api/challan/[id]/route.ts re-dates
// CHALLAN_DISPATCH whenever `loadingDate` changes) - both fixes ship
// in the same commit as this script.
//
// This is the one-time catch-up scan/fix for every CHALLAN_DISPATCH /
// BILTY_BOOKING entry ALREADY drifted from its own document's date
// before those fixes shipped. Mirrors scripts/redate-bilty-revenue-
// drift-corrections.ts's own conventions exactly (dry-run by default,
// --apply --user=<username> to write, updates ONLY entryDate - never
// an amount, account, or debit/credit - with one audit log entry per
// corrected entry).
//
// Scope is deliberately narrow: CHALLAN_DISPATCH and BILTY_BOOKING
// only (never their own _CORRECTION siblings, which represent
// independent correction moments dated when THEY were posted, not
// the original document's date - see both code fixes' own comments).
//
// Usage:
//   npx tsx scripts/redate-dispatch-booking-entries.ts                    (dry-run)
//   npx tsx scripts/redate-dispatch-booking-entries.ts --apply             (writes)
//   npx tsx scripts/redate-dispatch-booking-entries.ts --apply --user=umar (attribute to a specific username; defaults to the first active SUPER_ADMIN)
// (reads DATABASE_URL from the environment exactly like the app itself.)

import { PrismaClient } from "@prisma/client";
import { auditUpdate, actorFromUser } from "../lib/audit-log";

const prisma = new PrismaClient();

const apply = process.argv.includes("--apply");
const userArg = process.argv.find((a) => a.startsWith("--user="));
const requestedUsername = userArg ? userArg.slice("--user=".length) : null;

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

interface Misdated {
  entryId: string;
  module: "CHALLAN" | "BILTY";
  entityId: string;
  label: string;
  oldDate: Date;
  newDate: Date;
}

function sameDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

async function findMisdatedChallanDispatch(): Promise<Misdated[]> {
  const entries = await prisma.journalEntry.findMany({
    where: { referenceType: "CHALLAN_DISPATCH", isDeleted: false },
    select: { id: true, referenceId: true, entryDate: true },
  });
  if (entries.length === 0) return [];

  const challanIds = entries.map((e) => e.referenceId!).filter(Boolean);
  const challans = await prisma.challan.findMany({ where: { id: { in: challanIds } }, select: { id: true, challanNo: true, loadingDate: true } });
  const challanById = new Map(challans.map((c) => [c.id, c]));

  const misdated: Misdated[] = [];
  for (const e of entries) {
    if (!e.referenceId) continue;
    const c = challanById.get(e.referenceId);
    if (!c) continue;
    if (!sameDay(e.entryDate, c.loadingDate)) {
      misdated.push({ entryId: e.id, module: "CHALLAN", entityId: c.id, label: `Challan ${c.challanNo}`, oldDate: e.entryDate, newDate: c.loadingDate });
    }
  }
  return misdated;
}

async function findMisdatedBiltyBooking(): Promise<Misdated[]> {
  const entries = await prisma.journalEntry.findMany({
    where: { referenceType: "BILTY_BOOKING", isDeleted: false },
    select: { id: true, referenceId: true, entryDate: true },
  });
  if (entries.length === 0) return [];

  const biltyIds = entries.map((e) => e.referenceId!).filter(Boolean);
  const bilties = await prisma.bilty.findMany({ where: { id: { in: biltyIds } }, select: { id: true, biltyNo: true, date: true } });
  const biltyById = new Map(bilties.map((b) => [b.id, b]));

  const misdated: Misdated[] = [];
  for (const e of entries) {
    if (!e.referenceId) continue;
    const b = biltyById.get(e.referenceId);
    if (!b) continue;
    if (!sameDay(e.entryDate, b.date)) {
      misdated.push({ entryId: e.id, module: "BILTY", entityId: b.id, label: `Bilty ${b.biltyNo}`, oldDate: e.entryDate, newDate: b.date });
    }
  }
  return misdated;
}

async function main() {
  const [misdatedChallans, misdatedBilties] = await Promise.all([findMisdatedChallanDispatch(), findMisdatedBiltyBooking()]);
  const misdated = [...misdatedChallans, ...misdatedBilties];

  if (misdated.length === 0) {
    console.log("No misdated CHALLAN_DISPATCH / BILTY_BOOKING entries found - nothing to do.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n=== ${apply ? "APPLYING redate to" : "DRY-RUN - would redate"} ${misdated.length} entry(ies) ===\n`);
  for (const m of misdated) {
    console.log(`[${m.module === "CHALLAN" ? "CHALLAN_DISPATCH" : "BILTY_BOOKING"}] ${m.label}: entryDate ${m.oldDate.toISOString().slice(0, 10)} -> ${m.newDate.toISOString().slice(0, 10)}  (entry ${m.entryId})`);
  }

  if (!apply) {
    console.log(`\nDry-run only - no writes made. Re-run with --apply to fix these.\n`);
    await prisma.$disconnect();
    return;
  }

  const actorUser = await resolveActor();
  const actor = actorFromUser({ userId: actorUser.id, username: actorUser.username, role: actorUser.role });

  let fixed = 0;
  for (const m of misdated) {
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.journalEntry.findUnique({ where: { id: m.entryId }, select: { entryDate: true, isDeleted: true } });
      if (!fresh || fresh.isDeleted || sameDay(fresh.entryDate, m.newDate)) return;

      await tx.journalEntry.update({ where: { id: m.entryId }, data: { entryDate: m.newDate } });

      await auditUpdate(tx, {
        actor,
        module: m.module,
        entityType: m.module === "CHALLAN" ? "Challan" : "Bilty",
        entityId: m.entityId,
        documentNo: m.label,
        description: `Redated ${m.label}'s own ${m.module === "CHALLAN" ? "CHALLAN_DISPATCH" : "BILTY_BOOKING"} entry to its document's own date - scripts/redate-dispatch-booking-entries.ts`,
        changedFields: { entryDate: { old: fresh.entryDate.toISOString().slice(0, 10), new: m.newDate.toISOString().slice(0, 10) } },
      });
    });
    fixed++;
  }

  console.log(`\nRedated ${fixed} entry(ies), attributed to user "${actorUser.username}". No amount, account, or debit/credit was touched.\n`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
