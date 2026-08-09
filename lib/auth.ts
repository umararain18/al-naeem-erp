import { cookies } from "next/headers";
import { jwtVerify } from "jose";

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not configured");
}

const secret = new TextEncoder().encode(JWT_SECRET);

export type AuthUser = {
  userId: string;
  username: string;
  role: "SUPER_ADMIN" | "MANAGER" | "VIEWER";
};

export async function getCurrentUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;

  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, secret);

    if (
      typeof payload.userId !== "string" ||
      typeof payload.username !== "string" ||
      !["SUPER_ADMIN", "MANAGER", "VIEWER"].includes(
        payload.role as string
      )
    ) {
      return null;
    }

    return {
      userId: payload.userId,
      username: payload.username,
      role: payload.role as AuthUser["role"],
    };
  } catch {
    return null;
  }
}