// BILTY REVENUE INTEGRITY - two independent checks, each with its own
// --apply fix. Mirrors scripts/find-orphan-bilties.ts's own
// conventions exactly (dry-run by default, --apply to write,
// --user=<username> for audit attribution).
//
// CHECK A - DELETED BILTIES WITH LIVE JOURNAL LINES
//   Root cause: the Bilty DELETE route (app/api/bilty/[id]/route.ts)
//   used to soft-delete only BILTY_BOOKING/BILTY_BOOKING_CORRECTION
//   entries when binning a Bilty - never BILTY_REVENUE_RECOGNITION,
//   its own REVERSAL, or the legacy BILTY_REVENUE_DEFERRAL (see
//   lib/bilty-revenue-recognition.ts) - a Bilty that was dispatched,
//   recognized, then un-dispatched/its Challan cancelled (clearing
//   its active link and allowing it to be binned) before being binned
//   could reach Bin with one or more of these still live, orphaned
//   now that the Bilty itself is gone. Already FIXED going forward in
//   that route; this is the one-time catch-up for Bilties already
//   binned before that fix shipped.
//   --apply: soft-deletes every still-live BILTY-owned JournalEntry
//   for each binned Bilty found - entryDate is NEVER touched (binning
//   is never a reversal, it is exactly what Bin already does for a
//   Bilty binned today).
//
// CHECK B - UNEARNED REVENUE DRIFT ON A DISPATCHED/RECOGNIZED BILTY
//   Root cause: the Bilty rent-edit correction route used to decide
//   "has this Bilty's revenue been recognized" from "is there an
//   active Challan link" alone - true at dispatch for a NORMAL
//   Challan (recognizeBiltyBookingIncome runs synchronously at
//   dispatch, no gap), but WRONG for an Own Carrier Challan, whose
//   Bilties are deliberately NOT recognized at dispatch - only once
//   the linking Carrier Trip is CLOSED (lib/carrier-trip.ts's
//   recognizeCarrierTripIncome). A rent edit on an own-carrier Bilty
//   whose Trip had not yet closed wrongly targeted Booking Income
//   instead of Unearned Revenue, leaving a residual Unearned Revenue
//   balance for that Bilty, and Booking Income holding an amount it
//   was never actually credited elsewhere for. Already FIXED going
//   forward (app/api/bilty/[id]/route.ts now checks
//   isCarrierTripChallanIncomeRecognized() per own-carrier Challan);
//   this is the catch-up for every already-drifted Bilty.
//   A Bilty's revenue is "recognized" exactly when:
//     - non-own-carrier + an active Challan link exists (dispatch
//       already recognized it, no gap), OR
//     - own-carrier + isCarrierTripChallanIncomeRecognized() is true
//       (its linking Trip has been closed).
//   For a recognized Bilty, its own Unearned Revenue net (every live
//   JournalLine tagged sourceType="BILTY"/sourceId=this Bilty on the
//   Unearned Revenue account) must be exactly 0 - any nonzero net is
//   drift. --apply posts ONE balanced BILTY_BOOKING_CORRECTION entry
//   per drifted Bilty (Unearned Revenue <-> Booking Income, for
//   exactly the drift amount) dated TODAY (an admin correction, same
//   as any other post-the-fact correction in this codebase) - zeroing
//   Unearned Revenue for that Bilty and correcting Booking Income by
//   the same amount. Idempotent: once fixed, the Bilty's own net is 0
//   and it no longer matches this check.
//
// Usage:
//   npx tsx scripts/fix-bilty-revenue-integrity.ts                    (dry-run)
//   npx tsx scripts/fix-bilty-revenue-integrity.ts --apply             (writes)
//   npx tsx scripts/fix-bilty-revenue-integrity.ts --apply --user=umar (attribute to a specific username; defaults to the first active SUPER_ADMIN)
// (reads DATABASE_URL from the environment exactly like the app itself.)
//
// BACK UP THE DATABASE BEFORE RUNNING WITH --apply.

import { PrismaClient } from "@prisma/client";
import {
  BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE,
  BILTY_REVENUE_RECOGNITION_REVERSAL_REFERENCE_TYPE,
  BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE,
} from "../lib/bilty-revenue-recognition";
import { isCarrierTripChallanIncomeRecognized } from "../lib/carrier-trip";
import { getUnearnedRevenueAccountId } from "../lib/gross-accounts";
import { auditUpdate, actorFromUser } from "../lib/audit-log";

const prisma = new PrismaClient();

const apply = process.argv.includes("--apply");
const userArg = process.argv.find((a) => a.startsWith("--user="));
const requestedUsername = userArg ? userArg.slice("--user=".length) : null;

const BILTY_OWNED_REFERENCE_TYPES = [
  "BILTY_BOOKING",
  "BILTY_BOOKING_CORRECTION",
  BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE,
  BILTY_REVENUE_RECOGNITION_REVERSAL_REFERENCE_TYPE,
  BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE,
];

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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

// ============================================================
// CHECK A
// ============================================================

interface OrphanLineGroup {
  biltyId: string;
  biltyNo: string;
  entries: { id: string; referenceType: string; entryDate: Date; total: number }[];
}

async function findDeletedBiltiesWithLiveLines(): Promise<OrphanLineGroup[]> {
  const deletedBilties = await prisma.bilty.findMany({
    where: { isDeleted: true },
    select: { id: true, biltyNo: true },
  });
  if (deletedBilties.length === 0) return [];
  const biltyNoById = new Map(deletedBilties.map((b) => [b.id, b.biltyNo]));

  const liveEntries = await prisma.journalEntry.findMany({
    where: {
      referenceType: { in: BILTY_OWNED_REFERENCE_TYPES },
      referenceId: { in: deletedBilties.map((b) => b.id) },
      isDeleted: false,
    },
    select: { id: true, referenceType: true, referenceId: true, entryDate: true, lines: { select: { debit: true, credit: true } } },
    orderBy: { entryDate: "asc" },
  });
  if (liveEntries.length === 0) return [];

  const byBiltyId = new Map<string, OrphanLineGroup>();
  for (const e of liveEntries) {
    const biltyId = e.referenceId!;
    const group = byBiltyId.get(biltyId) || { biltyId, biltyNo: biltyNoById.get(biltyId) || biltyId, entries: [] };
    const total = round2(e.lines.reduce((s, l) => s + Number(l.debit), 0));
    group.entries.push({ id: e.id, referenceType: e.referenceType!, entryDate: e.entryDate, total });
    byBiltyId.set(biltyId, group);
  }
  return [...byBiltyId.values()];
}

// ============================================================
// CHECK B
// ============================================================

interface UnearnedDriftBilty {
  biltyId: string;
  biltyNo: string;
  challanNo: string;
  ownCarrier: boolean;
  net: number; // the live, actual Unearned Revenue net (debit - credit) for this Bilty - should be 0
}

async function findUnearnedDrift(): Promise<UnearnedDriftBilty[]> {
  const unearnedAccountId = await getUnearnedRevenueAccountId(prisma);

  const candidates = await prisma.bilty.findMany({
    where: {
      isDeleted: false,
      challanBilties: { some: { challan: { isDeleted: false, status: { not: "CANCELLED" } } } },
    },
    select: {
      id: true,
      biltyNo: true,
      challanBilties: {
        where: { challan: { isDeleted: false, status: { not: "CANCELLED" } } },
        select: { challan: { select: { id: true, challanNo: true, ownCarrierId: true } } },
      },
    },
  });
  if (candidates.length === 0) return [];

  const recognizedByChallanId = new Map<string, boolean>();
  async function isRecognized(challanId: string, ownCarrierId: string | null): Promise<boolean> {
    if (!ownCarrierId) return true; // non-own-carrier dispatched -> always already recognized, no gap.
    if (recognizedByChallanId.has(challanId)) return recognizedByChallanId.get(challanId)!;
    const recognized = await isCarrierTripChallanIncomeRecognized(prisma, challanId);
    recognizedByChallanId.set(challanId, recognized);
    return recognized;
  }

  const recognizedBilties: { biltyId: string; biltyNo: string; challanNo: string; ownCarrier: boolean }[] = [];
  for (const b of candidates) {
    const link = b.challanBilties[0];
    if (!link) continue;
    const ownCarrier = Boolean(link.challan.ownCarrierId);
    if (await isRecognized(link.challan.id, link.challan.ownCarrierId)) {
      recognizedBilties.push({ biltyId: b.id, biltyNo: b.biltyNo, challanNo: link.challan.challanNo, ownCarrier });
    }
  }
  if (recognizedBilties.length === 0) return [];

  const unearnedLines = await prisma.journalLine.findMany({
    where: {
      accountId: unearnedAccountId,
      sourceType: "BILTY",
      sourceId: { in: recognizedBilties.map((b) => b.biltyId) },
      journalEntry: { isDeleted: false },
    },
    select: { sourceId: true, debit: true, credit: true },
  });
  const netByBiltyId = new Map<string, number>();
  for (const l of unearnedLines) {
    if (!l.sourceId) continue;
    netByBiltyId.set(l.sourceId, round2((netByBiltyId.get(l.sourceId) || 0) + Number(l.debit) - Number(l.credit)));
  }

  const drifted: UnearnedDriftBilty[] = [];
  for (const b of recognizedBilties) {
    const net = netByBiltyId.get(b.biltyId) || 0;
    if (Math.abs(net) > 0.01) {
      drifted.push({ biltyId: b.biltyId, biltyNo: b.biltyNo, challanNo: b.challanNo, ownCarrier: b.ownCarrier, net });
    }
  }
  return drifted;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const [orphanGroups, driftedBilties] = await Promise.all([findDeletedBiltiesWithLiveLines(), findUnearnedDrift()]);

  console.log(`\n=== CHECK A: deleted Bilties with live JournalEntries ===`);
  if (orphanGroups.length === 0) {
    console.log("None found.");
  } else {
    for (const g of orphanGroups) {
      console.log(`Bilty ${g.biltyNo}:`);
      for (const e of g.entries) {
        console.log(`  - ${e.referenceType}  entryDate=${e.entryDate.toISOString().slice(0, 10)}  amount=${e.total}  (entry ${e.id})`);
      }
    }
  }

  console.log(`\n=== CHECK B: Unearned Revenue drift on a recognized Bilty ===`);
  if (driftedBilties.length === 0) {
    console.log("None found.");
  } else {
    for (const b of driftedBilties) {
      console.log(
        `Bilty ${b.biltyNo} (Challan ${b.challanNo}${b.ownCarrier ? ", own-carrier" : ""}): Unearned net=${b.net} (should be 0) - will ${
          b.net > 0 ? "credit Unearned / debit Booking Income" : "debit Unearned / credit Booking Income"
        } ${Math.abs(b.net)}`
      );
    }
  }

  if (!apply) {
    console.log(`\nDry-run only - no writes made. Re-run with --apply to fix these. BACK UP THE DATABASE FIRST.\n`);
    await prisma.$disconnect();
    return;
  }

  if (orphanGroups.length === 0 && driftedBilties.length === 0) {
    console.log("\nNothing to apply.\n");
    await prisma.$disconnect();
    return;
  }

  const actorUser = await resolveActor();
  const actor = actorFromUser({ userId: actorUser.id, username: actorUser.username, role: actorUser.role });

  let fixedA = 0;
  for (const g of orphanGroups) {
    await prisma.$transaction(async (tx) => {
      const stillLiveIds = (
        await tx.journalEntry.findMany({
          where: { id: { in: g.entries.map((e) => e.id) }, isDeleted: false },
          select: { id: true },
        })
      ).map((e) => e.id);
      if (stillLiveIds.length === 0) return;

      await tx.journalEntry.updateMany({
        where: { id: { in: stillLiveIds } },
        data: { isDeleted: true, deletedAt: new Date(), deletedById: actorUser.id },
      });

      await auditUpdate(tx, {
        actor,
        module: "BILTY",
        entityType: "Bilty",
        entityId: g.biltyId,
        documentNo: g.biltyNo,
        description: `Bilty revenue integrity remediation - Bilty ${g.biltyNo}: soft-deleted ${stillLiveIds.length} orphaned JournalEntry(ies) left live after this already-binned Bilty - scripts/fix-bilty-revenue-integrity.ts`,
        changedFields: { orphanedEntryIds: { old: stillLiveIds, new: [] } },
      });
    });
    fixedA++;
  }

  const bookingIncomeAccount = await prisma.account.findFirst({ where: { category: "BOOKING_INCOME", isActive: true }, select: { id: true } });
  if (driftedBilties.length > 0 && !bookingIncomeAccount) {
    throw new Error("No active BOOKING_INCOME account configured - cannot apply Check B corrections.");
  }
  const unearnedAccountId = await getUnearnedRevenueAccountId(prisma);

  let fixedB = 0;
  for (const b of driftedBilties) {
    await prisma.$transaction(async (tx) => {
      // Re-check fresh inside the transaction - idempotent even on a
      // re-run or a concurrent edit.
      const unearnedLines = await tx.journalLine.findMany({
        where: { accountId: unearnedAccountId, sourceType: "BILTY", sourceId: b.biltyId, journalEntry: { isDeleted: false } },
        select: { debit: true, credit: true },
      });
      const freshNet = round2(unearnedLines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));
      if (Math.abs(freshNet) <= 0.01) return;

      const amount = round2(Math.abs(freshNet));
      const description = `Bilty revenue integrity remediation - Bilty ${b.biltyNo}: Unearned Revenue drift correction - scripts/fix-bilty-revenue-integrity.ts`;
      const lines =
        freshNet > 0
          ? [
              { accountId: unearnedAccountId, debit: 0, credit: amount },
              { accountId: bookingIncomeAccount!.id, debit: amount, credit: 0 },
            ]
          : [
              { accountId: unearnedAccountId, debit: amount, credit: 0 },
              { accountId: bookingIncomeAccount!.id, debit: 0, credit: amount },
            ];

      await tx.journalEntry.create({
        data: {
          entryDate: new Date(),
          referenceType: "BILTY_BOOKING_CORRECTION",
          referenceId: b.biltyId,
          description,
          createdById: actorUser.id,
          lines: {
            create: lines.map((l) => ({ ...l, description, sourceType: "BILTY", sourceId: b.biltyId, sourceNumber: b.biltyNo })),
          },
        },
      });

      await auditUpdate(tx, {
        actor,
        module: "BILTY",
        entityType: "Bilty",
        entityId: b.biltyId,
        documentNo: b.biltyNo,
        description,
        changedFields: { unearnedRevenueNet: { old: freshNet, new: 0 } },
      });
    });
    fixedB++;
  }

  console.log(
    `\nFixed ${fixedA} Bilty(ies) under Check A and ${fixedB} Bilty(ies) under Check B, attributed to user "${actorUser.username}". Original historical JournalEntries were not touched - only new soft-deletes / a new correction entry were applied where needed.\n`
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
