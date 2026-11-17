// REPORT: MARKETING CONTACT DATA COVERAGE (read-only, never writes anything)
//
// Pre-build data-quality check for the planned Marketing / Lead
// Generation module (Contacts auto-built from Bilty sender/receiver
// phones). Answers: how much of the Bilty data actually carries a
// usable phone number, how much is walk-in (no linked Party on either
// side), and a rough order of magnitude for how many phones look like
// a broker (>5 distinct names on one phone, or already tagged
// CLEARING_AGENT on a matched Party).
//
// "Valid" here means: digits-only, last-10-digits reduction starts
// with "3" and is exactly 10 digits (i.e. normalizes cleanly to
// 03XXXXXXXXX) - mirrors lib/search-helpers.ts's own documented
// finding that stored phone values are never normalized at write time
// ("0300-1234567" and "03001234567" both exist), so this strips all
// non-digit formatting before checking.
//
// Usage: npx tsx scripts/report-marketing-contact-coverage.ts
// Output: printed summary only. No CSV, no writes.

import { PrismaClient } from "@prisma/client";
import { toLocalMobile } from "../lib/phone";

const prisma = new PrismaClient();

async function main() {
  const bilties = await prisma.bilty.findMany({
    where: { isDeleted: false },
    select: {
      consignorPhone: true,
      consigneePhone: true,
      consignorName: true,
      consigneeName: true,
      consignorPartyId: true,
      consigneePartyId: true,
    },
  });

  const total = bilties.length;
  let validSender = 0;
  let validReceiver = 0;
  let walkIn = 0;

  const namesByPhone = new Map<string, Set<string>>();

  for (const b of bilties) {
    const senderPhone = toLocalMobile(b.consignorPhone);
    const receiverPhone = toLocalMobile(b.consigneePhone);
    if (senderPhone) validSender++;
    if (receiverPhone) validReceiver++;
    if (!b.consignorPartyId && !b.consigneePartyId) walkIn++;

    if (senderPhone) {
      if (!namesByPhone.has(senderPhone)) namesByPhone.set(senderPhone, new Set());
      namesByPhone.get(senderPhone)!.add(b.consignorName.trim().toLowerCase());
    }
    if (receiverPhone) {
      if (!namesByPhone.has(receiverPhone)) namesByPhone.set(receiverPhone, new Set());
      namesByPhone.get(receiverPhone)!.add(b.consigneeName.trim().toLowerCase());
    }
  }

  const manyNamesBrokerPhones = [...namesByPhone.entries()].filter(([, names]) => names.size > 5).map(([phone]) => phone);

  const clearingAgentParties = await prisma.party.findMany({
    where: { partyTypes: { has: "CLEARING_AGENT" } },
    select: { phone: true, whatsapp: true },
  });
  const clearingAgentPhones = new Set<string>();
  for (const p of clearingAgentParties) {
    const normPhone = toLocalMobile(p.phone);
    const normWhatsapp = toLocalMobile(p.whatsapp);
    if (normPhone) clearingAgentPhones.add(normPhone);
    if (normWhatsapp) clearingAgentPhones.add(normWhatsapp);
  }

  const brokerPhones = new Set<string>([...manyNamesBrokerPhones, ...clearingAgentPhones.values()].filter((phone) => namesByPhone.has(phone) || clearingAgentPhones.has(phone)));

  const pct = (n: number) => (total === 0 ? "0.0%" : `${((n / total) * 100).toFixed(1)}%`);

  console.log("=== Marketing Contact Data Coverage ===");
  console.log(`Total Bilties (active, non-deleted): ${total}`);
  console.log(`Valid sender phone:   ${validSender} (${pct(validSender)})`);
  console.log(`Valid receiver phone: ${validReceiver} (${pct(validReceiver)})`);
  console.log(`Walk-in (no linked Party either side): ${walkIn} (${pct(walkIn)})`);
  console.log(`Distinct normalized phones seen: ${namesByPhone.size}`);
  console.log(`Likely-broker phones (>5 distinct names OR CLEARING_AGENT party match): ${brokerPhones.size}`);
  console.log(`  - of which by >5-distinct-names heuristic: ${manyNamesBrokerPhones.length}`);
  console.log(`  - of which by CLEARING_AGENT Party phone match: ${[...clearingAgentPhones.values()].filter((p) => namesByPhone.has(p)).length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
