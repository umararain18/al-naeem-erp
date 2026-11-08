// REDATE BILTY REVENUE DRIFT CORRECTIONS
//
// scripts/fix-bilty-revenue-integrity.ts's own Check B used to date
// every correction entry it posted at "today" (the day the script
// ran) instead of the source document's own date (Bilty.date for a
// BILTY-level drift, Challan.loadingDate for a CHALLAN-level one) -
// already fixed there going forward. This is the one-time catch-up
// for every correction that script already posted under the old,
// wrong dating.
//
// Identifies EXACTLY the entries that script itself created - never a
// normal, user-driven rent-edit correction - by referenceType +
// description:
//   - BILTY_BOOKING_CORRECTION whose own description contains
//     "scripts/fix-bilty-revenue-integrity.ts" (a normal rent-edit
//     correction's own description never does - see app/api/bilty/
//     [id]/route.ts).
//   - OWN_CARRIER_REVENUE_DRIFT_CORRECTION (a referenceType that
//     script alone ever produces).
// For each, resolves the source document's own date and, if the
// entry's own entryDate differs, flags it.
//
// --apply updates ONLY entryDate - never touches an amount, an
// account, debit/credit, or anything else on the entry or its lines -
// and writes one audit log entry per corrected entry.
//
// Usage:
//   npx tsx scripts/redate-bilty-revenue-drift-corrections.ts                    (dry-run)
//   npx tsx scripts/redate-bilty-revenue-drift-corrections.ts --apply             (writes)
//   npx tsx scripts/redate-bilty-revenue-drift-corrections.ts --apply --user=umar (attribute to a specific username; defaults to the first active SUPER_ADMIN)
// (reads DATABASE_URL from the environment exactly like the app itself.)

import { PrismaClient } from "@prisma/client";
import { auditUpdate, actorFromUser } from "../lib/audit-log";

const prisma = new PrismaClient();

const apply = process.argv.includes("--apply");
const userArg = process.argv.find((a) => a.startsWith("--user="));
const requestedUsername = userArg ? userArg.slice("--user=".length) : null;

const SCRIPT_MARKER = "scripts/fix-bilty-revenue-integrity.ts";
const OWN_CARRIER_REVENUE_DRIFT_CORRECTION_REFERENCE_TYPE = "OWN_CARRIER_REVENUE_DRIFT_CORRECTION";

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
  label: string;
  oldDate: Date;
  newDate: Date;
}

function sameDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

async function findMisdatedCorrections(): Promise<Misdated[]> {
  const entries = await prisma.journalEntry.findMany({
    where: {
      isDeleted: false,
      OR: [
        { referenceType: "BILTY_BOOKING_CORRECTION", description: { contains: SCRIPT_MARKER } },
        { referenceType: OWN_CARRIER_REVENUE_DRIFT_CORRECTION_REFERENCE_TYPE },
      ],
    },
    select: { id: true, referenceType: true, referenceId: true, entryDate: true },
  });
  if (entries.length === 0) return [];

  const biltyIds = entries.filter((e) => e.referenceType === "BILTY_BOOKING_CORRECTION").map((e) => e.referenceId!);
  const challanIds = entries.filter((e) => e.referenceType === OWN_CARRIER_REVENUE_DRIFT_CORRECTION_REFERENCE_TYPE).map((e) => e.referenceId!);

  const [bilties, challans] = await Promise.all([
    biltyIds.length > 0 ? prisma.bilty.findMany({ where: { id: { in: biltyIds } }, select: { id: true, biltyNo: true, date: true } }) : Promise.resolve([]),
    challanIds.length > 0 ? prisma.challan.findMany({ where: { id: { in: challanIds } }, select: { id: true, challanNo: true, loadingDate: true } }) : Promise.resolve([]),
  ]);
  const biltyById = new Map(bilties.map((b) => [b.id, b]));
  const challanById = new Map(challans.map((c) => [c.id, c]));

  const misdated: Misdated[] = [];
  for (const e of entries) {
    if (!e.referenceId) continue;
    let sourceDate: Date;
    let label: string;
    if (e.referenceType === "BILTY_BOOKING_CORRECTION") {
      const b = biltyById.get(e.referenceId);
      if (!b) continue;
      sourceDate = b.date;
      label = `Bilty ${b.biltyNo}`;
    } else {
      const c = challanById.get(e.referenceId);
      if (!c) continue;
      sourceDate = c.loadingDate;
      label = `Challan ${c.challanNo}`;
    }
    if (!sameDay(e.entryDate, sourceDate)) {
      misdated.push({ entryId: e.id, label, oldDate: e.entryDate, newDate: sourceDate });
    }
  }
  return misdated;
}

async function main() {
  const misdated = await findMisdatedCorrections();

  if (misdated.length === 0) {
    console.log("No misdated correction entries found - nothing to do.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n=== ${apply ? "APPLYING redate to" : "DRY-RUN - would redate"} ${misdated.length} correction entry(ies) ===\n`);
  for (const m of misdated) {
    console.log(`${m.label}: entryDate ${m.oldDate.toISOString().slice(0, 10)} -> ${m.newDate.toISOString().slice(0, 10)}  (entry ${m.entryId})`);
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
        module: "BILTY",
        entityType: "JournalEntry",
        entityId: m.entryId,
        documentNo: m.label,
        description: `Redated ${m.label}'s own revenue-drift correction entry to its source document's own date - scripts/redate-bilty-revenue-drift-corrections.ts`,
        changedFields: { entryDate: { old: fresh.entryDate.toISOString().slice(0, 10), new: m.newDate.toISOString().slice(0, 10) } },
      });
    });
    fixed++;
  }

  console.log(`\nRedated ${fixed} correction entry(ies), attributed to user "${actorUser.username}". No amount, account, or debit/credit was touched.\n`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
