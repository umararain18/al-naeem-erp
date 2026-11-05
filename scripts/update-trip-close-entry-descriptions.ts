// One-time DESCRIPTION-ONLY fix: inserts the Trip's own route (the
// cities entered on the Trip, CarrierTrip.route) into every already-
// posted Trip Close entry's description, matching the new format
// lib/carrier-trip.ts's own recognizeCarrierTripIncome/
// recognizeCarrierTripExpenseClearing now post going forward - e.g.
// "Trip 51 – Challan 6402, 6405, 6406 – Carrier Rent" becomes
// "Trip 51 (Karachi - Dera Ismail Khan - Abdul Hakeem) – Challan
// 6402, 6405, 6406 – Carrier Rent".
//
// NEVER touches amount/debit/credit/accountId/entryDate/referenceId -
// only JournalEntry.description (and the identical text on each of
// its own JournalLine.description, which always mirrors the entry's).
// Scoped to CarrierTrip rows currently CLOSED with a non-null route,
// and to referenceType CARRIER_TRIP_CLOSE/CARRIER_TRIP_CLOSE_EXPENSE
// only (never a _REVERSAL entry - those read "Trip reopened - ... -
// reversing: <original>", a different format, out of scope here).
// Idempotent - a description that already starts with "Trip N (" is
// skipped.
//
// DEFAULT (no flag): DRY-RUN. Lists every entry that would change,
// old -> new description, with no writes.
// --apply: writes the changes, one AuditLog UPDATE row per entry.
//
// Usage:
//   npx tsx scripts/update-trip-close-entry-descriptions.ts                 (dry-run)
//   npx tsx scripts/update-trip-close-entry-descriptions.ts --apply --user=umar

import { PrismaClient } from "@prisma/client";
import { auditUpdate, actorFromUser } from "../lib/audit-log";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const userArg = process.argv.find((a) => a.startsWith("--user="));
const requestedUsername = userArg ? userArg.slice("--user=".length) : null;

const CLOSE_REFERENCE_TYPES = ["CARRIER_TRIP_CLOSE", "CARRIER_TRIP_CLOSE_EXPENSE"];

async function resolveActor() {
  const user = requestedUsername
    ? await prisma.user.findFirst({ where: { username: requestedUsername, isActive: true } })
    : await prisma.user.findFirst({ where: { role: "SUPER_ADMIN", isActive: true }, orderBy: { createdAt: "asc" } });
  if (!user) {
    throw new Error(requestedUsername ? `No active user found with username "${requestedUsername}".` : "No active SUPER_ADMIN user found - pass --user=<username> explicitly.");
  }
  return user;
}

function withRoute(description: string, tripNo: string, route: string): string | null {
  const prefix = `Trip ${tripNo} `;
  if (!description.startsWith(prefix)) return null; // not this trip's own close-entry description shape - leave untouched
  if (description.startsWith(`Trip ${tripNo} (`)) return null; // already has a route parenthetical - idempotent skip
  return `Trip ${tripNo} (${route}) ${description.slice(prefix.length)}`;
}

async function main() {
  const trips = await prisma.carrierTrip.findMany({
    where: { status: "CLOSED", isDeleted: false, route: { not: null } },
    select: { id: true, tripNo: true, route: true, carrier: { select: { carrierNumber: true } } },
  });

  console.log(`Scanning ${trips.length} CLOSED Trip(s) with a route set...\n`);

  let actorUser: { id: string; username: string; role: string } | null = null;
  if (apply) actorUser = await resolveActor();

  const updates: { entryId: string; carrierNumber: string; tripNo: string; before: string; after: string }[] = [];

  for (const trip of trips) {
    const route = trip.route as string;
    const entries = await prisma.journalEntry.findMany({
      where: { referenceType: { in: CLOSE_REFERENCE_TYPES }, referenceId: trip.id, isDeleted: false },
      select: { id: true, description: true },
    });
    for (const entry of entries) {
      const next = withRoute(entry.description || "", trip.tripNo, route);
      if (next === null) continue;
      updates.push({ entryId: entry.id, carrierNumber: trip.carrier.carrierNumber, tripNo: trip.tripNo, before: entry.description || "", after: next });
    }
  }

  console.log(`Found ${updates.length} entry description(s) to update:\n`);
  for (const u of updates) {
    console.log(`  ${u.carrierNumber} / Trip ${u.tripNo} / Entry ${u.entryId}`);
    console.log(`    BEFORE: "${u.before}"`);
    console.log(`    AFTER:  "${u.after}"\n`);
  }

  if (updates.length === 0) {
    console.log("Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  if (!apply) {
    console.log("DRY RUN - no changes made. Re-run with --apply --user=<username> to write these changes.");
    await prisma.$disconnect();
    return;
  }

  const actor = actorFromUser({ userId: actorUser!.id, username: actorUser!.username, role: actorUser!.role });
  for (const u of updates) {
    await prisma.$transaction(async (tx) => {
      await tx.journalEntry.update({ where: { id: u.entryId }, data: { description: u.after } });
      await tx.journalLine.updateMany({ where: { journalEntryId: u.entryId, description: u.before }, data: { description: u.after } });
      await auditUpdate(tx, {
        actor,
        module: "CARRIER_TRIP",
        entityType: "JournalEntry",
        entityId: u.entryId,
        documentNo: u.tripNo,
        description: `Updated Trip Close entry description to include its own route (text only, no amounts/dates/accounts changed) via scripts/update-trip-close-entry-descriptions.ts`,
        oldValues: { description: u.before },
        newValues: { description: u.after },
      });
    });
  }

  console.log(`\nAPPLIED: ${updates.length} entry description(s) updated.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
