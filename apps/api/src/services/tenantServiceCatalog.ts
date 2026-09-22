import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { z } from "zod";
import { ApiError } from "../errors.ts";
import { requireCompanyAdmin, requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeAudit } from "../lib/audit.ts";
import { SERVICE_CATEGORY_LABEL } from "./contactLabels.ts";

type Db = PrismaClient | Prisma.TransactionClient;
export type ServiceChoice = { kind?: "SERVICE" | "PRODUCT"; code: string; name: string; description: string; aliases: string[]; active: boolean };
const LEGACY_ALIASES: Record<string, string[]> = {
  web: ["сайт", "сайта", "лендинг", "landing"],
  presentation: ["презентация", "презентацию", "слайды", "pitch deck"],
  branding: ["логотип", "айдентика", "брендинг"],
  advertising: ["реклама", "рекламу", "таргет"],
  ai: ["AI", "ИИ", "AI-менеджер", "ИИ-менеджер"],
};
const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("ru").replace(/\s+/g, " ");

/** Import only categories already used by this tenant. Never reactivate archived entries. */
export async function loadTenantServices(db: Db, tenantId: string): Promise<ServiceChoice[]> {
  const legacy = await db.inquiry.findMany({ where: { tenantId, serviceCategory: { not: null } }, distinct: ["serviceCategory"], select: { serviceCategory: true } });
  const codes = legacy.map((row) => row.serviceCategory).filter((code): code is string => Boolean(code));
  if (codes.length) await db.tenantServiceCategory.createMany({
    data: codes.map((code) => ({ id: randomUUID(), tenantId, code, name: SERVICE_CATEGORY_LABEL[code] || code, aliases: LEGACY_ALIASES[code] || [] })), skipDuplicates: true,
  });
  const rows = await db.tenantServiceCategory.findMany({ where: { tenantId }, orderBy: [{ active: "desc" }, { name: "asc" }] });
  return rows.map((row) => ({ code: row.code, name: row.name, kind: row.kind === "PRODUCT" ? "PRODUCT" : "SERVICE", description: row.description, active: row.active, aliases: Array.isArray(row.aliases) ? row.aliases.filter((value): value is string => typeof value === "string") : [] }));
}

export function matchTenantService(services: ServiceChoice[], value?: string | null) {
  if (!value?.trim()) return null;
  const normalized = normalize(value);
  const matches = services.filter((row) => row.active && [row.code, row.name, ...row.aliases].some((term) => normalize(term) === normalized));
  return matches.length === 1 ? matches[0].code : null;
}

export function detectTenantService(services: ServiceChoice[], text: string) {
  const normalized = normalize(text);
  const matches = services.filter((row) => row.active && [row.name, ...row.aliases].some((term) => {
    const phrase = normalize(term);
    if (!phrase) return false;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(normalized);
  }));
  return matches.length === 1 ? matches[0].code : null;
}

export async function validateTenantService(db: Db, tenantId: string, value: unknown, existing?: string | null) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(422, "invalid_service", "Выберите товар или услугу из справочника компании");
  if (value === existing) return existing;
  const code = matchTenantService(await loadTenantServices(db, tenantId), value);
  if (!code) throw new ApiError(422, "invalid_service", "Позиция не найдена в активном справочнике вашей компании");
  return code;
}

const serviceInput = z.object({
  kind: z.enum(["SERVICE", "PRODUCT"]).optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).default(""),
  aliases: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  active: z.boolean().default(true),
}).strict();

export async function listTenantServices(db: PrismaClient, auth: AuthContext) {
  return { items: await loadTenantServices(db, requireTenant(auth).tenantId) };
}

export async function saveTenantService(db: PrismaClient, auth: AuthContext, body: unknown, code?: string) {
  requireCompanyAdmin(auth);
  const tenantId = requireTenant(auth).tenantId;
  const input = serviceInput.parse(body);
  return db.$transaction(async (tx) => {
    // Serialize catalog edits for this tenant, including duplicate-name validation.
    await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
    const catalog = await loadTenantServices(tx, tenantId);
    const old = code ? catalog.find((row) => row.code === code) : null;
    if (code && !old) throw new ApiError(404, "not_found", "Позиция не найдена");
    if (catalog.some((row) => row.code !== code && normalize(row.name) === normalize(input.name))) throw new ApiError(409, "duplicate_service", "Позиция с таким названием уже есть, в том числе в архиве");
    const data = { ...input, kind: input.kind ?? old?.kind ?? "SERVICE", aliases: [...new Set(input.aliases)] };
    const item = code
      ? await tx.tenantServiceCategory.update({ where: { tenantId_code: { tenantId, code } }, data })
      : await tx.tenantServiceCategory.create({ data: { tenantId, code: `svc_${randomUUID()}`, ...data } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, entityType: "service_category", entityId: item.code, action: code ? "service_category.update" : "service_category.create", changes: data });
    return { item };
  });
}
