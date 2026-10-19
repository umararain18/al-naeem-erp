// ORPHAN BILTY REMEDIATION
//
// Root cause: before PR #19 (commit ae7274f), deleting (Bin-ing) a
// Challan never reset its linked Bilties back to PENDING or reversed
// their Booking Income recognition - it only soft-deleted the Challan
// itself. Every Bilty dispatched on a Challan that was Bin'd BEFORE
// that fix is therefore stuck with status IN_TRANSIT/DELIVERED
// forever, with no active Challan link - invisible to "Add Bilty"
// (which only offers PENDING Bilties) and to the Pending Bilties list,
// even though it is not actually on any live Challan.
//
// "No active Challan link" uses the SAME convention as everywhere
// else in this codebase (app/api/challan/[id]/route.ts's
// removeBiltyIds check, app/api/challan/route.ts's POST, etc.):
// `challan.isDeleted === false && challan.status !== "CANCELLED"`.
//
// DEFAULT (no flag): DRY-RUN. Lists every orphaned Bilty - biltyNo,
// status, every linked Challan's No. + isDeleted, rent, and whether
// Booking Income is currently recognized for it (net count of
// BILTY_REVENUE_RECOGNITION vs BILTY_REVENUE_RECOGNITION_REVERSAL
// entries) - and makes NO writes.
//
// --apply: for each orphaned Bilty, in one transaction:
//   1. Reverses its Booking Income recognition if still recognized
//      (Dr Booking Income / Cr Unearned Revenue - via the existing,
//      idempotent reverseBiltyBookingIncome()). A no-op if it was
//      never recognized or already reversed.
//   2. Deletes every ChallanBilty row linking it to an INACTIVE
//      Challan (deleted or cancelled) - clearing the stale link the
//      old delete bug left behind.
//   3. Sets Bilty.status to PENDING.
//   4. Writes one AuditLog row recording the old status and which
//      Challan(s) it was unlinked from.
//
// Idempotent: a Bilty is only ever selected while its status is
// IN_TRANSIT/DELIVERED AND it has no active Challan link - the moment
// step 3 runs, it stops matching, so re-running (dry-run or --apply)
// after a successful apply finds nothing left to do for it.
//
// Usage:
//   npx tsx scripts/find-orphan-bilties.ts                  (dry-run)
//   npx tsx scripts/find-orphan-bilties.ts --apply            (writes)
//   npx tsx scripts/find-orphan-bilties.ts --apply --user=umar  (attribute to a specific username; defaults to the first active SUPER_ADMIN)
// (reads DATABASE_URL from the environment exactly like the app itself.)
import { PrismaClient } from "@prisma/client";
import {
  reverseBiltyBookingIncome,
  BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE,
  BILTY_REVENUE_RECOGNITION_REVERSAL_REFERENCE_TYPE,
} from "../lib/bilty-revenue-recognition";
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

interface OrphanLink {
  challanBiltyId: string;
  challanId: string;
  challanNo: string;
  challanIsDeleted: boolean;
}

interface OrphanBilty {
  id: string;
  biltyNo: string;
  status: string;
  rent: number;
  links: OrphanLink[];
}

function isActiveChallan(challan: { isDeleted: boolean; status: string } | null): boolean {
  return !!challan && !challan.isDeleted && challan.status !== "CANCELLED";
}

async function findOrphanBilties(): Promise<OrphanBilty[]> {
  const candidates = await prisma.bilty.findMany({
    where: { status: { in: ["IN_TRANSIT", "DELIVERED"] }, isDeleted: false },
    select: {
      id: true,
      biltyNo: true,
      status: true,
      rent: true,
      challanBilties: {
        select: {
          id: true,
          challanId: true,
          challan: { select: { id: true, challanNo: true, isDeleted: true, status: true } },
        },
      },
    },
    orderBy: { biltyNo: "asc" },
  });

  const orphans: OrphanBilty[] = [];
  for (const b of candidates) {
    const hasActiveLink = b.challanBilties.some((cb) => isActiveChallan(cb.challan));
    if (hasActiveLink) continue;

    orphans.push({
      id: b.id,
      biltyNo: b.biltyNo,
      status: b.status,
      rent: Number(b.rent),
      links: b.challanBilties
        .filter((cb) => cb.challan)
        .map((cb) => ({
          challanBiltyId: cb.id,
          challanId: cb.challan!.id,
          challanNo: cb.challan!.challanNo,
          challanIsDeleted: cb.challan!.isDeleted,
        })),
    });
  }
  return orphans;
}

async function getRecognitionNet(biltyId: string): Promise<number> {
  const [recognized, reversed] = await Promise.all([
    prisma.journalEntry.count({
      where: { referenceType: BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE, referenceId: biltyId, isDeleted: false },
    }),
    prisma.journalEntry.count({
      where: { referenceType: BILTY_REVENUE_RECOGNITION_REVERSAL_REFERENCE_TYPE, referenceId: biltyId, isDeleted: false },
    }),
  ]);
  return recognized - reversed;
}

async function main() {
  const orphans = await findOrphanBilties();

  if (orphans.length === 0) {
    console.log("No orphan Bilties found - nothing to do.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n=== ${apply ? "APPLYING fix to" : "DRY-RUN - would fix"} ${orphans.length} orphan Bilty(s) ===\n`);
  for (const b of orphans) {
    const net = await getRecognitionNet(b.id);
    const linkSummary = b.links.length
      ? b.links.map((l) => `${l.challanNo} (isDeleted=${l.challanIsDeleted})`).join(", ")
      : "(no Challan link at all)";
    console.log(
      `biltyNo=${b.biltyNo}  status=${b.status}  rent=${b.rent}  linkedChallans=[${linkSummary}]  bookingIncomeRecognized=${net > 0 ? "YES" : "no"}`
    );
  }

  if (!apply) {
    console.log(`\nDry-run only - no writes made. Re-run with --apply to fix these Bilties.\n`);
    await prisma.$disconnect();
    return;
  }

  const actorUser = await resolveActor();
  const actor = actorFromUser({ userId: actorUser.id, username: actorUser.username, role: actorUser.role });

  let fixed = 0;
  for (const b of orphans) {
    await prisma.$transaction(async (tx) => {
      // Re-check fresh inside the transaction - idempotent even if
      // this script is somehow run twice concurrently, or a Bilty was
      // already fixed by an earlier, interrupted run.
      const fresh = await tx.bilty.findUnique({
        where: { id: b.id },
        select: {
          id: true,
          biltyNo: true,
          status: true,
          isDeleted: true,
          challanBilties: {
            select: { id: true, challan: { select: { id: true, challanNo: true, isDeleted: true, status: true } } },
          },
        },
      });
      if (!fresh || fresh.isDeleted) return;
      if (!(fresh.status === "IN_TRANSIT" || fresh.status === "DELIVERED")) return;
      const stillHasActiveLink = fresh.challanBilties.some((cb) => isActiveChallan(cb.challan));
      if (stillHasActiveLink) return;

      const oldStatus = fresh.status;

      await reverseBiltyBookingIncome(tx, { id: fresh.id, biltyNo: fresh.biltyNo }, {
        entryDate: new Date(),
        reason: "Orphan Bilty remediation - scripts/find-orphan-bilties.ts",
        createdById: actorUser.id,
      });

      const inactiveLinkIds = fresh.challanBilties.filter((cb) => !isActiveChallan(cb.challan)).map((cb) => cb.id);
      if (inactiveLinkIds.length > 0) {
        await tx.challanBilty.deleteMany({ where: { id: { in: inactiveLinkIds } } });
      }

      await tx.bilty.update({ where: { id: fresh.id }, data: { status: "PENDING" } });

      const unlinkedFrom = fresh.challanBilties
        .filter((cb) => !isActiveChallan(cb.challan))
        .map((cb) => cb.challan?.challanNo)
        .filter(Boolean)
        .join(", ");

      await auditUpdate(tx, {
        actor,
        module: "BILTY",
        entityType: "Bilty",
        entityId: fresh.id,
        documentNo: fresh.biltyNo,
        description: `Orphan Bilty remediation - ${fresh.biltyNo}: ${oldStatus} -> PENDING, unlinked from Challan(s) ${unlinkedFrom || "(none)"} via scripts/find-orphan-bilties.ts`,
        changedFields: { status: { old: oldStatus, new: "PENDING" } },
      });
    });
    fixed++;
  }

  console.log(`\nFixed ${fixed} orphan Bilty(s), attributed to user "${actorUser.username}". Original historical JournalEntries were not touched - only new reversing entries were posted where needed.\n`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
