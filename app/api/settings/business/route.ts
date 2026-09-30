import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getBusinessSettings } from "@/lib/business-settings";
import { auditSettingsChange, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

// ============================================================
// GET/PATCH /api/settings/business
//
// Business Details / Branding text fields / Header & Footer / Invoice /
// PDF & Print - all live on the ONE authoritative BusinessSettings row
// (see its own doc comment in prisma/schema.prisma). Branding FILE
// uploads are a separate route (branding/upload) since they need
// multipart/form-data, not JSON. Document-type toggles are also
// separate (document-types) since they're a list of child rows, not
// flat fields on this one.
//
// GET: gated by settings.view (SUPER_ADMIN + MANAGER, per the existing
// lib/permissions.ts role map - already pre-declared for this exact
// feature, never used until now).
// PATCH: gated by settings.edit (SUPER_ADMIN only, per that same map) -
// updates ONLY the fields actually supplied, never resets the rest.
// ============================================================

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #1A2B3C")
  .optional()
  .or(z.literal(""));

const optionalUrl = z.string().trim().url("Must be a valid URL").optional().or(z.literal(""));
const optionalEmail = z.string().trim().email("Must be a valid email").optional().or(z.literal(""));
const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

const updateSchema = z.object({
  // Business Details
  businessName: z.string().trim().min(1, "Business Name is required").max(200).optional(),
  legalName: optionalText(200),
  shortName: optionalText(100),
  phone1: optionalText(30),
  phone2: optionalText(30),
  whatsapp: optionalText(30),
  email: optionalEmail,
  website: optionalUrl,
  address: optionalText(500),
  city: optionalText(100),
  province: optionalText(100),
  country: optionalText(100),
  ntnNumber: optionalText(50),
  registrationNumber: optionalText(50),

  // Branding (colors only here - files go through branding/upload)
  brandPrimaryColor: hexColor,
  brandSecondaryColor: hexColor,

  // Header & Footer
  headerShowLogo: z.boolean().optional(),
  headerShowBusinessName: z.boolean().optional(),
  headerShowAddress: z.boolean().optional(),
  headerShowPhone: z.boolean().optional(),
  headerShowWhatsapp: z.boolean().optional(),
  headerShowEmail: z.boolean().optional(),
  headerShowWebsite: z.boolean().optional(),
  headerLogoPosition: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
  headerAlignment: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
  headerSubtitle: optionalText(200),
  defaultUseHeader: z.boolean().optional(),
  defaultUseFooter: z.boolean().optional(),
  defaultUseLogo: z.boolean().optional(),

  footerText: optionalText(500),
  footerShowPhone: z.boolean().optional(),
  footerShowAddress: z.boolean().optional(),
  footerShowWebsite: z.boolean().optional(),
  footerShowPageNumber: z.boolean().optional(),
  footerShowGeneratedDate: z.boolean().optional(),
  termsAndConditions: optionalText(2000),

  // Invoice / Bill Settings
  invoiceTitle: z.string().trim().min(1).max(50).optional(),
  invoiceNumberPrefix: optionalText(20),
  currencyLabel: z.string().trim().min(1).max(10).optional(),
  paymentInstructions: optionalText(1000),
  defaultTermsAndConditions: optionalText(2000),
  authorizedByLabel: z.string().trim().min(1).max(100).optional(),
  signatureLabel: z.string().trim().min(1).max(100).optional(),

  // PDF & Print Settings
  pdfPageSize: z.enum(["A4", "A5"]).optional(),
  pdfOrientation: z.enum(["PORTRAIT", "LANDSCAPE"]).optional(),
  pdfDefaultFont: optionalText(100),
  pdfDefaultFontSize: z.number().int().min(6).max(24).optional(),
  pdfTableBorderStyle: optionalText(50),
  pdfShowWatermark: z.boolean().optional(),
  pdfWatermarkText: optionalText(100),
  pdfShowPageNumber: z.boolean().optional(),
  pdfShowGeneratedDate: z.boolean().optional(),
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

    return NextResponse.json({ success: true, settings });
  } catch (error) {
    console.error("Get business settings error:", error);
    return NextResponse.json({ success: false, message: "Unable to load settings" }, { status: 500 });
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
        { success: false, message: "Invalid settings data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const data = result.data;
    // Empty-string optional fields are cleared to null; undefined
    // fields are left untouched entirely (PATCH-only-what's-supplied).
    const updateData: Record<string, unknown> = { updatedById: currentUser.userId };
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      updateData[key] = value === "" ? null : value;
    }

    const current = await getBusinessSettings(prisma);
    const updated = await prisma.businessSettings.update({
      where: { id: current.id },
      data: updateData,
      include: { documentTypeSettings: true },
    });

    const changedFields = diffFields(
      current as unknown as Record<string, unknown>,
      updateData,
      Object.keys(updateData).filter((k) => k !== "updatedById") as (keyof typeof current)[]
    );
    if (Object.keys(changedFields).length > 0) {
      const summary = Object.entries(changedFields).map(([f, { old, new: nv }]) => `${f}: ${old ?? "—"} → ${nv ?? "—"}`).join("; ");
      await auditSettingsChange(prisma, {
        actor: actorFromUser(currentUser),
        module: "SETTINGS",
        entityType: "BusinessSettings",
        entityId: current.id,
        documentNo: "Business Settings",
        description: `Updated Business Settings: ${summary}`,
        changedFields,
        ...requestContext(request),
      });
    }

    return NextResponse.json({ success: true, message: "Settings updated successfully.", settings: updated });
  } catch (error) {
    console.error("Update business settings error:", error);
    return NextResponse.json({ success: false, message: "Unable to update settings" }, { status: 500 });
  }
}
