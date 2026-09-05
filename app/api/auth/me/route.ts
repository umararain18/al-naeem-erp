import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

// Exposes the already-authenticated user's own identity/role so
// client components can conditionally render role-gated UI (e.g.
// "Edit Settlement" for SUPER_ADMIN only). This is read-only and
// does not grant anything by itself - every protected action still
// re-checks the role/permission server-side on its own route.
export async function GET() {
  const currentUser = await getCurrentUser();

  if (!currentUser) {
    return NextResponse.json(
      { success: false, message: "Unauthorized" },
      { status: 401 }
    );
  }

  return NextResponse.json({
    success: true,
    user: {
      userId: currentUser.userId,
      username: currentUser.username,
      role: currentUser.role,
    },
  });
}
