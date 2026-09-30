import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { writeAuditLog, actorFromUser, requestContext } from "@/lib/audit-log";

export async function POST(request: NextRequest) {
  // Read the identity BEFORE the cookie is cleared below.
  const currentUser = await getCurrentUser();
  if (currentUser) {
    await writeAuditLog(prisma, {
      actor: actorFromUser(currentUser),
      action: "LOGOUT",
      module: "AUTH",
      entityType: "User",
      entityId: currentUser.userId,
      documentNo: currentUser.username,
      description: `User ${currentUser.username} logged out`,
      ...requestContext(request),
    });
  }

  const response = NextResponse.json({
    success: true,
    message: "Logout successful",
  });

  response.cookies.set("auth_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: new Date(0),
    path: "/",
  });

  return response;
}