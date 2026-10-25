// --dry-run (default) / --apply --user=<username> data-fix for
// Challans unsettled BEFORE lib/challan-lifecycle.ts's
// reverseChallanSettlementEntries learned to deactivate the
// COLLECTION/CARRIER_RENT SettlementPayment rows it reverses. Those
// historical Unsettle calls correctly posted reversing JournalEntries
// (the real accounting is fine) but left the rows themselves
// isActive: true forever, which is why Financial Summary/position
// and the Rent-reduction guard still show/count them.
//
// NEVER touches a JournalEntry/JournalLine - every historical ledger
// line (original AND its reversal) stays exactly as posted. This
// only flips SettlementPayment.isActive to false (+ deactivatedAt/
// deactivatedById/deactivationReason) on rows this script can prove
// were already reversed by an Unsettle that happened AFTER the row
// was created.
//
// Detection, per Challan:
//   1. Find the LATEST SETTLEMENT_UNSETTLE_REVERSAL JournalEntry for
//      this Challan or any of its Bilties (referenceId in
//      [challanId, ...biltyIds]) - if none exists, this Challan was
//      never unsettled; skip it entirely.
//   2. Every COLLECTION/CARRIER_RENT row for this Challan that is
//      still isActive: true AND was created AT OR BEFORE that latest
//      Unsettle's timestamp is stale - reverseChallanSettlementEntries
//      reverses EVERY SETTLEMENT_NET_REFERENCE_TYPES entry in scope at
//      the moment it runs, so any row established by then was
//      necessarily swept into that reversal. A row created AFTER that
//      timestamp belongs to a legitimate later re-settle and is left
//      untouched.
//
// This naturally covers 6394/6446/6476 and any other Challan with the
// same history, regardless of whether it is currently settled or not
// (a Challan re-settled after an old-code Unsettle would otherwise
// carry stale rows forward indefinitely, alongside its fresh ones).
//
// Usage:
//   npx tsx scripts/fix-stale-settlement-payment-rows.ts
//   npx tsx scripts/fix-stale-settlement-payment-rows.ts --dry-run
//   npx tsx scripts/fix-stale-settlement-payment-rows.ts --apply --user=<username>
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface StaleRow {
  rowId: string;
  challanNo: string;
  biltyNo: string | null;
  component: string;
  payerAccountName: string;
  amount: number;
  rowCreatedAt: Date;
  lastUnsettleAt: Date;
}

async function scan(): Promise<StaleRow[]> {
  const challans = await prisma.challan.findMany({
    where: { isDeleted: false },
    select: { id: true, challanNo: true },
  });

  const stale: StaleRow[] = [];

  for (const challan of challans) {
    const biltyLinks = await prisma.challanBilty.findMany({
      where: { challanId: challan.id },
      select: { biltyId: true },
    });
    const referenceIds = [challan.id, ...biltyLinks.map((l) => l.biltyId)];

    const lastUnsettle = await prisma.journalEntry.findFirst({
      where: {
        referenceType: "SETTLEMENT_UNSETTLE_REVERSAL",
        referenceId: { in: referenceIds },
        isDeleted: false,
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (!lastUnsettle) continue; // never unsettled - nothing to fix.

    const activeRows = await prisma.settlementPayment.findMany({
      where: {
        challanId: challan.id,
        component: { in: ["COLLECTION", "CARRIER_RENT"] },
        isActive: true,
        createdAt: { lte: lastUnsettle.createdAt },
      },
      include: {
        payerAccount: { select: { accountName: true } },
        bilty: { select: { biltyNo: true } },
      },
    });

    for (const row of activeRows) {
      stale.push({
        rowId: row.id,
        challanNo: challan.challanNo,
        biltyNo: row.bilty?.biltyNo || null,
        component: row.component,
        payerAccountName: row.payerAccount.accountName,
        amount: Number(row.amount),
        rowCreatedAt: row.createdAt,
        lastUnsettleAt: lastUnsettle.createdAt,
      });
    }
  }

  return stale;
}

function printReport(rows: StaleRow[]) {
  console.log("=".repeat(100));
  console.log(`STALE SettlementPayment rows found (${rows.length}) - still isActive after an Unsettle that reversed them`);
  console.log("=".repeat(100));
  const byChallelan = new Map<string, StaleRow[]>();
  for (const r of rows) {
    const list = byChallelan.get(r.challanNo) || [];
    list.push(r);
    byChallelan.set(r.challanNo, list);
  }
  for (const [challanNo, group] of byChallelan) {
    console.log(`\nChallan ${challanNo}:`);
    for (const r of group) {
      const target = r.biltyNo ? `Bilty ${r.biltyNo}` : "Challan-level";
      console.log(
        `  [${r.component}] ${target} - Rs. ${fmtMoney(r.amount)} by "${r.payerAccountName}" - row created ${r.rowCreatedAt.toISOString().slice(0, 10)}, unsettled ${r.lastUnsettleAt.toISOString().slice(0, 10)}`
      );
    }
  }
  if (rows.length === 0) console.log("  (none)");
  console.log();
}

async function apply(rows: StaleRow[], username: string) {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true, username: true } });
  if (!user) {
    console.error(`No user found with username "${username}". Aborting - nothing was written.`);
    process.exit(1);
  }

  console.log("=".repeat(100));
  console.log(`DEACTIVATING ${rows.length} stale row(s) as user "${user.username}"...`);
  console.log("=".repeat(100));

  for (const r of rows) {
    const result = await prisma.settlementPayment.updateMany({
      where: { id: r.rowId, isActive: true },
      data: {
        isActive: false,
        deactivatedAt: new Date(),
        deactivatedById: user.id,
        deactivationReason: "Unsettled (historical - fixed retroactively)",
      },
    });
    if (result.count > 0) {
      console.log(`  DEACTIVATED Challan ${r.challanNo} [${r.component}] Rs. ${fmtMoney(r.amount)} by "${r.payerAccountName}"`);
    } else {
      console.log(`  SKIP Challan ${r.challanNo} [${r.component}]: already inactive (changed since scan?).`);
    }
  }
}

async function main() {
  const applyFlag = process.argv.includes("--apply");
  const username = arg("user");

  if (applyFlag && !username) {
    console.error("--apply requires --user=<username> (whoever is approving/posting this fix).");
    process.exit(1);
  }

  const rows = await scan();
  printReport(rows);

  if (applyFlag && username) {
    await apply(rows, username);
  } else {
    console.log(`Dry run only - ${rows.length} row(s) would be deactivated with --apply --user=<username>.`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
