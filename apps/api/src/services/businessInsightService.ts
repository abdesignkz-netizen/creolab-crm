import type { Prisma, PrismaClient } from "@creolab/db";
import { z } from "zod";
import { OPPORTUNITY_RULES, insightListSchema, insightDecisionSchema, type BusinessInsightList, type BusinessInsightView, type BusinessInsightDetail,
  type BusinessInsightRule, type BusinessInsightState, type InsightContent, type InsightCoverage } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { logServerError } from "../lib/redact.ts";
import { writeAudit } from "../lib/audit.ts";
import { authForUserInTenant } from "./authService.ts";
import { situationWorkerAuth } from "./situationWorkerAuth.ts";
import { METRIC_REGISTRY, evidenceHash, loadBusinessEvidence, metricKey, type InsightEvidence, type InsightKey } from "./businessMetricRegistry.ts";

type Tx = Prisma.TransactionClient;
type Row = Prisma.BusinessInsightGetPayload<Record<string, never>>;
const INTERVAL = 60_000, TTL = 10 * 60_000, LIST_SIZE = 20;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const keyOf = (row: Row): InsightKey => ({ rule: row.rule as BusinessInsightRule, entityKind: row.entityKind as InsightKey["entityKind"], entityId: row.entityId });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(422, "invalid_insight", "Проверьте параметры бизнес-вывода.");
  return result.data;
}
export async function authorizeBusinessInsights(db: Tx, auth: AuthContext) {
  if (auth.configurationTenant) throw new ApiError(403, "forbidden", "Выводы доступны в кабинете компании.");
  const tenantId = requireTenant(auth).tenantId;
  const current = await authForUserInTenant(db, auth.user.id, tenantId, auth.sessionId);
  const membership = requireTenant(current);
  // A4 is a company-wide analytical view. Deny the entire response to scoped
  // employees, including names, counts, history and financial coverage.
  if (membership.tenantId !== tenantId || !["owner", "director", "sales_lead"].includes(membership.role)) {
    throw new ApiError(403, "forbidden", "Бизнес-выводы доступны владельцу, директору и руководителю продаж.");
  }
  return { auth: current, tenantId };
}
const authorize = authorizeBusinessInsights;
async function event(tx: Tx, row: Row, type: string, now: Date) {
  await tx.businessInsightEvent.create({ data: { tenantId: row.tenantId, insightId: row.id, type, version: row.version, createdAt: now } });
}
/** Called under the per-tenant advisory lock. Every change has one recorded basis. */
export async function observeBusinessInsight(tx: Tx, tenantId: string, key: InsightKey, fact: InsightEvidence | undefined, old: Row | null, now: Date) {
  if (!fact?.available) {
    if (old && old.state !== "unavailable") {
      const updated = await tx.businessInsight.update({ where: { id: old.id }, data: { state: "unavailable", version: { increment: 1 }, checkedAt: now, validUntil: now, contentJson: {} } });
      await event(tx, updated, "source_unavailable", now);
    } else if (old) await tx.businessInsight.update({ where: { id: old.id }, data: { checkedAt: now } });
    return;
  }
  if (!old && !fact.active) return;
  if (fact.active && (!old || old.state === "resolved")) {
    if (old) await tx.businessInsight.update({ where: { id: old.id }, data: { isCurrent: false } });
    const created = await tx.businessInsight.create({ data: { tenantId, ...key, occurrence: (old?.occurrence || 0) + 1,
      fingerprint: fact.fingerprint, contentJson: json(fact.content), formulaVersion: fact.formulaVersion,
      generatedAt: now, checkedAt: now, validUntil: new Date(now.getTime() + TTL) } });
    await event(tx, created, old ? "reopened" : "detected", now); return;
  }
  if (!old) return;
  const state = !fact.active ? "resolved" : old.state === "unavailable" || old.fingerprint !== fact.fingerprint ? "open" : old.state;
  const changed = old.fingerprint !== fact.fingerprint || old.state !== state;
  const updated = await tx.businessInsight.update({ where: { id: old.id }, data: { state, fingerprint: fact.fingerprint, contentJson: json(fact.content),
    formulaVersion: fact.formulaVersion, checkedAt: now, validUntil: new Date(now.getTime() + TTL),
    ...(changed ? { version: { increment: 1 }, generatedAt: now } : {}) } });
  if (changed) await event(tx, updated, state === "resolved" ? "resolved" : "facts_changed", now);
}

export function businessInsightView(row: Row, fact: InsightEvidence | undefined, now: Date): BusinessInsightView {
  const stale = !fact?.available || row.schemaVersion !== 1 || fact.fingerprint !== row.fingerprint
    || fact.formulaVersion !== row.formulaVersion || row.validUntil <= now || !row.isCurrent;
  const content = stale ? null : row.contentJson as unknown as InsightContent;
  return { id: row.id, rule: row.rule as BusinessInsightRule, state: row.state as BusinessInsightState,
    occurrence: row.occurrence, version: row.version, fingerprint: row.fingerprint, schemaVersion: row.schemaVersion,
    formulaVersion: row.formulaVersion, generatedAt: row.generatedAt.toISOString(), checkedAt: row.checkedAt.toISOString(), validUntil: row.validUntil.toISOString(), stale,
    content: content && row.state === "resolved" ? { ...content, explanation: "При последней проверке условие этого вывода больше не выполнялось. Это не подтверждение выполнения всех действий по клиенту." } : content };
}
const view = businessInsightView;
async function withOutcome(tx: Tx, auth: AuthContext, rows: Row[], views: BusinessInsightView[]) {
  const tenantId = requireTenant(auth).tenantId;
  const ids = rows.flatMap(r => r.outcomeEventId ? [r.outcomeEventId] : []);
  if (!ids.length) return views;
  const outcomes = await tx.activity.findMany({ where: { tenantId, id: { in: ids }, type: "task.created" }, select: { id: true, metadataJson: true, dealId: true, inquiryId: true, createdAt: true } });
  const taskIds = outcomes.flatMap(o => typeof record(o.metadataJson).taskId === "string" ? [record(o.metadataJson).taskId as string] : []);
  const tasks = taskIds.length ? await tx.task.findMany({ where: { tenantId, id: { in: taskIds } }, select: { id: true, status: true, dealId: true, inquiryId: true } }) : [];
  const runs = await tx.actionRun.findMany({ where: { tenantId, userId: auth.user.id, id: { in: rows.flatMap(r => r.actionRunId ? [r.actionRunId] : []) } }, select: { id: true } });
  return views.map((v, index) => {
    const row = rows[index], outcome = outcomes.find(o => o.id === row.outcomeEventId);
    if (v.stale || !outcome || (row.entityKind === "deal" ? outcome.dealId !== row.entityId : outcome.inquiryId !== row.entityId)) return v;
    const task = tasks.find(t => t.id === record(outcome.metadataJson).taskId && (row.entityKind === "deal" ? t.dealId === row.entityId : t.inquiryId === row.entityId));
    return { ...v, action: { runId: runs.find(r => r.id === row.actionRunId)?.id || null, taskId: task?.id || null, taskStatus: task?.status || null, outcomeEventId: outcome.id, at: outcome.createdAt.toISOString() } };
  });
}
async function coverage(tx: Tx, tenantId: string): Promise<InsightCoverage> {
  const [scan, tenant] = await Promise.all([
    tx.businessInsightScan.findUnique({ where: { tenantId } }),
    tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, currency: true } }),
  ]);
  const data = record(scan?.coverageJson), cursors = record(scan?.cursorsJson);
  return { scope: "company", asOf: scan?.lastRunAt?.toISOString() || null, timezone: tenant.timezone, currency: tenant.currency,
    sources: (["inquiry", "task", "deal"] as const).map(kind => ({ kind, lastFullPassAt: data[kind] || null, inProgress: Boolean(cursors[kind]) })),
    forecast: data.forecast?.timezone === tenant.timezone && data.forecast?.currency === tenant.currency ? data.forecast : null, nextScanAt: scan?.nextRunAt.toISOString() || null };
}
export async function listBusinessInsights(db: PrismaClient, auth: AuthContext, input: unknown = {}, now = new Date(), focus = false): Promise<BusinessInsightList> {
  const query = parse(insightListSchema, input);
  const limit = focus ? 8 : LIST_SIZE;
  return db.$transaction(async tx => {
    const access = await authorize(tx, auth);
    const rows = await tx.businessInsight.findMany({ where: { tenantId: access.tenantId, isCurrent: true,
      AND: [{ rule: query.kind === "opportunity" ? { in: [...OPPORTUNITY_RULES] } : { notIn: [...OPPORTUNITY_RULES] } }, ...(query.rule ? [{ rule: query.rule }] : [])],
      ...(query.state === "all" ? {} : { state: query.state }), ...(query.cursor ? { id: { gt: query.cursor } } : {}) },
      orderBy: focus ? [{ generatedAt: "desc" }, { id: "asc" }] : { id: "asc" }, take: limit + 1 });
    const page = rows.slice(0, limit);
    const { evidence } = await loadBusinessEvidence(tx, access.auth, page.map(keyOf), now);
    return { items: await withOutcome(tx, access.auth, page, page.map(row => view(row, evidence.get(metricKey(row)), now))), nextCursor: !focus && rows.length > limit ? page.at(-1)!.id : null,
      coverage: await coverage(tx, access.tenantId) };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}
export async function getBusinessInsight(db: PrismaClient, auth: AuthContext, id: string, now = new Date()): Promise<BusinessInsightDetail> {
  return db.$transaction(async tx => {
    const access = await authorize(tx, auth);
    const row = await tx.businessInsight.findFirst({ where: { id, tenantId: access.tenantId } });
    if (!row) throw new ApiError(404, "not_found", "Вывод не найден.");
    const { evidence } = await loadBusinessEvidence(tx, access.auth, [keyOf(row)], now);
    const [result] = await withOutcome(tx, access.auth, [row], [view(row, evidence.get(metricKey(row)), now)]);
    // History contains metadata only, never previous source titles or text.
    const events = await tx.businessInsightEvent.findMany({ where: { tenantId: access.tenantId, insightId: row.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30 });
    return { ...result, history: events.map(e => ({ id: e.id, type: e.type, at: e.createdAt.toISOString(), version: e.version, actor: e.userId ? "employee" : "system" })) };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}
export async function decideBusinessInsight(db: PrismaClient, auth: AuthContext, id: string, decision: "acknowledge" | "dismiss", input: unknown, now = new Date()) {
  const body = parse(insightDecisionSchema, input);
  return db.$transaction(async tx => {
    const access = await authorize(tx, auth), tenantId = access.tenantId;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 411012026))`;
    const row = await tx.businessInsight.findFirst({ where: { id, tenantId, isCurrent: true } });
    if (!row) throw new ApiError(404, "not_found", "Вывод не найден.");
    const requestHash = evidenceHash({ id, decision, version: body.version, fingerprint: body.fingerprint });
    const replay = await tx.businessInsightEvent.findUnique({ where: { tenantId_userId_requestId: { tenantId, userId: auth.user.id, requestId: body.requestId } } });
    if (replay && replay.requestHash !== requestHash) throw new ApiError(409, "request_conflict", "Этот запрос уже использован для другого действия.");
    const { evidence } = await loadBusinessEvidence(tx, access.auth, [keyOf(row)], now);
    const fact = evidence.get(metricKey(row));
    if (replay) return view(row, fact, now);
    if (view(row, fact, now).stale || !fact?.active || !["open", "acknowledged", "dismissed"].includes(row.state)
      || row.version !== body.version || row.fingerprint !== body.fingerprint) {
      throw new ApiError(409, "insight_stale", "Данные изменились. Обновите вывод и проверьте его основание.");
    }
    const state = decision === "acknowledge" ? "acknowledged" : "dismissed";
    const updated = await tx.businessInsight.update({ where: { id }, data: { state, version: { increment: 1 } } });
    await tx.businessInsightEvent.create({ data: { tenantId, insightId: id, userId: auth.user.id, requestId: body.requestId, requestHash, type: state, version: updated.version, createdAt: now } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, entityType: "business_insight", entityId: id, action: `business_insight.${state}`, changes: { rule: row.rule, occurrence: row.occurrence, version: updated.version } });
    return view(updated, fact, now);
  }, { timeout: 20_000 });
}

/** One bounded pass; no outgoing notices, CRM mutations or LLM calls. */
export async function sweepBusinessInsightTenant(db: PrismaClient, tenantId: string, options: { now?: Date; pageSize?: number; auth?: AuthContext; insightId?: string } = {}) {
  const now = options.now || new Date(), take = Math.max(1, Math.min(30, options.pageSize || 20));
  return db.$transaction(async tx => {
    const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${tenantId}, 411012026)) AS locked`;
    if (!lock?.locked) return false;
    const auth = options.auth ? (await authorize(tx, options.auth)).auth : await situationWorkerAuth(tx, tenantId);
    if (!auth || auth.activeMembership?.tenantId !== tenantId) return false;
    const state = await tx.businessInsightScan.upsert({ where: { tenantId }, update: {}, create: { tenantId, nextRunAt: now } });
    // Explicit item refresh is bounded to one source. Company scans are paced.
    if (!options.insightId && state.nextRunAt > now) return false;
    const cursors = { ...record(state.cursorsJson) }, cov = { ...record(state.coverageJson) };
    const keys: InsightKey[] = [];
    if (options.insightId) {
      const row = await tx.businessInsight.findFirst({ where: { id: options.insightId, tenantId, isCurrent: true } });
      if (!row) throw new ApiError(404, "not_found", "Вывод не найден.");
      keys.push(keyOf(row));
    } else {
      const page = (kind: string) => ({ where: { tenantId, ...(cursors[kind] ? { id: { gt: cursors[kind] as string } } : {}) }, orderBy: { id: "asc" as const }, take: take + 1, select: { id: true } });
      const pages = await Promise.all([
        tx.task.findMany({ ...page("task"), where: { ...page("task").where, status: { in: ["open", "in_progress", "waiting"] } } }),
        tx.inquiry.findMany({ ...page("inquiry"), where: { ...page("inquiry").where, status: "new", archived: false, test: false } }),
        tx.deal.findMany({ ...page("deal"), where: { ...page("deal").where, outcome: "open" } }),
      ]);
      (["task", "inquiry", "deal"] as const).forEach((kind, i) => {
        const page = pages[i].slice(0, take), more = pages[i].length > take;
        cursors[kind] = more ? page.at(-1)!.id : "";
        if (!more) cov[kind] = now.toISOString();
        for (const row of page) for (const [rule, spec] of Object.entries(METRIC_REGISTRY)) if (spec.entityKind === kind) keys.push({ rule: rule as BusinessInsightRule, entityKind: kind, entityId: row.id });
      });
      const known = await tx.businessInsight.findMany({ where: { tenantId, isCurrent: true, state: { not: "resolved" }, entityKind: { not: "company" } }, orderBy: [{ checkedAt: "asc" }, { id: "asc" }], take });
      keys.push(...known.map(keyOf));
      if (!cov.forecast || now.getTime() - Date.parse(cov.forecast.checkedAt) >= 5 * INTERVAL) keys.push({ rule: "sales_plan_risk", entityKind: "company", entityId: tenantId });
    }
    const unique = [...new Map(keys.map(k => [metricKey(k), k])).values()];
    const loaded = await loadBusinessEvidence(tx, auth, unique, now);
    const previous = unique.length ? await tx.businessInsight.findMany({ where: { tenantId, isCurrent: true, OR: unique.map(k => ({ rule: k.rule, entityId: k.entityId })) } }) : [];
    const old = new Map(previous.map(row => [metricKey(row), row]));
    for (const key of unique) await observeBusinessInsight(tx, tenantId, key, loaded.evidence.get(metricKey(key)), old.get(metricKey(key)) || null, now);
    if (loaded.forecast) cov.forecast = loaded.forecast;
    if (!options.insightId) await tx.businessInsightScan.update({ where: { tenantId }, data: { cursorsJson: json(cursors), coverageJson: json(cov), lastRunAt: now, nextRunAt: new Date(now.getTime() + INTERVAL) } });
    return true;
  }, { isolationLevel: "RepeatableRead", timeout: 30_000 });
}
export async function refreshBusinessInsights(db: PrismaClient, auth: AuthContext, input: unknown = {}, now = new Date()) {
  const body = parse(z.object({ insightId: z.string().uuid().optional() }).strict(), input);
  const tenantId = requireTenant(auth).tenantId;
  const advanced = await sweepBusinessInsightTenant(db, tenantId, { auth, insightId: body.insightId, now });
  // The regular list performs fresh authorization even when the scan lock was busy.
  return { advanced, ...(await listBusinessInsights(db, auth, {}, now)) };
}
export async function sweepBusinessInsights(db: PrismaClient, now = new Date()) {
  const missing = await db.tenant.findMany({ where: { status: "active", businessInsightScan: null }, orderBy: { id: "asc" }, take: 100, select: { id: true } });
  if (missing.length) await db.businessInsightScan.createMany({ data: missing.map(t => ({ tenantId: t.id, nextRunAt: now })), skipDuplicates: true });
  const due = await db.businessInsightScan.findMany({ where: { nextRunAt: { lte: now }, tenant: { status: "active" } }, orderBy: [{ nextRunAt: "asc" }, { tenantId: "asc" }], take: 3 });
  for (const state of due) {
    try { await sweepBusinessInsightTenant(db, state.tenantId, { now }); }
    catch (error) { logServerError(error, "background:business insights"); }
    // Also pace tenants without an active administrator and failures.
    await db.businessInsightScan.updateMany({ where: { tenantId: state.tenantId, nextRunAt: { lte: now } }, data: { nextRunAt: new Date(now.getTime() + INTERVAL) } });
  }
}
