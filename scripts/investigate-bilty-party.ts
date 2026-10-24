// READ-ONLY INVESTIGATION - no writes, ever. Safe to run against
// production.
//
// Dumps everything relevant to diagnosing "the party on a Bilty
// changed after it already had posted accounting entries, but the
// ledger still shows the OLD party" (the Bilty 4056 bug report):
//
//   1. The Bilty's own current fields (consignor/consignee/clearing
//      agent/paid-responsible party, advance/toPay amounts) plus its
//      owning Challan.
//   2. Every JournalLine tagged sourceType "BILTY" sourceId=<this
//      Bilty>, OR tagged "CHALLAN" sourceId=<its Challan> - i.e. every
//      posted line this document (or its Challan's settlement) has
//      ever touched - each with its JournalEntry's referenceType/
//      referenceId/date/isDeleted, the account/party name, and
//      debit/credit. This is the full history: BILTY_BOOKING,
//      SETTLEMENT_PAYMENT (+ _CORRECTION/_REVERSAL),
//      PAID_RESPONSIBILITY_REASSIGNMENT, DAILY_POSTING receipts,
//      SETTLEMENT/SETTLEMENT_CORRECTION/SETTLEMENT_UNSETTLE_REVERSAL
//      (via the Challan side), all in one chronological list.
//   3. The SettlementPayment rows (PAID/COLLECTION) for this Bilty,
//      each with its current payerAccountId/party name.
//   4. The Bilty's AuditLog history (every field-level edit ever
//      recorded for it, oldest first).
//
// Usage:
//   npx tsx scripts/investigate-bilty-party.ts --bilty=4056
// (reads DATABASE_URL from the environment exactly like the app
// itself; --bilty is the human-facing biltyNo, not the cuid.)
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  const biltyNo = arg("bilty");
  if (!biltyNo) {
    console.error("Usage: npx tsx scripts/investigate-bilty-party.ts --bilty=<biltyNo>");
    process.exit(1);
  }

  const bilty = await prisma.bilty.findUnique({
    where: { biltyNo },
    include: {
      consignorParty: { select: { partyName: true } },
      consigneeParty: { select: { partyName: true } },
      clearingAgentParty: { select: { partyName: true } },
      paidResponsibleParty: { select: { partyName: true } },
      agentParty: { select: { partyName: true } },
      challanBilties: {
        select: { challan: { select: { id: true, challanNo: true, transporterParty: { select: { partyName: true } } } } },
      },
    },
  });

  if (!bilty) {
    console.log(`No Bilty found with biltyNo "${biltyNo}" in this database.`);
    console.log("(Expected for production-only Bilty numbers - this script must then be run against production by the user.)");
    await prisma.$disconnect();
    return;
  }

  console.log("=".repeat(100));
  console.log(`BILTY ${bilty.biltyNo} (id ${bilty.id})${bilty.isDeleted ? " [IN BIN]" : ""}`);
  console.log("=".repeat(100));
  console.log(`Date:            ${fmtDate(bilty.date)}`);
  console.log(`Consignor:       ${bilty.consignorName} ${bilty.consignorParty ? `(Party: ${bilty.consignorParty.partyName})` : "(no linked Party)"}`);
  console.log(`Consignee:       ${bilty.consigneeName} ${bilty.consigneeParty ? `(Party: ${bilty.consigneeParty.partyName})` : "(no linked Party)"}`);
  console.log(`Clearing Agent:  ${bilty.clearingAgentName || "(none)"} ${bilty.clearingAgentParty ? `(Party: ${bilty.clearingAgentParty.partyName})` : ""}`);
  console.log(`Paid Responsible (explicit field): ${bilty.paidResponsibleParty?.partyName || "(null - auto-resolved on read)"}`);
  console.log(`Rent: ${fmtMoney(Number(bilty.rent))}  Total: ${fmtMoney(Number(bilty.total))}  Advance(Paid): ${fmtMoney(Number(bilty.advance))}  ToPay: ${fmtMoney(Number(bilty.toPay))}`);
  const challans = bilty.challanBilties.map((cb) => cb.challan);
  console.log(
    `Challan(s): ${
      challans.length > 0
        ? challans.map((c) => `${c.challanNo} (Transporter: ${c.transporterParty?.partyName || "(none)"})`).join(", ")
        : "(not yet assigned to a Challan)"
    }`
  );
  console.log();

  // ----------------------------------------------------------------
  // SettlementPayment rows for this Bilty (PAID + COLLECTION)
  // ----------------------------------------------------------------
  const settlementPayments = await prisma.settlementPayment.findMany({
    where: { biltyId: bilty.id },
    include: { payerAccount: { select: { accountName: true, partyId: true } } },
    orderBy: { createdAt: "asc" },
  });

  console.log("-".repeat(100));
  console.log(`SettlementPayment rows for this Bilty (${settlementPayments.length}):`);
  console.log("-".repeat(100));
  for (const sp of settlementPayments) {
    console.log(
      `  [${sp.component}] amount=${fmtMoney(Number(sp.amount))}  payer="${sp.payerAccount.accountName}"  journalEntryId=${sp.journalEntryId}  createdAt=${fmtDate(sp.createdAt)}`
    );
  }
  if (settlementPayments.length === 0) console.log("  (none)");
  console.log();

  // ----------------------------------------------------------------
  // Every JournalLine tagged to this Bilty directly, OR to its
  // Challan (covers SETTLEMENT/SETTLEMENT_CORRECTION/
  // SETTLEMENT_UNSETTLE_REVERSAL entries, which are tagged
  // sourceType "CHALLAN" / sourceId=<challanId>, not the Bilty).
  // ----------------------------------------------------------------
  const sourceFilters: Array<{ sourceType: string; sourceId: string }> = [{ sourceType: "BILTY", sourceId: bilty.id }];
  for (const c of challans) sourceFilters.push({ sourceType: "CHALLAN", sourceId: c.id });

  const lines = await prisma.journalLine.findMany({
    where: { OR: sourceFilters },
    include: {
      account: { select: { accountName: true, category: true, partyId: true } },
      journalEntry: { select: { entryDate: true, referenceType: true, referenceId: true, description: true, isDeleted: true, deletedAt: true, createdAt: true } },
    },
    orderBy: [{ journalEntry: { entryDate: "asc" } }, { createdAt: "asc" }],
  });

  console.log("-".repeat(100));
  console.log(`Posted JournalLines touching this Bilty or its Challan (${lines.length}), chronological:`);
  console.log("-".repeat(100));
  for (const l of lines) {
    const je = l.journalEntry;
    const flag = je.isDeleted ? "  [DELETED]" : "";
    const dc = Number(l.debit) > 0 ? `DEBIT  ${fmtMoney(Number(l.debit))}` : `CREDIT ${fmtMoney(Number(l.credit))}`;
    console.log(
      `  ${fmtDate(je.entryDate)}  [${je.referenceType ?? "(no referenceType)"}${je.referenceId ? ` ref=${je.referenceId}` : ""}]  ${l.sourceType}/${l.sourceId === bilty.id ? "this Bilty" : l.sourceId}  "${l.account.accountName}"  ${dc}${flag}`
    );
    if (l.description) console.log(`      ${l.description}`);
  }
  if (lines.length === 0) console.log("  (none)");
  console.log();

  // ----------------------------------------------------------------
  // Daily Posting receipts specifically (referenceType DAILY_POSTING)
  // against this Bilty - the actual cash/bank receipt side.
  // ----------------------------------------------------------------
  const dailyPostingLines = lines.filter((l) => l.journalEntry.referenceType === "DAILY_POSTING");
  console.log("-".repeat(100));
  console.log(`Daily Posting receipts/payments against this Bilty (${dailyPostingLines.length}):`);
  console.log("-".repeat(100));
  for (const l of dailyPostingLines) {
    const dc = Number(l.debit) > 0 ? `DEBIT  ${fmtMoney(Number(l.debit))}` : `CREDIT ${fmtMoney(Number(l.credit))}`;
    console.log(`  ${fmtDate(l.journalEntry.entryDate)}  "${l.account.accountName}"  ${dc}${l.journalEntry.isDeleted ? "  [DELETED]" : ""}`);
  }
  if (dailyPostingLines.length === 0) console.log("  (none)");
  console.log();

  // ----------------------------------------------------------------
  // Audit log history for this Bilty (field-level edits)
  // ----------------------------------------------------------------
  const auditRows = await prisma.auditLog.findMany({
    where: { entityType: "Bilty", entityId: bilty.id },
    orderBy: { createdAt: "asc" },
  });

  console.log("-".repeat(100));
  console.log(`AuditLog history for this Bilty (${auditRows.length} entries), chronological:`);
  console.log("-".repeat(100));
  for (const row of auditRows) {
    console.log(`  ${row.createdAt.toISOString()}  [${row.action}] by ${row.userNameSnapshot ?? "(unknown)"}`);
    console.log(`      ${row.description}`);
    if (row.changedFields && typeof row.changedFields === "object") {
      for (const [field, change] of Object.entries(row.changedFields as Record<string, { old: unknown; new: unknown }>)) {
        console.log(`        ${field}: ${JSON.stringify(change.old)} -> ${JSON.stringify(change.new)}`);
      }
    }
  }
  if (auditRows.length === 0) console.log("  (none - no recorded edits, or this Bilty predates the audit log)");
  console.log();

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
