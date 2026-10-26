// --dry-run (default) / --apply --user=<username> correction for the
// over-reversed Challans scripts/scan-double-reversed-settlements.ts
// finds (run that script first - this one reuses its exact scan()).
//
// For each EXCESS reversal entry (one that reversed an already-fully-
// reversed original a second+ time - see that script's own doc
// comment for the detection), posts ONE new, append-only correcting
// JournalEntry per excess reversal - same lines as the ORIGINAL
// entry's own shape (restoring what the excess reversal wrongly
// subtracted a second time), tagged referenceType
// "SETTLEMENT_OVER_REVERSAL_CORRECTION", reversesEntryId pointing at
// the SPECIFIC excess reversal entry it corrects (an accurate reuse
// of that field - "cancels the effect of" - not just "same shape
// as"). Never deletes or edits any existing JournalEntry/JournalLine;
// every original and every (including excess) reversal entry stays
// exactly as posted, forever - this only ever ADDS new rows.
//
// "SETTLEMENT_OVER_REVERSAL_CORRECTION" is in SETTLEMENT_NET_
// REFERENCE_TYPES (lib/settlement-correction.ts) so it is correctly
// picked up by getPartyNetFromSettlement()'s running total AND by a
// future Unsettle on the same Challan, exactly like every other
// forward-posting type already is.
//
// Usage:
//   npx tsx scripts/correct-double-reversed-settlements.ts
//   npx tsx scripts/correct-double-reversed-settlements.ts --dry-run
//   npx tsx scripts/correct-double-reversed-settlements.ts --apply --user=<username>
import { PrismaClient } from "@prisma/client";
import { scan, type ExcessReversal } from "./scan-double-reversed-settlements";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function fmtMoney(n: number): string {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printPlan(results: ExcessReversal[]) {
  console.log("=".repeat(100));
  console.log(`Proposed correcting entries: ${results.reduce((s, r) => s + r.excessCount, 0)}`);
  console.log("=".repeat(100));
  for (const r of results) {
    if (!r.sampleForwardEntry) {
      console.log(
        `\nreferenceId=${r.referenceId}: ${r.excessCount} excess reversal(s) found, but NO original of this shape exists at all ` +
          `(the shape itself may be a reversal-of-a-reversal with no real original left) - SKIPPED, cannot safely construct a correcting entry without a real shape to restore. Needs manual review.`
      );
      continue;
    }
    console.log(`\nreferenceId=${r.referenceId} (Challan ${r.challanNo ?? "unresolved - see description"}):`);
    for (const excess of r.excessReversalEntries) {
      console.log(`  Correcting excess reversal ${excess.id} (${excess.createdAt.toISOString().slice(0, 10)}) - would post:`);
      for (const l of r.sampleForwardEntry.lines) {
        console.log(`    accountId=${l.accountId} Dr ${fmtMoney(Number(l.debit))} / Cr ${fmtMoney(Number(l.credit))}`);
      }
    }
  }
  if (results.length === 0) console.log("  (none - nothing to correct)");
  console.log();
}

async function apply(results: ExcessReversal[], username: string) {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true, username: true } });
  if (!user) {
    console.error(`No user found with username "${username}". Aborting - nothing was written.`);
    process.exit(1);
  }

  console.log("=".repeat(100));
  console.log(`APPLYING correcting entries as user "${user.username}"...`);
  console.log("=".repeat(100));

  for (const r of results) {
    if (!r.sampleForwardEntry) {
      console.log(`  SKIP referenceId=${r.referenceId}: no original shape to restore - needs manual review.`);
      continue;
    }
    for (const excess of r.excessReversalEntries) {
      // Re-check immediately before posting, inside this same
      // transaction - never trust the earlier scan() snapshot for
      // whether this excess reversal has already been corrected
      // since (e.g. by a previous, partially-applied run of this
      // same script).
      await prisma.$transaction(async (tx) => {
        const alreadyCorrected = await tx.journalEntry.findFirst({
          where: { reversesEntryId: excess.id, referenceType: "SETTLEMENT_OVER_REVERSAL_CORRECTION", isDeleted: false },
          select: { id: true },
        });
        if (alreadyCorrected) {
          console.log(`  SKIP excess=${excess.id}: already corrected by ${alreadyCorrected.id}.`);
          return;
        }

        const description = `Over-Reversal Correction - ${r.challanNo ?? r.referenceId} - restoring original effect wrongly removed a 2nd time by Unsettle reversal ${excess.id}`;
        const created = await tx.journalEntry.create({
          data: {
            entryDate: new Date(),
            referenceType: "SETTLEMENT_OVER_REVERSAL_CORRECTION",
            referenceId: r.referenceId,
            reversesEntryId: excess.id,
            description,
            createdById: user.id,
            lines: {
              create: r.sampleForwardEntry!.lines.map((l) => ({
                accountId: l.accountId,
                debit: l.debit,
                credit: l.credit,
                description,
                sourceType: l.sourceType,
                sourceId: l.sourceId,
                sourceNumber: l.sourceNumber,
              })),
            },
          },
        });
        console.log(`  POSTED ${created.id} correcting excess reversal ${excess.id} (referenceId=${r.referenceId}).`);
      });
    }
  }
}

async function main() {
  const applyFlag = process.argv.includes("--apply");
  const username = arg("user");

  if (applyFlag && !username) {
    console.error("--apply requires --user=<username> (whoever is approving/posting this correction).");
    process.exit(1);
  }

  const results = await scan();
  printPlan(results);

  if (applyFlag && username) {
    await apply(results, username);
  } else {
    const count = results.reduce((s, r) => s + (r.sampleForwardEntry ? r.excessCount : 0), 0);
    console.log(`Dry run only - ${count} correcting entry(ies) would be posted with --apply --user=<username>.`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
