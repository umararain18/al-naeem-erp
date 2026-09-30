import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getBusinessSettings } from "@/lib/business-settings";
import { auditSettingsChange, actorFromUser, requestContext } from "@/lib/audit-log";

// ============================================================
// GET/PATCH /api/settings/document-types
//
// Section 5 of the Settings spec - per-document-type Use Header/Use
// Footer/Use Logo overrides (Bilty/Challan/Bill/Private Phonch/
// Showroom Phonch/Receipt/Party Statement/Reports). Each is an
// upsert-by-(businessSettingsId, documentType) on DocumentTypeSettings -
// never a duplicate row per document type (the @@unique constraint in
// prisma/schema.prisma is the hard backstop; this route's own upsert
// is the normal path). A field left out of the PATCH payload for a
// given document type is untouched, not reset to null.
// ============================================================

const DOCUMENT_TYPES = [
  "BILTY",
  "CHALLAN",
  "BILL",
  "PRIVATE_PHONCH",
  "SHOWROOM_PHONCH",
  "RECEIPT",
  "PARTY_STATEMENT",
  "REPORTS",
] as const;

const entrySchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  useHeader: z.boolean().nullable().optional(),
  useFooter: z.boolean().nullable().optional(),
  useLogo: z.boolean().nullable().optional(),
});

const updateSchema = z.object({
  entries: z.array(entrySchema).min(1).max(DOCUMENT_TYPES.length),
});

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "settings.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const settings = await getBusinessSettings(prisma);

    return NextResponse.json({
      success: true,
      documentTypeSettings: settings.documentTypeSettings,
      globalDefaults: {
        useHeader: settings.defaultUseHeader,
        useFooter: settings.defaultUseFooter,
        useLogo: settings.defaultUseLogo,
      },
    });
  } catch (error) {
    console.error("Get document type settings error:", error);
    return NextResponse.json({ success: false, message: "Unable to load document settings" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "settings.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const result = updateSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid document settings data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const settings = await getBusinessSettings(prisma);
    const perTypeChanges: string[] = [];

    for (const entry of result.data.entries) {
      const existing = settings.documentTypeSettings.find((d) => d.documentType === entry.documentType);
      const data: { useHeader?: boolean | null; useFooter?: boolean | null; useLogo?: boolean | null } = {};
      if (entry.useHeader !== undefined) data.useHeader = entry.useHeader;
      if (entry.useFooter !== undefined) data.useFooter = entry.useFooter;
      if (entry.useLogo !== undefined) data.useLogo = entry.useLogo;

      const fieldChanges = (Object.keys(data) as (keyof typeof data)[])
        .filter((f) => (existing ? existing[f] : null) !== data[f])
        .map((f) => `${f} ${existing?.[f] ?? "INHERIT"} → ${data[f] ?? "INHERIT"}`);
      if (fieldChanges.length > 0) {
        perTypeChanges.push(`${entry.documentType}: ${fieldChanges.join(", ")}`);
      }

      if (existing) {
        await prisma.documentTypeSettings.update({ where: { id: existing.id }, data });
      } else {
        await prisma.documentTypeSettings.create({
          data: { businessSettingsId: settings.id, documentType: entry.documentType, ...data },
        });
      }
    }

    const updated = await getBusinessSettings(prisma);

    if (perTypeChanges.length > 0) {
      await auditSettingsChange(prisma, {
        actor: actorFromUser(currentUser),
        module: "SETTINGS",
        entityType: "DocumentTypeSettings",
        entityId: settings.id,
        documentNo: "Document Settings",
        description: `Updated Document Settings: ${perTypeChanges.join("; ")}`,
        newValues: { entries: result.data.entries },
        ...requestContext(request),
      });
    }

    return NextResponse.json({
      success: true,
      message: "Document settings updated successfully.",
      documentTypeSettings: updated.documentTypeSettings,
    });
  } catch (error) {
    console.error("Update document type settings error:", error);
    return NextResponse.json({ success: false, message: "Unable to update document settings" }, { status: 500 });
  }
}
