import argon2 from "argon2";
import type { PrismaClient } from "@creolab/db";

const DEFAULT_PLATFORM_ADMIN_EMAIL = "creolabkz@gmail.com";

export function platformAdminEmail() {
  return String(process.env.PLATFORM_ADMIN_EMAIL || DEFAULT_PLATFORM_ADMIN_EMAIL).trim().toLowerCase();
}

/** Creates or updates the service-admin account from env. Password is never logged. */
export async function ensurePlatformAdmin(prisma: PrismaClient) {
  const email = platformAdminEmail();
  const password = String(process.env.PLATFORM_ADMIN_PASSWORD || "").trim();
  if (!email.includes("@")) return { email, created: false, updated: false };

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing && !password) return { email, created: false, updated: false };

  if (!existing) {
    await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password),
        name: "Администратор сервиса",
        platformAdmin: true,
        status: "active",
      },
    });
    return { email, created: true, updated: false };
  }

  const data: { platformAdmin: boolean; status: "active"; passwordHash?: string; name?: string } = {
    platformAdmin: true,
    status: "active",
  };
  if (password) data.passwordHash = await argon2.hash(password);
  if (!existing.name) data.name = "Администратор сервиса";
  await prisma.user.update({ where: { id: existing.id }, data });
  return { email, created: false, updated: true };
}
