import type { PrismaClient } from "@creolab/db";
import { hashPassword } from "../lib/password.ts";

export function platformAdminEmail() {
  return String(process.env.PLATFORM_ADMIN_EMAIL || "").trim().toLowerCase();
}

/** One-time bootstrap only. Restarts never grant roles, reset passwords or undo suspension. */
export async function ensurePlatformAdmin(prisma: PrismaClient) {
  const email = platformAdminEmail();
  const password = String(process.env.PLATFORM_ADMIN_PASSWORD || "");
  const unchanged = { email, created: false, updated: false };
  if (!email.includes("@") || !password) return unchanged;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (!existing.platformAdmin) throw new Error("PLATFORM_ADMIN_EMAIL belongs to an existing non-administrator; use an authenticated administrator to manage roles");
    return unchanged;
  }
  if (password.length < 12) throw new Error("Initial administrator password must contain at least 12 characters");
  await prisma.user.create({ data: {
    email, passwordHash: await hashPassword(password), name: "Администратор сервиса",
    platformAdmin: true, status: "active",
  } });
  return { email, created: true, updated: false };
}
