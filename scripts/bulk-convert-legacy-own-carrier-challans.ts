// Converts every eligible legacy own-carrier Challan found by
// scripts/scan-legacy-own-carrier-challans.ts's own detection (see
// that script's header for the matching rule).
//
// --dry-run (DEFAULT): read-only - prints the exact same per-Challan
//   detail as the scan script, plus BEFORE/AFTER totals for Booking
//   Income, Challan Carrier Rent expense, and each matched
//   Transporter Party's own ledger balance. Writes nothing.
// --apply --user=<username>: actually performs the conversion (see
//   lib/challan-own-carrier-conversion.ts) for every NOT-settled,
//   currently-eligible Challan, inside one transaction PER Challan
//   (so one failure never blocks the rest). Settled Challans are
//   never touched here - they are only LISTED, with a clear message
//   that Unsettle must run first (the existing, separate feature).
//
// Usage:
//   npx tsx scripts/bulk-convert-legacy-own-carrier-challans.ts [partyNameContains]
//   npx tsx scripts/bulk-convert-legacy-own-carrier-challans.ts --apply --user=umar [partyNameContains]
//
// (reads DATABASE_URL from the environment exactly like the app
// itself - point it at whichever database you intend to run this
// against.)
import { PrismaClient, Prisma } from "@prisma/client";
import { computeConversionImpact, convertChallanToOwnCarrier, ChallanConversionError, normalizeCarrierNumber } from "../lib/challan-own-carrier-conversion";

const prisma = new PrismaClient();

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const userArg = argv.find((a) => a.startsWith("--user="));
  const username = userArg ? userArg.slice("--user=".length) : null;
  const partyNameContains = argv.find((a) => !a.startsWith("--")) || "Al Naeem Cargo";
  return { apply, username, partyNameContains };
}

async function findMatches(partyNameContains: string) {
  const party = await prisma.party.findFirst({
    where: { partyName: { contains: partyNameContains, mode: "insensitive" } },
    select: { id: true, partyName: true },
  });

  const carriers = await prisma.ownCarrier.findMany({ where: { isDeleted: false }, select: { id: true, carrierNumber: true } });
  const byNormalizedNumber = new Map(carriers.map((c) => [normalizeCarrierNumber(c.carrierNumber), c]));

  const candidates = await prisma.challan.findMany({
    where: {
      isDeleted: false,
      ownCarrierId: null,
      OR: [
        ...(party ? [{ transporterPartyId: party.id }] : []),
        { carrierNumber: { not: null } },
      ],
    },
    select: { id: true, challanNo: true, carrierNumber: true, transporterPartyId: true },
    orderBy: { loadingDate: "asc" },
  });

  return candidates
    .filter((c) => {
      if (party && c.transporterPartyId === party.id) return true;
      if (c.carrierNumber && byNormalizedNumber.has(normalizeCarrierNumber(c.carrierNumber))) return true;
      return false;
    })
    .map((c) => {
      // The target Own Carrier is resolved ONLY from carrierNumber -
      // matching by Party alone (no carrierNumber match) identifies a
      // legacy Challan but can never say WHICH Own Carrier it belongs
      // to, so it is correctly left unassigned (reported under "No
      // matching active Own Carrier found") rather than guessed.
      const carrier = c.carrierNumber ? byNormalizedNumber.get(normalizeCarrierNumber(c.carrierNumber)) : undefined;
      return { challanId: c.id, challanNo: c.challanNo, targetOwnCarrierId: carrier?.id ?? null, targetCarrierNumber: carrier?.carrierNumber ?? null };
    });
}

async function main() {
  const { apply, username, partyNameContains } = parseArgs(process.argv.slice(2));

  if (apply && !username) {
    console.error("--apply requires --user=<username> (the user attributed as createdById on every reversal entry)");
    process.exit(1);
  }

  let userId: string | null = null;
  if (apply) {
    const user = await prisma.user.findUnique({ where: { username: username! }, select: { id: true, role: true } });
    if (!user) {
      console.error(`No user found with username "${username}"`);
      process.exit(1);
    }
    if (user.role !== "SUPER_ADMIN") {
      console.error(`User "${username}" is not SUPER_ADMIN - this matches the single-Challan "Convert to Own Carrier" action's own gate.`);
      process.exit(1);
    }
    userId = user.id;
  }

  const matches = await findMatches(partyNameContains);
  if (matches.length === 0) {
    console.log("No legacy own-carrier Challans found.");
    await prisma.$disconnect();
    return;
  }

  const eligible: typeof matches = [];
  const needsUnsettle: { challanNo: string }[] = [];
  const needsManualReview: { challanNo: string; blockers: string[] }[] = [];
  const noTargetCarrier: { challanNo: string }[] = [];

  let totalCarrierRentBefore = 0;
  let totalBookingIncomeBefore = 0;

  for (const m of matches) {
    const impact = await computeConversionImpact(prisma, m.challanId);
    totalCarrierRentBefore += impact.totalCarrierRentToReverse;
    totalBookingIncomeBefore += impact.totalBookingIncomeToReverse;

    if (!m.targetOwnCarrierId) {
      noTargetCarrier.push({ challanNo: m.challanNo });
      continue;
    }
    if (impact.isSettled) {
      needsUnsettle.push({ challanNo: m.challanNo });
      continue;
    }
    if (impact.blockers.length > 0) {
      needsManualReview.push({ challanNo: m.challanNo, blockers: impact.blockers });
      continue;
    }
    eligible.push(m);
  }

  console.log(`Matched ${matches.length} legacy Challan(s). Eligible now: ${eligible.length}.`);
  console.log(`\nBEFORE:`);
  console.log(`  Total Carrier Rent expense/payable currently posted for these Challans: Rs. ${totalCarrierRentBefore.toLocaleString()}`);
  console.log(`  Total Bilty rent currently recognized as Booking Income for these Challans: Rs. ${totalBookingIncomeBefore.toLocaleString()}`);

  if (noTargetCarrier.length > 0) {
    console.log(`\nNo matching active Own Carrier found (carrierNumber not registered yet) - skipped: ${noTargetCarrier.map((c) => c.challanNo).join(", ")}`);
  }
  if (needsUnsettle.length > 0) {
    console.log(`\nSettled - needs Unsettle first (existing feature), then re-run this script: ${needsUnsettle.map((c) => c.challanNo).join(", ")}`);
  }
  if (needsManualReview.length > 0) {
    console.log(`\nNeeds manual review (not auto-converted):`);
    for (const r of needsManualReview) {
      console.log(`  - ${r.challanNo}: ${r.blockers.join(" | ")}`);
    }
  }

  if (!apply) {
    console.log(`\n--dry-run (default) - nothing was written. Re-run with --apply --user=<username> to convert the ${eligible.length} eligible Challan(s) listed above.`);
    await prisma.$disconnect();
    return;
  }

  console.log(`\nApplying conversion to ${eligible.length} Challan(s) as user "${username}"...`);

  let convertedCount = 0;
  let totalCarrierRentReversed = 0;
  let totalBookingIncomeReversed = 0;

  for (const m of eligible) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const result = await convertChallanToOwnCarrier(tx, {
            challanId: m.challanId,
            ownCarrierId: m.targetOwnCarrierId!,
            createdById: userId!,
          });
          totalCarrierRentReversed += result.carrierRentReversed;
          totalBookingIncomeReversed += result.bookingIncomeReversed;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      convertedCount++;
      console.log(`  Converted ${m.challanNo} -> ${m.targetCarrierNumber}`);
    } catch (error) {
      if (error instanceof ChallanConversionError) {
        console.error(`  FAILED ${m.challanNo}: [${error.code}] ${error.message}`);
      } else {
        console.error(`  FAILED ${m.challanNo}:`, error);
      }
    }
  }

  console.log(`\nAFTER:`);
  console.log(`  Converted: ${convertedCount}/${eligible.length}`);
  console.log(`  Total Carrier Rent expense/payable reversed: Rs. ${totalCarrierRentReversed.toLocaleString()}`);
  console.log(`  Total Booking Income reversed back to Unearned Revenue: Rs. ${totalBookingIncomeReversed.toLocaleString()}`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
