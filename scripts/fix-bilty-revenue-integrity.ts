// BILTY REVENUE INTEGRITY - two independent checks, each with its own
// --apply fix. Mirrors scripts/find-orphan-bilties.ts's own
// conventions (dry-run by default, --apply to write, --user=<username>
// for audit attribution), plus --check=A|B to run/apply only one.
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
// CHECK B - UNEARNED REVENUE DRIFT ON A DISPATCHED/RECOGNIZED DOCUMENT
//   Root cause: the Bilty rent-edit correction route used to decide
//   "has this Bilty's revenue been recognized" from "is there an
//   active Challan link" alone - true at dispatch for a NORMAL
//   Challan (recognizeBiltyBookingIncome runs synchronously at
//   dispatch, per BILTY, no gap), but WRONG for an Own Carrier
//   Challan, whose Bilties are deliberately NOT recognized at dispatch
//   - only once the linking Carrier Trip is CLOSED, and even then
//   recognizeCarrierTripIncome (lib/carrier-trip.ts) posts ONE
//   CHALLAN-level recognition line (sourceType="CHALLAN",
//   sourceId=challanId) covering every one of that Challan's own
//   Bilties combined - it never touches any individual Bilty-tagged
//   line. A rent edit on an own-carrier Bilty whose Trip had not yet
//   closed wrongly targeted Booking Income instead of Unearned
//   Revenue, leaving residual drift. Already FIXED going forward
//   (app/api/bilty/[id]/route.ts now checks
//   isCarrierTripChallanIncomeRecognized() per own-carrier Challan);
//   this is the catch-up for every already-drifted document.
//
//   PER THE SAME GRANULARITY RECOGNITION ITSELF USES:
//     - non-own-carrier Bilty, active Challan link exists (dispatch
//       already recognized it per-Bilty, no gap) -> checked PER
//       BILTY: that Bilty's own Unearned Revenue net (every live line
//       tagged sourceType="BILTY"/sourceId=this Bilty) must be 0.
//     - own-carrier Challan whose linking Trip has closed
//       (isCarrierTripChallanIncomeRecognized() true) -> checked PER
//       CHALLAN: the SUM of every live Unearned Revenue line tagged
//       sourceType="BILTY"/sourceId=one of this Challan's own Bilties
//       (their own original booking credits - recognition never
//       zeroes these individually for own-carrier, by design) PLUS
//       every live line tagged sourceType="CHALLAN"/sourceId=this
//       Challan with referenceType CARRIER_TRIP_CLOSE/_REVERSAL (the
//       challan-level recognition itself) must be 0. Checking only
//       the Bilty-tagged lines here would wrongly flag EVERY
//       recognized own-carrier Bilty by its own full original booking
//       amount (confirmed live on production: 6402/6405/6406/6434/
//       6435/6459/6505-6508, all correctly recognized, all false
//       positives under that narrower check) - this is exactly the
//       mistake this version fixes.
//   --apply posts ONE balanced correction entry per drifted document
//   (Unearned Revenue <-> Booking Income, for exactly the drift
//   amount), dated the SOURCE DOCUMENT's own date (Bilty.date for a
//   BILTY-level drift, Challan.loadingDate for a CHALLAN-level one) -
//   never "today" - so it falls on the same day as whatever rent edit
//   it is actually correcting, not months later as a same-day
//   transaction with no connection to it:
//     - BILTY-level drift: referenceType BILTY_BOOKING_CORRECTION,
//       referenceId=biltyId, lines tagged sourceType="BILTY"/
//       sourceId=biltyId - the SAME shape the normal rent-edit
//       correction route itself already uses.
//     - CHALLAN-level drift: a NEW referenceType,
//       OWN_CARRIER_REVENUE_DRIFT_CORRECTION, referenceId=challanId,
//       lines tagged sourceType="CHALLAN"/sourceId=challanId - the
//       SAME tagging recognizeCarrierTripIncome itself uses, so this
//       correction is indistinguishable, to any later reader, from a
//       small adjustment to that Challan's own original recognition.
//   Idempotent: once fixed, the document's own net is 0 and it no
//   longer matches this check.
//
// Usage:
//   npx tsx scripts/fix-bilty-revenue-integrity.ts                              (dry-run, both checks)
//   npx tsx scripts/fix-bilty-revenue-integrity.ts --check=A                    (dry-run, Check A only)
//   npx tsx scripts/fix-bilty-revenue-integrity.ts --check=B                    (dry-run, Check B only)
//   npx tsx scripts/fix-bilty-revenue-integrity.ts --apply --check=A            (writes - Check A only)
//   npx tsx scripts/fix-bilty-revenue-integrity.ts --apply --check=B --user=umar (writes - Check B only, attributed to a specific username; defaults to the first active SUPER_ADMIN)
// (reads DATABASE_URL from the environment exactly like the app itself.)
//
// BACK UP THE DATABASE BEFORE RUNNING WITH --apply.

import { PrismaClient } from "@prisma/client";
import {
  BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE,
  BILTY_REVENUE_RECOGNITION_REVERSAL_REFERENCE_TYPE,
  BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE,
} from "../lib/bilty-revenue-recognition";
import {
  isCarrierTripChallanIncomeRecognized,
  CARRIER_TRIP_CLOSE_REFERENCE_TYPE,
  CARRIER_TRIP_CLOSE_REVERSAL_REFERENCE_TYPE,
} from "../lib/carrier-trip";
import { getUnearnedRevenueAccountId } from "../lib/gross-accounts";
import { auditUpdate, actorFromUser } from "../lib/audit-log";

const prisma = new PrismaClient();

const apply = process.argv.includes("--apply");
const userArg = process.argv.find((a) => a.startsWith("--user="));
const requestedUsername = userArg ? userArg.slice("--user=".length) : null;
const checkArg = process.argv.find((a) => a.startsWith("--check="));
const requestedCheck = checkArg ? checkArg.slice("--check=".length).toUpperCase() : null;
if (requestedCheck && requestedCheck !== "A" && requestedCheck !== "B") {
  throw new Error(`Invalid --check value "${requestedCheck}" - must be A or B.`);
}
const runA = !requestedCheck || requestedCheck === "A";
const runB = !requestedCheck || requestedCheck === "B";

const BILTY_OWNED_REFERENCE_TYPES = [
  "BILTY_BOOKING",
  "BILTY_BOOKING_CORRECTION",
  BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE,
  BILTY_REVENUE_RECOGNITION_REVERSAL_REFERENCE_TYPE,
  BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE,
];

const OWN_CARRIER_REVENUE_DRIFT_CORRECTION_REFERENCE_TYPE = "OWN_CARRIER_REVENUE_DRIFT_CORRECTION";

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

interface ContributingLine {
  date: string;
  referenceType: string;
  debit: number;
  credit: number;
  description: string;
  biltyNo?: string;
}

interface DriftItem {
  kind: "BILTY" | "CHALLAN";
  id: string; // biltyId for kind BILTY, challanId for kind CHALLAN
  label: string;
  net: number; // live Unearned Revenue net (debit - credit) - should be 0
  lines: ContributingLine[];
  // The source document's OWN date - Bilty.date for kind BILTY,
  // Challan.loadingDate for kind CHALLAN - the correction entry is
  // dated here, never "today", so it falls on the same day as the
  // rent edit it is correcting rather than showing up as a same-day
  // transaction months later.
  sourceDate: Date;
}

async function findUnearnedDrift(): Promise<DriftItem[]> {
  const unearnedAccountId = await getUnearnedRevenueAccountId(prisma);

  const challans = await prisma.challan.findMany({
    where: {
      isDeleted: false,
      status: { not: "CANCELLED" },
      bilties: { some: { bilty: { isDeleted: false } } },
    },
    select: {
      id: true,
      challanNo: true,
      ownCarrierId: true,
      loadingDate: true,
      bilties: { where: { bilty: { isDeleted: false } }, select: { bilty: { select: { id: true, biltyNo: true, date: true } } } },
    },
  });
  if (challans.length === 0) return [];

  const driftItems: DriftItem[] = [];

  // --- Non-own-carrier: checked PER BILTY (recognized the moment it
  // was added to the Challan - no challan-level aggregation needed). ---
  const nonOwnCarrierBilties: { id: string; biltyNo: string; date: Date }[] = [];
  for (const c of challans) {
    if (c.ownCarrierId) continue;
    for (const cb of c.bilties) nonOwnCarrierBilties.push(cb.bilty);
  }
  if (nonOwnCarrierBilties.length > 0) {
    const lines = await prisma.journalLine.findMany({
      where: {
        accountId: unearnedAccountId,
        sourceType: "BILTY",
        sourceId: { in: nonOwnCarrierBilties.map((b) => b.id) },
        journalEntry: { isDeleted: false },
      },
      select: { sourceId: true, debit: true, credit: true, description: true, journalEntry: { select: { referenceType: true, entryDate: true } } },
    });
    const byBiltyId = new Map<string, ContributingLine[]>();
    for (const l of lines) {
      if (!l.sourceId) continue;
      const arr = byBiltyId.get(l.sourceId) || [];
      arr.push({
        date: l.journalEntry.entryDate.toISOString().slice(0, 10),
        referenceType: l.journalEntry.referenceType || "",
        debit: Number(l.debit),
        credit: Number(l.credit),
        description: l.description || "",
      });
      byBiltyId.set(l.sourceId, arr);
    }
    for (const b of nonOwnCarrierBilties) {
      const biltyLines = byBiltyId.get(b.id) || [];
      const net = round2(biltyLines.reduce((s, l) => s + l.debit - l.credit, 0));
      if (Math.abs(net) > 0.01) {
        driftItems.push({ kind: "BILTY", id: b.id, label: `Bilty ${b.biltyNo}`, net, lines: biltyLines, sourceDate: b.date });
      }
    }
  }

  // --- Own-carrier: checked PER CHALLAN (recognition is a single
  // Challan-level line covering every one of its own Bilties combined
  // - see this script's own header comment). Only for a Challan whose
  // linking Trip has actually closed (isCarrierTripChallanIncomeRecognized) -
  // one not yet closed is correctly still fully unearned, not drift. ---
  const ownCarrierChallans = challans.filter((c) => c.ownCarrierId);
  for (const c of ownCarrierChallans) {
    const recognized = await isCarrierTripChallanIncomeRecognized(prisma, c.id);
    if (!recognized) continue;

    const biltyIds = c.bilties.map((cb) => cb.bilty.id);
    const biltyNoById = new Map(c.bilties.map((cb) => [cb.bilty.id, cb.bilty.biltyNo]));

    const [biltyTaggedLines, challanTaggedLines] = await Promise.all([
      prisma.journalLine.findMany({
        where: { accountId: unearnedAccountId, sourceType: "BILTY", sourceId: { in: biltyIds }, journalEntry: { isDeleted: false } },
        select: { sourceId: true, debit: true, credit: true, description: true, journalEntry: { select: { referenceType: true, entryDate: true } } },
      }),
      prisma.journalLine.findMany({
        where: {
          accountId: unearnedAccountId,
          sourceType: "CHALLAN",
          sourceId: c.id,
          journalEntry: { isDeleted: false, referenceType: { in: [CARRIER_TRIP_CLOSE_REFERENCE_TYPE, CARRIER_TRIP_CLOSE_REVERSAL_REFERENCE_TYPE] } },
        },
        select: { debit: true, credit: true, description: true, journalEntry: { select: { referenceType: true, entryDate: true } } },
      }),
    ]);

    const contributing: ContributingLine[] = [
      ...biltyTaggedLines.map((l) => ({
        date: l.journalEntry.entryDate.toISOString().slice(0, 10),
        referenceType: l.journalEntry.referenceType || "",
        debit: Number(l.debit),
        credit: Number(l.credit),
        description: l.description || "",
        biltyNo: biltyNoById.get(l.sourceId || ""),
      })),
      ...challanTaggedLines.map((l) => ({
        date: l.journalEntry.entryDate.toISOString().slice(0, 10),
        referenceType: l.journalEntry.referenceType || "",
        debit: Number(l.debit),
        credit: Number(l.credit),
        description: l.description || "",
      })),
    ];
    const net = round2(contributing.reduce((s, l) => s + l.debit - l.credit, 0));
    if (Math.abs(net) > 0.01) {
      driftItems.push({ kind: "CHALLAN", id: c.id, label: `Challan ${c.challanNo} (own-carrier)`, net, lines: contributing, sourceDate: c.loadingDate });
    }
  }

  return driftItems;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const [orphanGroups, driftItems] = await Promise.all([
    runA ? findDeletedBiltiesWithLiveLines() : Promise.resolve([] as OrphanLineGroup[]),
    runB ? findUnearnedDrift() : Promise.resolve([] as DriftItem[]),
  ]);

  const unearnedAccount = await prisma.account.findFirst({ where: { id: await getUnearnedRevenueAccountId(prisma) }, select: { accountName: true } });
  const bookingIncomeAccount = await prisma.account.findFirst({ where: { category: "BOOKING_INCOME", isActive: true }, select: { id: true, accountName: true } });

  if (runA) {
    console.log(`\n=== CHECK A: deleted Bilties with live JournalEntries ===`);
    if (orphanGroups.length === 0) {
      console.log("None found.");
    } else {
      for (const g of orphanGroups) {
        console.log(`Bilty ${g.biltyNo}:`);
        for (const e of g.entries) {
          console.log(`  - ${e.referenceType}  entryDate=${e.entryDate.toISOString().slice(0, 10)}  amount=${e.total}  (entry ${e.id})  -> will be soft-deleted, entryDate unchanged`);
        }
      }
    }
  }

  if (runB) {
    console.log(`\n=== CHECK B: Unearned Revenue drift on a recognized document ===`);
    if (driftItems.length === 0) {
      console.log("None found.");
    } else {
      for (const item of driftItems) {
        console.log(`\n${item.label} - net=${item.net} (should be 0)`);
        console.log(`  Contributing lines:`);
        for (const l of item.lines) {
          console.log(
            `    ${l.date}  ${l.referenceType}${l.biltyNo ? ` (Bilty ${l.biltyNo})` : ""}  Dr ${l.debit}  Cr ${l.credit}  ${l.description}`
          );
        }
        const amount = round2(Math.abs(item.net));
        const entryDateStr = item.sourceDate.toISOString().slice(0, 10);
        if (item.net > 0) {
          console.log(
            `  Proposed correction (dated ${entryDateStr}, the source document's own date): Cr "${unearnedAccount?.accountName || "Unearned Revenue"}" ${amount}  /  Dr "${bookingIncomeAccount?.accountName || "Booking Income"}" ${amount}`
          );
        } else {
          console.log(
            `  Proposed correction (dated ${entryDateStr}, the source document's own date): Dr "${unearnedAccount?.accountName || "Unearned Revenue"}" ${amount}  /  Cr "${bookingIncomeAccount?.accountName || "Booking Income"}" ${amount}`
          );
        }
      }
    }
  }

  if (!apply) {
    console.log(`\nDry-run only - no writes made. Re-run with --apply (optionally --check=A or --check=B) to fix these. BACK UP THE DATABASE FIRST.\n`);
    await prisma.$disconnect();
    return;
  }

  if (orphanGroups.length === 0 && driftItems.length === 0) {
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

  if (driftItems.length > 0 && !bookingIncomeAccount) {
    throw new Error("No active BOOKING_INCOME account configured - cannot apply Check B corrections.");
  }
  const unearnedAccountId = await getUnearnedRevenueAccountId(prisma);

  let fixedB = 0;
  for (const item of driftItems) {
    await prisma.$transaction(async (tx) => {
      // Re-check fresh inside the transaction - idempotent even on a
      // re-run or a concurrent edit. Same aggregation shape as the
      // scan above, just re-read live. The source document's own date
      // is re-read fresh too, same discipline - never trusted from the
      // earlier scan.
      let freshNet: number;
      let sourceDate: Date;
      if (item.kind === "BILTY") {
        const [lines, bilty] = await Promise.all([
          tx.journalLine.findMany({
            where: { accountId: unearnedAccountId, sourceType: "BILTY", sourceId: item.id, journalEntry: { isDeleted: false } },
            select: { debit: true, credit: true },
          }),
          tx.bilty.findUniqueOrThrow({ where: { id: item.id }, select: { date: true } }),
        ]);
        freshNet = round2(lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));
        sourceDate = bilty.date;
      } else {
        const challan = await tx.challan.findUniqueOrThrow({
          where: { id: item.id },
          select: { loadingDate: true, bilties: { where: { bilty: { isDeleted: false } }, select: { biltyId: true } } },
        });
        sourceDate = challan.loadingDate;
        const biltyIds = challan.bilties.map((cb) => cb.biltyId);
        const [biltyTaggedLines, challanTaggedLines] = await Promise.all([
          biltyIds.length > 0
            ? tx.journalLine.findMany({
                where: { accountId: unearnedAccountId, sourceType: "BILTY", sourceId: { in: biltyIds }, journalEntry: { isDeleted: false } },
                select: { debit: true, credit: true },
              })
            : Promise.resolve([]),
          tx.journalLine.findMany({
            where: {
              accountId: unearnedAccountId,
              sourceType: "CHALLAN",
              sourceId: item.id,
              journalEntry: { isDeleted: false, referenceType: { in: [CARRIER_TRIP_CLOSE_REFERENCE_TYPE, CARRIER_TRIP_CLOSE_REVERSAL_REFERENCE_TYPE] } },
            },
            select: { debit: true, credit: true },
          }),
        ]);
        freshNet = round2(
          [...biltyTaggedLines, ...challanTaggedLines].reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0)
        );
      }
      if (Math.abs(freshNet) <= 0.01) return;

      const amount = round2(Math.abs(freshNet));
      const description =
        item.kind === "BILTY"
          ? `Bilty revenue integrity remediation - ${item.label}: Unearned Revenue drift correction - scripts/fix-bilty-revenue-integrity.ts`
          : `Own Carrier revenue integrity remediation - ${item.label}: Unearned Revenue drift correction - scripts/fix-bilty-revenue-integrity.ts`;
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

      const sourceTag = item.kind === "BILTY" ? { sourceType: "BILTY", sourceId: item.id } : { sourceType: "CHALLAN", sourceId: item.id };

      await tx.journalEntry.create({
        data: {
          entryDate: sourceDate,
          referenceType: item.kind === "BILTY" ? "BILTY_BOOKING_CORRECTION" : OWN_CARRIER_REVENUE_DRIFT_CORRECTION_REFERENCE_TYPE,
          referenceId: item.id,
          description,
          createdById: actorUser.id,
          lines: { create: lines.map((l) => ({ ...l, description, ...sourceTag })) },
        },
      });

      await auditUpdate(tx, {
        actor,
        module: item.kind === "BILTY" ? "BILTY" : "CHALLAN",
        entityType: item.kind === "BILTY" ? "Bilty" : "Challan",
        entityId: item.id,
        documentNo: item.label,
        description,
        changedFields: { unearnedRevenueNet: { old: freshNet, new: 0 } },
      });
    });
    fixedB++;
  }

  console.log(
    `\nFixed ${fixedA} Bilty(ies) under Check A and ${fixedB} document(s) under Check B, attributed to user "${actorUser.username}". Original historical JournalEntries were not touched - only new soft-deletes / a new correction entry were applied where needed.\n`
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
