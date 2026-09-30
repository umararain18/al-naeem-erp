import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { mkdir, writeFile, unlink } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getBusinessSettings } from "@/lib/business-settings";
import { auditSettingsChange, actorFromUser, requestContext } from "@/lib/audit-log";

// ============================================================
// POST/DELETE /api/settings/branding/upload
//
// This project has no existing file-storage/S3-equivalent architecture
// to reuse (checked: no multer/sharp/cloudinary/S3 dependency anywhere
// in package.json, no prior /api upload route). The simplest, safest
// choice that avoids a new dependency and never puts binary data in an
// ordinary DB field: write the file to public/uploads/branding/ (Next.js
// serves public/ as static assets automatically) and store only the
// resulting stable /uploads/... URL on BusinessSettings - never the
// file bytes themselves.
//
// Gated by settings.edit (SUPER_ADMIN only) - the same permission the
// rest of the Settings module uses, per the existing lib/permissions.ts
// role map. Never exposes the on-disk path, only the public URL.
// ============================================================

const FIELD_TO_COLUMN = {
  mainLogo: "mainLogoUrl",
  smallLogo: "smallLogoUrl",
  favicon: "faviconUrl",
  signature: "signatureUrl",
  stamp: "stampUrl",
} as const;

type BrandingField = keyof typeof FIELD_TO_COLUMN;

const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB - existing-project-convention-free default, generous for a logo/signature/stamp image.

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "branding");
const PUBLIC_PREFIX = "/uploads/branding/";

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "settings.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const formData = await request.formData();
    const field = formData.get("field");
    const file = formData.get("file");

    if (typeof field !== "string" || !(field in FIELD_TO_COLUMN)) {
      return NextResponse.json(
        { success: false, message: "Invalid field. Must be one of: mainLogo, smallLogo, favicon, signature, stamp." },
        { status: 400 }
      );
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, message: "No file uploaded" }, { status: 400 });
    }
    if (!(file.type in ALLOWED_TYPES)) {
      return NextResponse.json(
        { success: false, message: "Unsupported file type. Use PNG, JPEG, WEBP, SVG, or ICO." },
        { status: 400 }
      );
    }
    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ success: false, message: "File is too large. Maximum size is 5MB." }, { status: 400 });
    }

    const extension = ALLOWED_TYPES[file.type];
    const filename = `${field}-${randomUUID()}.${extension}`;

    await mkdir(UPLOAD_DIR, { recursive: true });
    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(path.join(UPLOAD_DIR, filename), bytes);

    const publicUrl = `${PUBLIC_PREFIX}${filename}`;
    const column = FIELD_TO_COLUMN[field as BrandingField];

    const current = await getBusinessSettings(prisma);
    const previousUrl = (current as unknown as Record<string, string | null>)[column];

    const updated = await prisma.businessSettings.update({
      where: { id: current.id },
      data: { [column]: publicUrl, updatedById: currentUser.userId },
      include: { documentTypeSettings: true },
    });

    // Best-effort cleanup of the file this one replaces - never blocks
    // the response on failure (e.g. it was already missing), and only
    // ever removes a file this same upload path itself wrote (URL
    // always starts with PUBLIC_PREFIX), never an arbitrary path.
    if (previousUrl && previousUrl.startsWith(PUBLIC_PREFIX)) {
      const oldPath = path.join(UPLOAD_DIR, previousUrl.slice(PUBLIC_PREFIX.length));
      unlink(oldPath).catch(() => {});
    }

    await auditSettingsChange(prisma, {
      actor: actorFromUser(currentUser),
      module: "SETTINGS",
      entityType: "BusinessSettings",
      entityId: current.id,
      documentNo: "Business Settings",
      description: `Updated ${field} branding image`,
      changedFields: { [column]: { old: previousUrl || null, new: publicUrl } },
      ...requestContext(request),
    });

    return NextResponse.json({ success: true, message: "Uploaded successfully.", url: publicUrl, settings: updated });
  } catch (error) {
    console.error("Branding upload error:", error);
    return NextResponse.json({ success: false, message: "Unable to upload file" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "settings.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const field = searchParams.get("field");
    if (typeof field !== "string" || !(field in FIELD_TO_COLUMN)) {
      return NextResponse.json(
        { success: false, message: "Invalid field. Must be one of: mainLogo, smallLogo, favicon, signature, stamp." },
        { status: 400 }
      );
    }

    const column = FIELD_TO_COLUMN[field as BrandingField];
    const current = await getBusinessSettings(prisma);
    const previousUrl = (current as unknown as Record<string, string | null>)[column];

    const updated = await prisma.businessSettings.update({
      where: { id: current.id },
      data: { [column]: null, updatedById: currentUser.userId },
      include: { documentTypeSettings: true },
    });

    if (previousUrl && previousUrl.startsWith(PUBLIC_PREFIX)) {
      const oldPath = path.join(UPLOAD_DIR, previousUrl.slice(PUBLIC_PREFIX.length));
      unlink(oldPath).catch(() => {});
    }

    await auditSettingsChange(prisma, {
      actor: actorFromUser(currentUser),
      module: "SETTINGS",
      entityType: "BusinessSettings",
      entityId: current.id,
      documentNo: "Business Settings",
      description: `Removed ${field} branding image`,
      changedFields: { [column]: { old: previousUrl || null, new: null } },
      ...requestContext(request),
    });

    return NextResponse.json({ success: true, message: "Removed successfully.", settings: updated });
  } catch (error) {
    console.error("Branding remove error:", error);
    return NextResponse.json({ success: false, message: "Unable to remove file" }, { status: 500 });
  }
}
