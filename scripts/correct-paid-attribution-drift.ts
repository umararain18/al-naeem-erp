// Corrects every Bilty whose Paid-component ATTRIBUTION layer has
// drifted away from its own correct, ledger-true target - the exact
// pattern found in production Challan 6405 (Bilty 395, DS Motors) and
// 6504 (Bilty 4164, MWT -> Zam Zam): Unsettle reversed a Paid
// establishment at the ledger level without updating the
// SettlementPayment row that described it, so every downstream reader
// that trusted the row's own existence/isActive flag (reassignPaidResponsibility,
// Finalize Settlement's own "already established" check) kept acting
// as if it were still live - releasing a credit with no live debit
// behind it, or never re-establishing one at all. See lib/paid-
// attribution.ts's own header comment for the full mechanism this
// fixes on the READ side; this script fixes the historical WRITE-side
// damage that already happened before that fix existed.
//
// THE RULE (never guessed, same resolution
// resolveBiltyPaidResponsibleParty() already uses everywhere else):
//   - The CURRENTLY resolved Paid-responsible party's own ledger-true
//     Paid-component attribution (lib/paid-attribution.ts's
//     getPaidAccountNetBalances) should equal this Bilty's own
//     CURRENT advance - exactly what "establish" always intends,
//     regardless of how much has separately been verified via Daily
//     Posting (verification is a later, independent layer - never
//     touched here).
//   - EVERY OTHER account currently holding a non-zero Paid-component
//     attribution for this Bilty (a stale party from before a
//     reassignment, or before Bilty.advance was later corrected down)
//     should hold 0.
//   - A Bilty whose Paid-responsible party is NOT resolvable at all
//     (never guessed) has every account's own target set to 0 - its
//     Paid amount is released back to Gross, same as it would be if
//     establishment had simply never been attempted.
// One balanced correction entry per flagged Bilty: a line per account
// needing correction (Dr to increase their attribution, Cr to
// decrease it), with Gross Bilty Receivable as the exact offsetting
// leg - tagged sourceType:"BILTY"/sourceId/sourceNumber and
// referenceType "SETTLEMENT_PAYMENT_CORRECTION"/referenceId:biltyId,
// the SAME convention every other Paid-component correction already
// uses (so lib/paid-attribution.ts's own ledger-true read picks it up
// correctly afterward too). NEVER touches Bilty.advance, Bilty.
// paidResponsiblePartyId, any Daily Posting, or any Collection/Carrier
// Rent entry - Paid-component attribution only.
//
// DEFAULT (no flag): DRY-RUN. Per flagged Bilty: challan/bilty
// reference, resolved party, advance, and every affected account's
// own before -> after. No writes.
// --apply: writes the correction entries (after taking a database
// backup). Requires --user=<username> to attribute the AuditLog rows
// (defaults to the first active SUPER_ADMIN).
// --only=<biltyNo1>,<biltyNo2>: scope the scan to specific Bilty
// numbers (e.g. --only=395,4164) instead of every Bilty in the
// database - useful to review 6405/6504 specifically before the full
// scan's own, potentially longer, list.
//
// Usage:
//   npx tsx scripts/correct-paid-attribution-drift.ts                                  (dry-run, every Bilty)
//   npx tsx scripts/correct-paid-attribution-drift.ts --only=395,4164                   (dry-run, just these)
//   npx tsx scripts/correct-paid-attribution-drift.ts --apply --user=umar                (writes, every flagged Bilty)

import { PrismaClient } from "@prisma/client";
import { getPaidAccountNetBalances } from "../lib/paid-attribution";
import { resolveBiltyPaidResponsibleParty } from "../lib/document-party-resolution";
import { getGrossBiltyReceivableAccountId } from "../lib/gross-accounts";
import { auditUpdate, actorFromUser } from "../lib/audit-log";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const userArg = process.argv.find((a) => a.startsWith("--user="));
const requestedUsername = userArg ? userArg.slice("--user=".length) : null;
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const onlyBiltyNos = onlyArg ? onlyArg.slice("--only=".length).split(",").map((s) => s.trim()) : null;

const EPS = 0.009;
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function resolveActor() {
  const user = requestedUsername
    ? await prisma.user.findFirst({ where: { username: requestedUsername, isActive: true } })
    : await prisma.user.findFirst({ where: { role: "SUPER_ADMIN", isActive: true }, orderBy: { createdAt: "asc" } });
  if (!user) {
    throw new Error(requestedUsername ? `No active user found with username "${requestedUsername}".` : "No active SUPER_ADMIN user found - pass --user=<username> explicitly.");
  }
  return user;
}

type Correction = { accountId: string; accountName: string; before: number; after: number; delta: number };
type Flagged = {
  biltyId: string;
  biltyNo: string;
  advance: number;
  resolvedPartyName: string | null;
  corrections: Correction[];
  grossBefore: number;
  grossAfter: number;
};

async function planForBilty(biltyId: string, biltyNo: string, advance: number, grossAccountId: string): Promise<Flagged | null> {
  const resolved = await resolveBiltyPaidResponsibleParty(biltyId, prisma);
  const netBalances = await getPaidAccountNetBalances(prisma, biltyId);
  // Gross Bilty Receivable is EVERY Paid-component entry's own
  // structural counter-leg (Dr party / Cr Gross), never a "party" to
  // target at 0 in its own right - its own balance is a RESULT of
  // the per-party corrections below, computed separately as the
  // offsetting leg (deltaSum), never an independent correction target.
  netBalances.delete(grossAccountId);

  const targetByAccount = new Map<string, number>();
  for (const accountId of netBalances.keys()) targetByAccount.set(accountId, 0);
  if (resolved) targetByAccount.set(resolved.accountId, advance);

  const affectedAccountIds = new Set<string>([...netBalances.keys(), ...(resolved ? [resolved.accountId] : [])]);
  const corrections: Correction[] = [];
  let deltaSum = 0;

  for (const accountId of affectedAccountIds) {
    const before = round2(netBalances.get(accountId) || 0);
    const after = round2(targetByAccount.get(accountId) ?? 0);
    const delta = round2(after - before);
    if (Math.abs(delta) <= EPS) continue;
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: { accountName: true } });
    corrections.push({ accountId, accountName: account?.accountName || accountId, before, after, delta });
    deltaSum = round2(deltaSum + delta);
  }

  if (corrections.length === 0) return null;

  const grossAgg = await prisma.journalLine.aggregate({
    where: { accountId: grossAccountId, sourceType: "BILTY", sourceId: biltyId, journalEntry: { isDeleted: false } },
    _sum: { debit: true, credit: true },
  });
  const grossBefore = round2(Number(grossAgg._sum.debit || 0) - Number(grossAgg._sum.credit || 0));
  const grossAfter = round2(grossBefore - deltaSum); // Gross is the exact offsetting leg

  return {
    biltyId,
    biltyNo,
    advance,
    resolvedPartyName: resolved?.partyName || null,
    corrections,
    grossBefore,
    grossAfter,
  };
}

async function main() {
  const grossAccountId = await getGrossBiltyReceivableAccountId(prisma);

  const bilties = await prisma.bilty.findMany({
    where: { isDeleted: false, advance: { gt: 0 }, ...(onlyBiltyNos ? { biltyNo: { in: onlyBiltyNos } } : {}) },
    select: { id: true, biltyNo: true, advance: true },
    orderBy: { biltyNo: "asc" },
  });

  console.log(`Scanning ${bilties.length} Bilty(s) with a Paid amount${onlyBiltyNos ? ` (--only=${onlyBiltyNos.join(",")})` : ""}...\n`);

  const flagged: Flagged[] = [];
  for (const bilty of bilties) {
    const plan = await planForBilty(bilty.id, bilty.biltyNo, round2(Number(bilty.advance)), grossAccountId);
    if (plan) flagged.push(plan);
  }

  console.log(`Found ${flagged.length} Bilty(s) with a Paid-attribution drift:\n`);
  for (const f of flagged) {
    console.log(`  Bilty ${f.biltyNo} (${f.biltyId}) - advance Rs. ${f.advance.toLocaleString()}, resolved Paid party: ${f.resolvedPartyName || "(unresolvable)"}`);
    for (const c of f.corrections) {
      console.log(`    ${c.accountName}: ${c.before.toLocaleString()} -> ${c.after.toLocaleString()} (${c.delta >= 0 ? "+" : ""}${c.delta.toLocaleString()})`);
    }
    console.log(`    Gross Bilty Receivable (this Bilty's own tagged balance): ${f.grossBefore.toLocaleString()} -> ${f.grossAfter.toLocaleString()}\n`);
  }

  if (flagged.length === 0) {
    console.log("Nothing to correct.");
    await prisma.$disconnect();
    return;
  }

  if (!apply) {
    console.log("DRY RUN - no changes made. Re-run with --apply --user=<username> (after taking a database backup) to write these corrections.");
    await prisma.$disconnect();
    return;
  }

  const actorUser = await resolveActor();
  const actor = actorFromUser({ userId: actorUser.id, username: actorUser.username, role: actorUser.role });

  let applied = 0;
  for (const f of flagged) {
    await prisma.$transaction(async (tx) => {
      const description = `Paid Attribution Correction - Bilty ${f.biltyNo} - ${f.corrections.map((c) => `${c.accountName} ${c.before.toLocaleString()} -> ${c.after.toLocaleString()}`).join("; ")}`;
      const deltaSum = round2(f.corrections.reduce((s, c) => s + c.delta, 0));
      const lines = f.corrections.map((c) => ({
        accountId: c.accountId,
        debit: c.delta > 0 ? Math.abs(c.delta) : 0,
        credit: c.delta < 0 ? Math.abs(c.delta) : 0,
        description,
        sourceType: "BILTY" as const,
        sourceId: f.biltyId,
        sourceNumber: f.biltyNo,
      }));
      lines.push({
        accountId: grossAccountId,
        debit: deltaSum < 0 ? Math.abs(deltaSum) : 0,
        credit: deltaSum > 0 ? Math.abs(deltaSum) : 0,
        description,
        sourceType: "BILTY" as const,
        sourceId: f.biltyId,
        sourceNumber: f.biltyNo,
      });

      const entry = await tx.journalEntry.create({
        data: {
          entryDate: new Date(),
          referenceType: "SETTLEMENT_PAYMENT_CORRECTION",
          referenceId: f.biltyId,
          description,
          createdById: actorUser.id,
          lines: { create: lines },
        },
      });

      await auditUpdate(tx, {
        actor,
        module: "SETTLEMENT",
        entityType: "JournalEntry",
        entityId: entry.id,
        documentNo: f.biltyNo,
        description: `Corrected Paid-attribution drift for Bilty ${f.biltyNo} via scripts/correct-paid-attribution-drift.ts`,
        oldValues: Object.fromEntries(f.corrections.map((c) => [c.accountName, c.before])),
        newValues: Object.fromEntries(f.corrections.map((c) => [c.accountName, c.after])),
      });
    });
    applied++;
  }

  console.log(`\nAPPLIED: ${applied} correction entr(y/ies) posted, attributed to user "${actorUser.username}".`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
