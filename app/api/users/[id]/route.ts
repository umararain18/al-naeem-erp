import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcrypt";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { Role } from "@prisma/client";
import { auditUpdate, auditDelete, auditPermissionChange, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

const updateUserSchema = z.object({
  fullName: z.string().min(2).optional(),
  username: z.string().min(3).optional(),
  password: z.string().min(6).optional(),
  phone: z.string().optional(),
  role: z.enum(["SUPER_ADMIN", "MANAGER", "VIEWER"]).optional(),
  isActive: z.boolean().optional(),
});

// GET /api/users/[id]
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "users.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await params;

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        username: true,
        phone: true,
        role: true,
        isActive: true,
        lastLogin: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { success: false, message: "User not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      user,
    });
  } catch (error) {
    console.error("Get user error:", error);

    return NextResponse.json(
      { success: false, message: "Something went wrong" },
      { status: 500 }
    );
  }
}

// PATCH /api/users/[id]
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "users.edit")) {
      return NextResponse.json(
        {
          success: false,
          message: "You do not have permission to edit users",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    // Read request body only once.
    const body = await request.json();

    const result = updateUserSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid user data",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { id },
    });

    if (!existingUser) {
      return NextResponse.json(
        { success: false, message: "User not found" },
        { status: 404 }
      );
    }

    // Prevent a user from deactivating their own account.
    if (id === currentUser.userId && result.data.isActive === false) {
      return NextResponse.json(
        {
          success: false,
          message: "You cannot deactivate your own account",
        },
        { status: 400 }
      );
    }

    // Prevent a user from changing their own role.
    if (
      id === currentUser.userId &&
      result.data.role !== undefined &&
      result.data.role !== existingUser.role
    ) {
      return NextResponse.json(
        {
          success: false,
          message: "You cannot change your own role",
        },
        { status: 400 }
      );
    }

    const data = result.data;

    // Check username uniqueness.
    if (data.username && data.username !== existingUser.username) {
      const usernameExists = await prisma.user.findUnique({
        where: {
          username: data.username,
        },
      });

      if (usernameExists) {
        return NextResponse.json(
          {
            success: false,
            message: "Username already exists",
          },
          { status: 409 }
        );
      }
    }

    const updateData: {
      fullName?: string;
      username?: string;
      password?: string;
      phone?: string | null;
      role?: Role;
      isActive?: boolean;
    } = {};

    if (data.fullName !== undefined) {
      updateData.fullName = data.fullName;
    }

    if (data.username !== undefined) {
      updateData.username = data.username;
    }

    if (data.password !== undefined) {
      updateData.password = await bcrypt.hash(data.password, 10);
    }

    if (data.phone !== undefined) {
      updateData.phone = data.phone || null;
    }

    if (data.role !== undefined) {
      updateData.role = data.role as Role;
    }

    if (data.isActive !== undefined) {
      updateData.isActive = data.isActive;
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        fullName: true,
        username: true,
        phone: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Role change is its own PERMISSION_CHANGE audit event (Section M
    // of the audit log spec); every other field change is a plain
    // UPDATE - never logs the password/hash.
    if (data.role !== undefined && data.role !== existingUser.role) {
      await auditPermissionChange(prisma, {
        actor: actorFromUser(currentUser),
        module: "USER",
        entityType: "User",
        entityId: id,
        documentNo: existingUser.username,
        description: `Changed role for User ${existingUser.username}: ${existingUser.role} → ${data.role}`,
        changedFields: { role: { old: existingUser.role, new: data.role } },
        ...requestContext(request),
      });
    }

    const otherChangedFields = diffFields(
      { fullName: existingUser.fullName, username: existingUser.username, phone: existingUser.phone, isActive: existingUser.isActive },
      { fullName: data.fullName, username: data.username, phone: data.phone, isActive: data.isActive },
      ["fullName", "username", "phone", "isActive"]
    );
    if (Object.keys(otherChangedFields).length > 0) {
      const summary = Object.entries(otherChangedFields).map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`).join("; ");
      await auditUpdate(prisma, {
        actor: actorFromUser(currentUser),
        module: "USER",
        entityType: "User",
        entityId: id,
        documentNo: existingUser.username,
        description: `Updated User ${existingUser.username}: ${summary}`,
        changedFields: otherChangedFields,
        ...requestContext(request),
      });
    }

    return NextResponse.json({
      success: true,
      message: "User updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error("Update user error:", error);

    return NextResponse.json(
      { success: false, message: "Something went wrong" },
      { status: 500 }
    );
  }
}

// DELETE /api/users/[id]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "users.delete")) {
      return NextResponse.json(
        {
          success: false,
          message: "You do not have permission to delete users",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    // Never allow a user to delete their own account.
    if (id === currentUser.userId) {
      return NextResponse.json(
        {
          success: false,
          message: "You cannot delete your own account",
        },
        { status: 400 }
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { id },
    });

    if (!existingUser) {
      return NextResponse.json(
        { success: false, message: "User not found" },
        { status: 404 }
      );
    }

    await prisma.user.delete({
      where: { id },
    });

    await auditDelete(prisma, {
      actor: actorFromUser(currentUser),
      module: "USER",
      entityType: "User",
      entityId: id,
      documentNo: existingUser.username,
      description: `Deleted User ${existingUser.username} (${existingUser.fullName})`,
      oldValues: { fullName: existingUser.fullName, username: existingUser.username, role: existingUser.role },
      ...requestContext(request),
    });

    return NextResponse.json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (error) {
    console.error("Delete user error:", error);

    return NextResponse.json(
      { success: false, message: "Something went wrong" },
      { status: 500 }
    );
  }
}