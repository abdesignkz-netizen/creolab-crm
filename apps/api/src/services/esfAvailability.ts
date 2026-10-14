import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";

type SettingsDb = Pick<PrismaClient, "platformSetting">;

// Always read the shared database: a worker or another API instance must not
// keep sending with an old cached flag after the administrator disables it.
export async function isEsfEnabled(db: SettingsDb): Promise<boolean> {
  const row = await db.platformSetting.findUnique({ where: { key: "defaults" } });
  const value = row?.valueJson as { features?: { esf?: unknown } } | null;
  return value?.features?.esf === true;
}

export async function requireEsfEnabled(db: SettingsDb) {
  if (!await isEsfEnabled(db)) throw new ApiError(404, "not_found", "Раздел недоступен");
}

export function isEsfRoute(path: string) {
  return /^\/api\/v1\/(?:integrations\/esf(?:\/|$)|settings\/esf-preflight$|deals\/[^/]+\/esf-(?:invoice-readiness|sync)$|electronic-documents\/[^/]+\/esf-)/.test(path);
}
