import { Prisma, type PrismaClient } from "@creolab/db";
import type { z } from "zod";
import type { AutopilotConfig } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { requireTenant, isCompanyAdmin } from "../lib/access.ts";
import { authForUserInTenant } from "./authService.ts";
import { parseOpsSettings } from "./dealPipeline.ts";
import { createProcessClock } from "./processCalendar.ts";
import { actionHash } from "./aiActionRegistry.ts";
import { requireFeature } from "./entitlementService.ts";
import { lockSituationEpisodes } from "./situationEpisodeService.ts";

export type Tx = Prisma.TransactionClient;
export type Db = Tx | PrismaClient;
export type Policy = Prisma.AutopilotPolicyGetPayload<Record<string, never>>;
export type Case = Prisma.AutopilotCaseGetPayload<Record<string, never>>;
export const activeStates = ["proposed", "ready", "reminded", "escalated"];
export const txOptions = { maxWait: 10_000, timeout: 30_000 };
export const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
export function parse<T>(schema: z.ZodType<T>, raw: unknown): T { const p = schema.safeParse(raw); if (!p.success) throw new ApiError(422, "invalid_autopilot", p.error.issues[0]?.message || "Проверьте правило."); return p.data; }
export async function lock(db: Tx, tenantId: string) {
  // Same order as situation workers: their inserts take a tenant FK lock.
  // Acquiring the tenant first could deadlock against their episode lock.
  await lockSituationEpisodes(db, tenantId);
  await db.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
}
export async function authorize(db: Db, auth: AuthContext, write = false) {
  if (auth.configurationTenant) throw new ApiError(403, "forbidden", "Автоматизацию включает руководитель в кабинете компании.");
  const tid = requireTenant(auth).tenantId;
  if (write) {
    await db.$queryRaw`SELECT id FROM "Membership" WHERE "tenantId" = ${tid} AND "userId" = ${auth.user.id} FOR SHARE`;
    await db.$queryRaw`SELECT id FROM "User" WHERE id = ${auth.user.id} FOR SHARE`;
  }
  const fresh = await authForUserInTenant(db, auth.user.id, tid, auth.sessionId);
  if (!["owner", "director", "sales_lead"].includes(requireTenant(fresh).role) || write && !isCompanyAdmin(fresh))
    throw new ApiError(403, "forbidden", "Управление правилом доступно владельцу и директору.");
  return fresh;
}
export async function calendarContext(db: Db, tenantId: string, now: Date) {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const calendar = parseOpsSettings(tenant.settingsJson).processCalendar;
  return { tenant, calendar, hash: actionHash({ calendar, timezone: tenant.timezone }), clock: createProcessClock(calendar, tenant.timezone, now) };
}
export async function policyBlockers(db: Db, auth: AuthContext, c: AutopilotConfig, now: Date, checkMembers = true) {
  const { tenant, calendar, hash, clock } = await calendarContext(db, requireTenant(auth).tenantId, now);
  const blockers: string[] = [];
  if (calendar.mode !== "business") blockers.push("Сначала включите рабочий календарь в настройках управления.");
  if (record(record(tenant.settingsJson).runtime).aiPaused) blockers.push("Автоматизация приостановлена в управлении компанией.");
  try { await requireFeature(db, auth, "TASKS"); }
  catch (e) { if (!(e instanceof ApiError) || e.code !== "feature_required") throw e; blockers.push("На текущем тарифе недоступны задачи."); }
  const ids = [...new Set([...c.members, c.escalationMemberId])];
  const rows = await db.membership.findMany({ where: { tenantId: tenant.id, id: { in: ids }, active: true, user: { status: "active" } }, include: { user: { select: { name: true } } } });
  if (checkMembers && (rows.length !== ids.length || rows.some(m => !["owner", "director", "sales_lead", "manager"].includes(m.role)))) blockers.push("Выберите действующих сотрудников компании.");
  if (checkMembers && !rows.some(m => m.id === c.escalationMemberId && ["owner", "director", "sales_lead"].includes(m.role))) blockers.push("Для эскалации выберите владельца, директора или руководителя продаж.");
  return { tenant, calendar, hash, clock, blockers };
}
export async function event(db: Tx, p: Policy, type: string, details: unknown, now: Date, caseId?: string, userId?: string, requestId?: string, requestHash?: string) {
  return db.autopilotEvent.create({ data: { tenantId: p.tenantId, policyVersion: p.version, caseId, type, detailsJson: json(details), createdAt: now, userId, requestId, requestHash } });
}
export async function replay(db: Tx, tenantId: string, userId: string, requestId: string, hash: string) {
  const old = await db.autopilotEvent.findUnique({ where: { tenantId_userId_requestId: { tenantId, userId, requestId } } });
  if (old && old.requestHash !== hash) throw new ApiError(409, "request_conflict", "Этот запрос уже использован для другого изменения.");
  return old;
}
export async function cancelPolicyCases(db: Tx, p: Policy, explanation: string, now: Date) {
  const cases = await db.autopilotCase.findMany({ where: { tenantId: p.tenantId, policyId: p.id, state: { in: activeStates } }, select: { id: true } });
  await db.scheduledAction.updateMany({ where: { tenantId: p.tenantId, type: "autopilot_check", state: { in: ["scheduled", "running"] } }, data: { state: "canceled", cancelReason: explanation, version: { increment: 1 } } });
  await db.autopilotCase.updateMany({ where: { tenantId: p.tenantId, policyId: p.id, state: { in: activeStates } }, data: { state: "stopped", explanation, dueAt: null, version: { increment: 1 }, updatedAt: now } });
  for (const row of cases) await event(db, p, "stopped", { text: explanation }, now, row.id);
}
