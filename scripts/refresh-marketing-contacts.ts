// MARKETING CONTACT REFRESH - full rebuild (read + upsert, never
// deletes). Same engine the per-write Bilty/Bill/Party hooks and the
// "Refresh Now" admin button call (lib/marketing/contact-refresh.ts) -
// this script just runs it with no `phones` filter, so it scans every
// Bilty/Bill/Party row plus every existing Contact phone, catching
// anything a per-write hook missed (it never blocks/rolls back a save,
// so a transient failure there is always corrected here).
//
// Usage: npx tsx scripts/refresh-marketing-contacts.ts
//
// Deploy note (Ubuntu VPS) - wire this into cron for the "nightly"
// requirement, e.g.:
//   15 2 * * * cd ~/apps/al-naeem-erp && npx tsx scripts/refresh-marketing-contacts.ts >> ~/logs/marketing-refresh.log 2>&1

import { PrismaClient } from "@prisma/client";
import { refreshMarketingContacts } from "../lib/marketing/contact-refresh";

const prisma = new PrismaClient();

async function main() {
  const startedAt = Date.now();
  await refreshMarketingContacts(prisma, {});
  const count = await prisma.marketingContact.count();
  console.log(`[Marketing] full contact refresh complete - ${count} contacts, ${Date.now() - startedAt}ms`);
}

main()
  .catch((error) => {
    console.error("[Marketing] refresh failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
