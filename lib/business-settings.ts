import { Prisma, type PrismaClient } from "@prisma/client";

// ============================================================
// CENTRAL SETTINGS MODULE - server-side helpers
//
// The SINGLE place any server code (API routes now, PDF generators in
// a future integration phase) reads business/branding/document
// configuration from - never a second, independently-written query.
// See model BusinessSettings's own doc comment in prisma/schema.prisma
// for the full design rationale.
//
// Deliberately NOT cached: this is a low-traffic internal ERP, and a
// stale cache here would risk a newly-changed logo/business detail not
// showing up in a document generated moments later - a correctness
// problem worse than the trivial cost of one extra query. See Section
// 12 of the task's own spec ("cache safely if appropriate... do not
// cache indefinitely") - the simplest, always-correct choice is no
// cache at all.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Finds the one authoritative BusinessSettings row, creating it with
 * sensible defaults on first-ever access. `findFirst()` followed by
 * `create()` is NOT atomic on its own - two concurrent first-ever
 * calls could both find nothing and both attempt to create a row. The
 * `singleton` column's UNIQUE constraint (see its own doc comment in
 * prisma/schema.prisma) is the real backstop: if this call loses that
 * race, its own `create()` fails with P2002, and this catches that
 * failure and re-reads the row the OTHER call just created - so the
 * caller always gets back the one true row, never a duplicate.
 */
export async function getBusinessSettings(tx: Tx) {
  const existing = await tx.businessSettings.findFirst({
    include: { documentTypeSettings: true },
  });
  if (existing) return existing;

  try {
    return await tx.businessSettings.create({
      data: {},
      include: { documentTypeSettings: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await tx.businessSettings.findFirst({
        include: { documentTypeSettings: true },
      });
      if (winner) return winner;
    }
    throw error;
  }
}

export type SettingsDocumentTypeValue =
  | "BILTY"
  | "CHALLAN"
  | "BILL"
  | "PRIVATE_PHONCH"
  | "SHOWROOM_PHONCH"
  | "RECEIPT"
  | "PARTY_STATEMENT"
  | "REPORTS";

export type EffectiveDocumentSettings = {
  useHeader: boolean;
  useFooter: boolean;
  useLogo: boolean;
};

/**
 * Resolves the EFFECTIVE header/footer/logo flags for one document
 * type - a null field on that document type's own DocumentTypeSettings
 * row (or no row at all) falls back to the global BusinessSettings
 * default, exactly once, here - never re-derived per-caller. See
 * DocumentTypeSettings's own doc comment in prisma/schema.prisma.
 */
export async function getDocumentTypeSettings(
  tx: Tx,
  documentType: SettingsDocumentTypeValue
): Promise<EffectiveDocumentSettings> {
  const settings = await getBusinessSettings(tx);
  const override = settings.documentTypeSettings.find((d) => d.documentType === documentType);

  return {
    useHeader: override?.useHeader ?? settings.defaultUseHeader,
    useFooter: override?.useFooter ?? settings.defaultUseFooter,
    useLogo: override?.useLogo ?? settings.defaultUseLogo,
  };
}
