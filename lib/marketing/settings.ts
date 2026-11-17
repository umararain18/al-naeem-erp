import { Prisma, type PrismaClient } from "@prisma/client";

// ============================================================
// MARKETING SETTINGS - server-side helper
//
// The SINGLE place any server code reads Marketing segment thresholds/
// campaign defaults from - mirrors lib/business-settings.ts's own
// getBusinessSettings() singleton-row pattern exactly (see
// MarketingSettings's own doc comment in prisma/schema.prisma).
// Deliberately NOT cached, same reasoning as business-settings.ts.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Finds the one authoritative MarketingSettings row, creating it with
 * sensible defaults on first-ever access. See getBusinessSettings()'s own
 * doc comment for why the create-then-catch-P2002 dance is needed instead
 * of a plain findFirst-then-create.
 */
export async function getMarketingSettings(tx: Tx) {
  const existing = await tx.marketingSettings.findFirst();
  if (existing) return existing;

  try {
    return await tx.marketingSettings.create({ data: {} });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await tx.marketingSettings.findFirst();
      if (winner) return winner;
    }
    throw error;
  }
}
