import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcrypt";
import { SignJWT } from "jose";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog, requestContext } from "@/lib/audit-log";

const loginSchema = z.object({
  username: z.string().min(3, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not configured");
}

const secret = new TextEncoder().encode(JWT_SECRET);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const result = loginSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid username or password" },
        { status: 400 }
      );
    }

    const { username, password } = result.data;

    const user = await prisma.user.findUnique({
      where: { username },
    });

    if (!user || !user.isActive) {
      // Never records the attempted password - only the username that
      // was typed, which is not itself a secret.
      await writeAuditLog(prisma, {
        actor: { userId: null, userNameSnapshot: username, userRoleSnapshot: null },
        action: "LOGIN_FAILED",
        module: "AUTH",
        entityType: "User",
        entityId: user?.id ?? null,
        documentNo: username,
        description: `Failed login attempt for username "${username}"`,
        ...requestContext(request),
      });
      return NextResponse.json(
        { success: false, message: "Invalid username or password" },
        { status: 401 }
      );
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      await writeAuditLog(prisma, {
        actor: { userId: user.id, userNameSnapshot: user.username, userRoleSnapshot: user.role },
        action: "LOGIN_FAILED",
        module: "AUTH",
        entityType: "User",
        entityId: user.id,
        documentNo: user.username,
        description: `Failed login attempt for User ${user.username} (wrong password)`,
        ...requestContext(request),
      });
      return NextResponse.json(
        { success: false, message: "Invalid username or password" },
        { status: 401 }
      );
    }

    const token = await new SignJWT({
      userId: user.id,
      role: user.role,
      username: user.username,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("8h")
      .sign(secret);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    await writeAuditLog(prisma, {
      actor: { userId: user.id, userNameSnapshot: user.username, userRoleSnapshot: user.role },
      action: "LOGIN_SUCCESS",
      module: "AUTH",
      entityType: "User",
      entityId: user.id,
      documentNo: user.username,
      description: `User ${user.username} logged in`,
      ...requestContext(request),
    });

    const response = NextResponse.json({
      success: true,
      message: "Login successful",
    });

    response.cookies.set("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 8,
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("Login error:", error);

    return NextResponse.json(
      { success: false, message: "Something went wrong" },
      { status: 500 }
    );
  }
}