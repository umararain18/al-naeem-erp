// READ-ONLY SCAN (default / --dry-run) + OPT-IN CORRECTION
// (--apply --user=<username>) for "the party on a document changed
// after it already had posted accounting entries, but the ledger
// still shows the OLD party" - the Bilty 4056 bug class.
//
// Scope (matches the reviewed/approved fix in
// lib/settlement-payments.ts's reassignPaidResponsibility()):
//
//   BILTY PAID        - fully scanned AND auto-correctable with
//                        --apply. Detection: for every Bilty with a
//                        PAID SettlementPayment row, every account
//                        (per getPaidAccountNetBalances()) OTHER than
//                        the row's current payerAccountId that still
//                        carries a non-zero PAID-tagged net balance is
//                        a stale, orphaned reclassification - exactly
//                        what a past buggy reassignment (row updated,
//                        no journal entry posted) leaves behind.
//                        Correction: calls reassignPaidResponsibility()
//                        itself is NOT reusable here (it early-returns
//                        when the row's payerAccountId already equals
//                        the "new" target - which it does, for exactly
//                        this already-broken-historical-case), so this
//                        script posts the same PAID_RESPONSIBILITY_
//                        REASSIGNMENT-tagged entry shape directly:
//                        Dr currentPayer / Cr staleAccount, amount =
//                        staleAccount's own net balance.
//
//   CHALLAN COLLECTION  - scanned for VISIBILITY ONLY, never corrected
//   CHALLAN CARRIER_RENT  by this script. No reassignCollectionResponsibility/
//                       reassignCarrierRentResponsibility mechanism
//                       exists anywhere in this codebase (confirmed by
//                       grep) - changing a Bilty's Clearing Agent or a
//                       Challan's Transporter after Settlement
//                       currently has ZERO accounting consequence at
//                       all (not even a stale-metadata symptom - the
//                       SettlementPayment row and the ledger both just
//                       silently keep pointing at whoever was
//                       responsible AT SETTLEMENT TIME forever).
//                       Detection here compares that row's
//                       payerAccountId against the document's CURRENT
//                       role-field party, purely diagnostic. This is a
//                       separate, more severe, FOLLOW-UP gap - not
//                       fixed in this PR per explicit scope decision.
//
//   PRIVATE PHONCH      - scanned for VISIBILITY ONLY. Already has its
//                       OWN "surgical reconciliation" mechanism
//                       (app/api/private-phonch/[id]/route.ts) that
//                       re-points existing JournalLines by role when a
//                       Transporter/Clearing Agent changes, AND rejects
//                       a Transporter-party change outright once that
//                       party already has a settled amount - so this
//                       section is expected to find 0 mismatches in a
//                       healthy database; included for completeness
//                       per the explicit request to cover all 3
//                       document types.
//
// Usage:
//   npx tsx scripts/scan-and-correct-party-mismatches.ts
//   npx tsx scripts/scan-and-correct-party-mismatches.ts --dry-run
//   npx tsx scripts/scan-and-correct-party-mismatches.ts --apply --user=<username>
// (reads DATABASE_URL from the environment exactly like the app
// itself. --apply only ever touches the BILTY PAID section above -
// Collection/Carrier Rent/Private Phonch findings are never written.)
import { PrismaClient } from "@prisma/client";
import { getPaidAccountNetBalances } from "../lib/settlement-payments";

const prisma = new PrismaClient();
const EPS = 0.01;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface Mismatch {
  docType: "BILTY_PAID" | "CHALLAN_COLLECTION" | "CHALLAN_CARRIER_RENT" | "PRIVATE_PHONCH";
  docNo: string;
  amount: number;
  oldPartyName: string;
  oldAccountId: string;
  newPartyName: string;
  newAccountId: string;
  correctable: boolean;
}

async function scanBiltyPaid(): Promise<Mismatch[]> {
  const rows = await prisma.settlementPayment.findMany({
    where: { component: "PAID" },
    include: {
      bilty: { select: { biltyNo: true } },
      payerAccount: { select: { id: true, accountName: true } },
    },
  });

  const mismatches: Mismatch[] = [];
  for (const row of rows) {
    if (!row.biltyId || !row.bilty) continue;
    const netBalances = await getPaidAccountNetBalances(prisma, row.biltyId);
    const staleEntries = [...netBalances.entries()].filter(
      ([accountId, net]) => accountId !== row.payerAccountId && net > EPS
    );
    if (staleEntries.length === 0) continue;

    const accountIds = staleEntries.map(([accountId]) => accountId);
    const staleAccounts = await prisma.account.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, accountName: true },
    });
    const nameById = new Map(staleAccounts.map((a) => [a.id, a.accountName]));

    for (const [accountId, net] of staleEntries) {
      mismatches.push({
        docType: "BILTY_PAID",
        docNo: row.bilty.biltyNo,
        amount: round2(net),
        oldPartyName: nameById.get(accountId) || "(unknown account)",
        oldAccountId: accountId,
        newPartyName: row.payerAccount.accountName,
        newAccountId: row.payerAccountId,
        correctable: true,
      });
    }
  }
  return mismatches;
}

async function scanChallanCollection(): Promise<Mismatch[]> {
  const rows = await prisma.settlementPayment.findMany({
    where: { component: "COLLECTION" },
    include: {
      bilty: {
        select: {
          biltyNo: true,
          clearingAgentParty: { select: { account: { select: { id: true, accountName: true } } } },
          consignorParty: { select: { account: { select: { id: true, accountName: true } } } },
          consigneeParty: { select: { account: { select: { id: true, accountName: true } } } },
        },
      },
      payerAccount: { select: { id: true, accountName: true } },
    },
  });

  const mismatches: Mismatch[] = [];
  for (const row of rows) {
    if (!row.bilty) continue;
    const currentDefault =
      row.bilty.clearingAgentParty?.account || row.bilty.consignorParty?.account || row.bilty.consigneeParty?.account || null;
    if (!currentDefault || currentDefault.id === row.payerAccountId) continue;

    mismatches.push({
      docType: "CHALLAN_COLLECTION",
      docNo: row.bilty.biltyNo,
      amount: round2(Number(row.amount)),
      oldPartyName: row.payerAccount.accountName,
      oldAccountId: row.payerAccountId,
      newPartyName: currentDefault.accountName,
      newAccountId: currentDefault.id,
      correctable: false,
    });
  }
  return mismatches;
}

async function scanChallanCarrierRent(): Promise<Mismatch[]> {
  const rows = await prisma.settlementPayment.findMany({
    where: { component: "CARRIER_RENT" },
    include: {
      challan: { select: { challanNo: true, transporterParty: { select: { account: { select: { id: true, accountName: true } } } } } },
      payerAccount: { select: { id: true, accountName: true } },
    },
  });

  const mismatches: Mismatch[] = [];
  for (const row of rows) {
    if (!row.challan) continue;
    const currentTransporterAccount = row.challan.transporterParty?.account;
    if (!currentTransporterAccount || currentTransporterAccount.id === row.payerAccountId) continue;

    mismatches.push({
      docType: "CHALLAN_CARRIER_RENT",
      docNo: row.challan.challanNo,
      amount: round2(Number(row.amount)),
      oldPartyName: row.payerAccount.accountName,
      oldAccountId: row.payerAccountId,
      newPartyName: currentTransporterAccount.accountName,
      newAccountId: currentTransporterAccount.id,
      correctable: false,
    });
  }
  return mismatches;
}

async function scanPrivatePhonch(): Promise<Mismatch[]> {
  const phonches = await prisma.privatePhonch.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      phonchNo: true,
      transporterParty: { select: { account: { select: { id: true, accountName: true } } } },
      vehicles: { select: { clearingAgentPartyId: true } },
    },
  });

  const mismatches: Mismatch[] = [];
  for (const phonch of phonches) {
    const lines = await prisma.journalLine.findMany({
      where: {
        sourceType: "PRIVATE_PHONCH",
        sourceId: phonch.id,
        journalEntry: { isDeleted: false },
        account: { category: "PARTY" },
      },
      select: { accountId: true, debit: true, credit: true, account: { select: { accountName: true } } },
    });
    if (lines.length === 0) continue;

    const eligibleAccountIds = new Set<string>();
    if (phonch.transporterParty?.account) eligibleAccountIds.add(phonch.transporterParty.account.id);
    const caPartyIds = [...new Set(phonch.vehicles.map((v) => v.clearingAgentPartyId).filter((id): id is string => !!id))];
    if (caPartyIds.length > 0) {
      const caAccounts = await prisma.account.findMany({ where: { partyId: { in: caPartyIds } }, select: { id: true } });
      for (const a of caAccounts) eligibleAccountIds.add(a.id);
    }

    const byAccount = new Map<string, { net: number; name: string }>();
    for (const line of lines) {
      const prior = byAccount.get(line.accountId)?.net || 0;
      byAccount.set(line.accountId, { net: round2(prior + Number(line.credit) - Number(line.debit)), name: line.account.accountName });
    }

    for (const [accountId, { net, name }] of byAccount) {
      if (eligibleAccountIds.has(accountId) || Math.abs(net) <= EPS) continue;
      mismatches.push({
        docType: "PRIVATE_PHONCH",
        docNo: phonch.phonchNo,
        amount: Math.abs(net),
        oldPartyName: name,
        oldAccountId: accountId,
        newPartyName: phonch.transporterParty?.account?.accountName || "(current Transporter has no account)",
        newAccountId: phonch.transporterParty?.account?.id || "",
        correctable: false,
      });
    }
  }
  return mismatches;
}

function printSection(title: string, mismatches: Mismatch[], note?: string) {
  console.log("=".repeat(100));
  console.log(`${title} (${mismatches.length} found)`);
  if (note) console.log(note);
  console.log("=".repeat(100));
  for (const m of mismatches) {
    console.log(
      `  ${m.docNo}: Rs. ${fmtMoney(m.amount)} stuck on "${m.oldPartyName}" -> should be on "${m.newPartyName}"` +
        (m.correctable ? "" : "  [NOT AUTO-CORRECTABLE - follow-up gap, no reclassification mechanism exists]")
    );
  }
  if (mismatches.length === 0) console.log("  (none)");
  console.log();
}

async function applyBiltyPaidCorrections(mismatches: Mismatch[], username: string) {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true, username: true } });
  if (!user) {
    console.error(`No user found with username "${username}". Aborting - nothing was written.`);
    process.exit(1);
  }

  console.log("=".repeat(100));
  console.log(`APPLYING ${mismatches.length} BILTY PAID correction(s) as user "${user.username}"...`);
  console.log("=".repeat(100));

  for (const m of mismatches) {
    const bilty = await prisma.bilty.findUnique({ where: { biltyNo: m.docNo }, select: { id: true, biltyNo: true } });
    if (!bilty) {
      console.log(`  SKIP ${m.docNo}: Bilty not found (deleted since scan?).`);
      continue;
    }
    await prisma.$transaction(async (tx) => {
      // Re-read live, inside the transaction, immediately before
      // writing - never trust the scan's own earlier snapshot for the
      // amount actually posted.
      const netBalances = await getPaidAccountNetBalances(tx, bilty.id);
      const remaining = round2(Math.max(0, netBalances.get(m.oldAccountId) || 0));
      if (remaining <= EPS) {
        console.log(`  SKIP ${m.docNo}: "${m.oldPartyName}"'s balance is already 0 (corrected since scan?).`);
        return;
      }
      const description = `Party Change Correction - Bilty ${bilty.biltyNo} - Party changed from "${m.oldPartyName}" to "${m.newPartyName}"`;
      await tx.journalEntry.create({
        data: {
          entryDate: new Date(),
          referenceType: "PAID_RESPONSIBILITY_REASSIGNMENT",
          referenceId: bilty.id,
          description,
          createdById: user.id,
          lines: {
            create: [
              { accountId: m.newAccountId, debit: remaining, credit: 0, description, sourceType: "BILTY", sourceId: bilty.id, sourceNumber: bilty.biltyNo },
              { accountId: m.oldAccountId, debit: 0, credit: remaining, description, sourceType: "BILTY", sourceId: bilty.id, sourceNumber: bilty.biltyNo },
            ],
          },
        },
      });
      console.log(`  POSTED ${m.docNo}: Dr "${m.newPartyName}" / Cr "${m.oldPartyName}" Rs. ${fmtMoney(remaining)}`);
    });
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const username = arg("user");

  if (apply && !username) {
    console.error("--apply requires --user=<username> (whoever is approving/posting this correction).");
    process.exit(1);
  }

  const [biltyPaid, challanCollection, challanCarrierRent, privatePhonch] = await Promise.all([
    scanBiltyPaid(),
    scanChallanCollection(),
    scanChallanCarrierRent(),
    scanPrivatePhonch(),
  ]);

  printSection("BILTY PAID mismatches - auto-correctable", biltyPaid);
  printSection(
    "CHALLAN COLLECTION mismatches - diagnostic only",
    challanCollection,
    "No reassignCollectionResponsibility mechanism exists in this codebase (follow-up gap, not fixed here)."
  );
  printSection(
    "CHALLAN CARRIER_RENT mismatches - diagnostic only",
    challanCarrierRent,
    "No reassignCarrierRentResponsibility mechanism exists in this codebase (follow-up gap, not fixed here)."
  );
  printSection(
    "PRIVATE PHONCH mismatches - diagnostic only",
    privatePhonch,
    "Private Phonch already has its own party-change reconciliation + settled-amount guard - expected to be empty."
  );

  if (apply && username) {
    await applyBiltyPaidCorrections(biltyPaid, username);
  } else {
    console.log(`Dry run only - ${biltyPaid.length} Bilty Paid correction(s) would be posted with --apply --user=<username>.`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
