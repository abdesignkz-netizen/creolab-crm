import { Prisma, type PrismaClient } from "@creolab/db";
import { goalCreateSchema, goalChangeSchema, goalListSchema, goalLinkSchema, goalRefreshSchema,
  type BusinessGoalView, type BusinessGoalDetail, type GoalMetric, type GoalOptions, type GoalMeasurementView, type GoalSample } from "@creolab/contracts";
import { z } from "zod";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { isCompanyAdmin, requireTenant } from "../lib/access.ts";
import { authForUserInTenant } from "./authService.ts";
import { writeAudit } from "../lib/audit.ts";
import { sha256 } from "../lib/hash.ts";
import { logServerError } from "../lib/redact.ts";
import { parseOpsSettings } from "./dealPipeline.ts";
import { forecastMonth } from "./salesForecastPolicy.ts";
import { resolvePeriodRange, zonedYmd } from "./periodRange.ts";
import { emptyGoalSample, goalProgress, goalTarget, goalTaskScope, measureGoalFacts } from "./businessGoalMetrics.ts";
import { situationWorkerAuth } from "./situationWorkerAuth.ts";

type Tx = Prisma.TransactionClient;
type BusinessGoal = Prisma.BusinessGoalGetPayload<Record<string, never>>;
type GoalMeasurement = Prisma.GoalMeasurementGetPayload<Record<string, never>>;
const DAY = 86400000, MAX_ACTIVE = 50;
const roles = ["owner", "director", "sales_lead"];
const txOptions = { maxWait: 10_000, timeout: 25_000 };
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const record = (v: unknown): Record<string, any> => v && typeof v === "object" ? v as Record<string, any> : {};
const stableJson = (v: unknown) => JSON.stringify(v, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
function parse<T>(schema: z.ZodType<T>, raw: unknown) { const p = schema.safeParse(raw); if (!p.success) throw new ApiError(422, "invalid_goal", p.error.issues[0]?.message || "Проверьте параметры цели."); return p.data; }
async function authorize(db: Tx | PrismaClient, auth: AuthContext, write = false) {
  if (auth.configurationTenant) throw new ApiError(403, "forbidden", "Цели доступны в кабинете компании.");
  const fresh = await authForUserInTenant(db, auth.user.id, requireTenant(auth).tenantId, auth.sessionId);
  const m = requireTenant(fresh);
  if (!roles.includes(m.role) || (write && !isCompanyAdmin(fresh))) throw new ApiError(403, "forbidden", write ? "Цели настраивает владелец или директор." : "Цели доступны руководителям компании.");
  return { auth: fresh, tenantId: m.tenantId, canEdit: isCompanyAdmin(fresh) };
}
async function lockTenant(db: Tx, tenantId: string) { await db.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`; }
async function owner(db: Tx, tenantId: string, id: string) {
  const m = await db.membership.findFirst({ where: { tenantId, id, active: true, role: { in: roles }, user: { status: "active" } }, select: { id: true } });
  if (!m) throw new ApiError(422, "goal_owner", "Выберите действующего руководителя компании.");
}
async function goalRow(db: Tx, tenantId: string, id: string) {
  const g = await db.businessGoal.findFirst({ where: { tenantId, id } });
  if (!g) throw new ApiError(404, "not_found", "Цель не найдена."); return g;
}
async function availableTasks(db: Tx, tenantId: string, options: { ids?: string[]; query?: string; open?: boolean }) {
  if (options.ids && !options.ids.length) return [];
  return db.$queryRaw<Array<{ id: string; title: string; status: string }>>(Prisma.sql`
    SELECT t.id, t.title, t.status FROM "Task" t WHERE ${goalTaskScope(tenantId)}
      ${options.ids ? Prisma.sql`AND t.id IN (${Prisma.join(options.ids)})` : Prisma.empty}
      ${options.open ? Prisma.sql`AND t.status IN ('open','in_progress','waiting')` : Prisma.empty}
      ${options.query ? Prisma.sql`AND strpos(lower(t.title), lower(${options.query.trim().slice(0, 120)})) > 0` : Prisma.empty}
    ORDER BY t."createdAt" DESC, t.id ASC LIMIT ${options.ids ? 30 : 20}`);
}
function measurement(row: GoalMeasurement): GoalMeasurementView {
  const r = record(row.resultJson);
  return { id: row.id, version: row.version, at: row.measuredAt.toISOString(), asOf: row.asOf.toISOString(), target: r.target ?? null,
    baseline: r.baseline ?? null, sample: r.sample, progress: r.progress ?? null, reached: r.reached ?? null };
}
async function view(db: Tx, auth: AuthContext, g: BusinessGoal, now: Date): Promise<BusinessGoalView> {
  const [tenant, member, last] = await Promise.all([
    db.tenant.findUniqueOrThrow({ where: { id: g.tenantId }, select: { settingsJson: true, timezone: true } }),
    db.membership.findFirst({ where: { tenantId: g.tenantId, id: g.ownerMembershipId }, select: { id: true, active: true, role: true, user: { select: { name: true, status: true } } } }),
    db.goalMeasurement.findFirst({ where: { tenantId: g.tenantId, goalId: g.id }, orderBy: [{ version: "desc" }, { measuredAt: "desc" }, { id: "desc" }] }),
  ]);
  const current = last ? measurement(last) : null, target = goalTarget(g, tenant.settingsJson), baseline = record(g.baselineJson);
  const targetChanged = Boolean(current && current.target !== target);
  const configChanged = tenant.timezone !== g.timezone;
  // Archiving changes the goal version, but keeps its last measured result.
  const versionChanged = g.state === "active" && last?.version !== g.version;
  const stale = !last || versionChanged || targetChanged || configChanged || (g.state === "active" && Boolean(g.nextCheckAt && g.nextCheckAt <= now));
  return { id: g.id, title: g.title, metric: g.metric as GoalMetric, state: g.state as BusinessGoalView["state"], version: g.version,
    from: g.periodStart.toISOString(), to: g.periodEnd.toISOString(), timezone: g.timezone, currency: g.currency, salesMonth: g.salesMonth, target,
    owner: { id: g.ownerMembershipId, name: member?.user.name || "Сотрудник недоступен", active: Boolean(member?.active && member.user.status === "active" && roles.includes(member.role)) },
    canEdit: isCompanyAdmin(auth), targetChanged,
    baseline: baseline.at ? { value: baseline.value ?? null, at: baseline.at, status: baseline.status } : null,
    current: current && (targetChanged || configChanged || versionChanged) ? { ...current, progress: null, reached: null } : current,
    nextCheckAt: g.nextCheckAt?.toISOString() || null, stale, periodEnded: now >= g.periodEnd };
}
async function detail(db: Tx, auth: AuthContext, g: BusinessGoal, now: Date): Promise<BusinessGoalDetail> {
  const [base, measurements, events, links] = await Promise.all([
    view(db, auth, g, now), db.goalMeasurement.findMany({ where: { tenantId: g.tenantId, goalId: g.id }, orderBy: [{ version: "desc" }, { measuredAt: "desc" }, { id: "desc" }], take: 30 }),
    db.businessGoalEvent.findMany({ where: { tenantId: g.tenantId, goalId: g.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30 }),
    db.goalInitiative.findMany({ where: { tenantId: g.tenantId, goalId: g.id }, orderBy: { id: "asc" }, take: 30 }),
  ]);
  const tasks = await availableTasks(db, g.tenantId, { ids: links.map(l => l.taskId) });
  const runs = await db.actionRun.findMany({ where: { tenantId: g.tenantId, userId: auth.user.id, id: { in: links.flatMap(l => l.actionRunId ? [l.actionRunId] : []) } }, select: { id: true } });
  return { ...base, measurements: measurements.map(measurement), history: events.map(e => ({ id: e.id, type: e.type, at: e.createdAt.toISOString(), version: e.version, changes: record(e.changesJson) })),
    initiatives: links.flatMap(l => { const t = tasks.find(t => t.id === l.taskId); return t ? [{ id: l.id, taskId: t.id, title: t.title, status: t.status, runId: runs.find(r => r.id === l.actionRunId)?.id || null }] : []; }) };
}
async function event(db: Tx, g: BusinessGoal, type: string, changes: unknown, now: Date, userId?: string, requestId?: string, requestHash?: string) {
  await db.businessGoalEvent.create({ data: { tenantId: g.tenantId, goalId: g.id, type, version: g.version, changesJson: json(changes), createdAt: now, userId, requestId, requestHash } });
}
async function replay(db: Tx, tenantId: string, userId: string, requestId: string, hash: string) {
  const old = await db.businessGoalEvent.findUnique({ where: { tenantId_userId_requestId: { tenantId, userId, requestId } } });
  if (old && old.requestHash !== hash) throw new ApiError(409, "request_conflict", "Этот запрос уже использован для другого изменения."); return old;
}
/** Called under the tenant lock. At most one scheduled checkpoint per day,
 * plus deliberate refreshes. No task, sales target or outbound message writes. */
async function measure(db: Tx, g: BusinessGoal, now: Date) {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: g.tenantId }, select: { timezone: true, settingsJson: true } });
  const target = goalTarget(g, tenant.settingsJson);
  let sample: GoalSample = tenant.timezone !== g.timezone ? emptyGoalSample(g.metric as GoalMetric, "config_changed")
    : g.metric === "sales_won" && target === null ? emptyGoalSample("sales_won", "plan_missing") : await measureGoalFacts(db, g, now);
  const last = await db.goalMeasurement.findFirst({ where: { tenantId: g.tenantId, goalId: g.id }, orderBy: [{ version: "desc" }, { measuredAt: "desc" }, { id: "desc" }] });
  let asOf = now < g.periodStart ? now : new Date(Math.min(now.getTime(), g.periodEnd.getTime()));
  if (sample.status === "ended_snapshot") {
    // Never pretend today's Task.status is its historical state at the deadline.
    const prior = last ? record(last.resultJson).sample as GoalSample : null;
    if (prior && ["ready", "ended_snapshot"].includes(prior.status)) sample = { ...prior, status: "ended_snapshot" };
    asOf = last?.asOf || g.periodEnd;
  }
  let baseline = record(g.baselineJson);
  if (!baseline.at && sample.status === "ready" && sample.value !== null && !sample.unanswered) {
    baseline = { value: sample.value, at: asOf.toISOString(), status: sample.status };
    await db.businessGoal.update({ where: { id: g.id }, data: { baselineJson: json(baseline) } });
  }
  const result = { sample, target, baseline: baseline.value ?? null, ...goalProgress(g.metric as GoalMetric, sample, target, baseline.value ?? null) };
  const day = zonedYmd(now, g.timezone);
  const checkpoint = stableJson({ result, day });
  const previousDay = last ? zonedYmd(last.measuredAt, g.timezone) : null;
  const unchanged = last && last.version === g.version && checkpoint === stableJson({ result: last.resultJson, day: previousDay });
  const fingerprint = unchanged ? last.fingerprint : sha256(JSON.stringify({ checkpoint, previous: last?.id || null, version: g.version }));
  await db.goalMeasurement.upsert({ where: { tenantId_goalId_version_fingerprint: { tenantId: g.tenantId, goalId: g.id, version: g.version, fingerprint } }, update: {},
    create: { tenantId: g.tenantId, goalId: g.id, version: g.version, measuredAt: now, asOf, fingerprint, resultJson: json(result) } });
  const nextCheckAt = now >= g.periodEnd ? null : now < g.periodStart ? g.periodStart : new Date(Math.min(now.getTime() + DAY, g.periodEnd.getTime()));
  await db.businessGoal.update({ where: { id: g.id }, data: { lastMeasuredAt: now, nextCheckAt } });
}
export async function businessGoalOptions(db: PrismaClient, auth: AuthContext): Promise<GoalOptions> {
  const a = await authorize(db, auth), m = requireTenant(a.auth);
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: a.tenantId }, select: { settingsJson: true, timezone: true } });
  const members = await db.membership.findMany({ where: { tenantId: a.tenantId, active: true, role: { in: roles }, user: { status: "active" } }, select: { id: true, user: { select: { name: true } } }, orderBy: { id: "asc" }, take: 200 });
  return { canEdit: a.canEdit, timezone: tenant.timezone, selfId: m.id, members: members.map(m => ({ id: m.id, name: m.user.name })), salesPlans: parseOpsSettings(tenant.settingsJson).salesPlans };
}
export async function listBusinessGoals(db: PrismaClient, auth: AuthContext, input: unknown = {}, now = new Date(), focus = false) {
  const query = parse(goalListSchema, input);
  const limit = focus ? 3 : 20;
  return db.$transaction(async tx => {
    const a = await authorize(tx, auth);
    const rows = await tx.businessGoal.findMany({ where: { tenantId: a.tenantId, ...(query.state === "all" ? {} : { state: query.state }), ...(query.cursor ? { id: { gt: query.cursor } } : {}) }, orderBy: focus ? [{ updatedAt: "desc" }, { id: "asc" }] : { id: "asc" }, take: limit + 1 });
    return { items: await Promise.all(rows.slice(0, limit).map(g => view(tx, a.auth, g, now))), nextCursor: !focus && rows.length > limit ? rows[limit - 1].id : null, canEdit: a.canEdit };
  }, { ...txOptions, isolationLevel: "RepeatableRead" });
}
export async function getBusinessGoal(db: PrismaClient, auth: AuthContext, id: string, now = new Date()) {
  return db.$transaction(async tx => { const a = await authorize(tx, auth); return detail(tx, a.auth, await goalRow(tx, a.tenantId, id), now); }, { ...txOptions, isolationLevel: "RepeatableRead" });
}
export async function createBusinessGoal(db: PrismaClient, auth: AuthContext, raw: unknown, now = new Date()) {
  const input = parse(goalCreateSchema, raw), hash = sha256(JSON.stringify({ operation: "create", input }));
  return db.$transaction(async tx => {
    await lockTenant(tx, requireTenant(auth).tenantId); const a = await authorize(tx, auth, true);
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: a.tenantId }, select: { settingsJson: true, timezone: true } });
    const old = await replay(tx, a.tenantId, auth.user.id, input.requestId, hash);
    if (old) return detail(tx, a.auth, await goalRow(tx, a.tenantId, old.goalId), now);
    await owner(tx, a.tenantId, input.ownerMembershipId);
    if (await tx.businessGoal.count({ where: { tenantId: a.tenantId, state: "active" } }) >= MAX_ACTIVE) throw new ApiError(409, "goal_limit", "Архивируйте завершённые цели: доступно до 50 активных целей.");
    let from: Date, to: Date;
    if (input.metric === "sales_won") {
      const plan = parseOpsSettings(tenant.settingsJson).salesPlans.find(p => p.month === input.salesMonth && p.currency === input.currency);
      if (!plan || plan.amount <= 0) throw new ApiError(422, "goal_plan", "Выберите существующий положительный план продаж.");
      const [year, month] = input.salesMonth!.split("-").map(Number), range = forecastMonth(tenant.timezone, year, month);
      from = range.from; to = range.to;
      const existing = await tx.businessGoal.findUnique({ where: { tenantId_bindingKey: { tenantId: a.tenantId, bindingKey: `${input.salesMonth}:${input.currency}` } } });
      if (existing) throw new ApiError(409, "goal_exists", "Этот месячный план уже связан с целью. Откройте её в списке или архиве.");
    } else { const range = resolvePeriodRange(tenant.timezone, "custom", input.from, input.to, now); from = range.from!; to = range.to!; }
    if (to <= now || to.getTime() - from.getTime() > 366 * DAY || from.getTime() > now.getTime() + 366 * DAY) throw new ApiError(422, "goal_period", "Выберите незавершённый период продолжительностью не более года, с началом в пределах следующего года.");
    const g = await tx.businessGoal.create({ data: { tenantId: a.tenantId, title: input.title, metric: input.metric, ownerMembershipId: input.ownerMembershipId,
      periodStart: from, periodEnd: to, timezone: tenant.timezone, currency: input.currency, salesMonth: input.salesMonth,
      bindingKey: input.metric === "sales_won" ? `${input.salesMonth}:${input.currency}` : null, target: input.metric === "sales_won" ? null : input.target, nextCheckAt: now } });
    await event(tx, g, "created", { metric: g.metric, target: goalTarget(g, tenant.settingsJson), from, to, timezone: g.timezone, ownerMembershipId: g.ownerMembershipId }, now, auth.user.id, input.requestId, hash);
    await writeAudit(tx, { tenantId: a.tenantId, actorUserId: auth.user.id, action: "goal.created", entityType: "business_goal", entityId: g.id, changes: { metric: g.metric, title: g.title } });
    await measure(tx, g, now);
    return detail(tx, a.auth, await goalRow(tx, a.tenantId, g.id), now);
  }, txOptions);
}
export async function updateBusinessGoal(db: PrismaClient, auth: AuthContext, id: string, raw: unknown, now = new Date()) {
  const input = parse(goalChangeSchema, raw), hash = sha256(JSON.stringify({ operation: "update", id, input }));
  return db.$transaction(async tx => {
    await lockTenant(tx, requireTenant(auth).tenantId); const a = await authorize(tx, auth, true), g = await goalRow(tx, a.tenantId, id);
    if (await replay(tx, a.tenantId, auth.user.id, input.requestId, hash)) return detail(tx, a.auth, g, now);
    if (input.version !== g.version) throw new ApiError(409, "goal_changed", "Цель уже изменена. Обновите её перед сохранением.");
    if (input.target !== undefined && (g.metric === "sales_won" || g.metric === "overdue_tasks" && !Number.isSafeInteger(input.target) || g.metric === "first_response_minutes" && (input.target < 0.01 || input.target > 10080))) throw new ApiError(422, "goal_target", "План продаж изменяется в настройках продаж. Для остальных целей проверьте число и единицы.");
    if (now >= g.periodEnd && (input.target !== undefined || input.state === "active")) throw new ApiError(409, "goal_ended", "Период цели завершён. Создайте новую цель; история прежней сохранится.");
    if (input.ownerMembershipId) await owner(tx, a.tenantId, input.ownerMembershipId);
    if (g.state === "archived" && input.state === "active" && await tx.businessGoal.count({ where: { tenantId: a.tenantId, state: "active" } }) >= MAX_ACTIVE) throw new ApiError(409, "goal_limit", "Доступно до 50 активных целей.");
    const updated = await tx.businessGoal.update({ where: { id }, data: { title: input.title, ownerMembershipId: input.ownerMembershipId, target: input.target, state: input.state, version: { increment: 1 }, nextCheckAt: input.state === "archived" ? null : now } });
    const changes = { before: { title: g.title, target: g.target?.toString() ?? null, ownerMembershipId: g.ownerMembershipId, state: g.state }, after: { title: updated.title, target: updated.target?.toString() ?? null, ownerMembershipId: updated.ownerMembershipId, state: updated.state } };
    await event(tx, updated, "changed", changes, now, auth.user.id, input.requestId, hash);
    await writeAudit(tx, { tenantId: a.tenantId, actorUserId: auth.user.id, action: "goal.changed", entityType: "business_goal", entityId: id, changes });
    if (updated.state === "active") await measure(tx, updated, now);
    return detail(tx, a.auth, await goalRow(tx, a.tenantId, id), now);
  }, txOptions);
}
export async function refreshBusinessGoal(db: PrismaClient, auth: AuthContext, id: string, raw: unknown, now = new Date()) {
  const input = parse(goalRefreshSchema, raw), hash = sha256(JSON.stringify({ operation: "refresh", id, input }));
  return db.$transaction(async tx => {
    await lockTenant(tx, requireTenant(auth).tenantId); const a = await authorize(tx, auth), g = await goalRow(tx, a.tenantId, id);
    if (await replay(tx, a.tenantId, auth.user.id, input.requestId, hash)) return detail(tx, a.auth, g, now);
    if (g.state !== "active") throw new ApiError(409, "goal_archived", "Цель в архиве. Сохранённые измерения доступны в истории.");
    if (g.lastMeasuredAt && now.getTime() - g.lastMeasuredAt.getTime() < 60_000) throw new ApiError(429, "goal_recent", "Измерение выполнено недавно. Повторите через минуту.");
    await measure(tx, g, now); await event(tx, g, "measured", {}, now, auth.user.id, input.requestId, hash);
    return detail(tx, a.auth, await goalRow(tx, a.tenantId, id), now);
  }, txOptions);
}
export async function goalTaskChoices(db: PrismaClient, auth: AuthContext, q: string) {
  const a = await authorize(db, auth);
  const tasks = await availableTasks(db, a.tenantId, { query: q, open: true });
  return { items: tasks };
}
export async function linkGoalTask(db: PrismaClient, auth: AuthContext, id: string, raw: unknown, now = new Date()) {
  const input = parse(goalLinkSchema, raw), hash = sha256(JSON.stringify({ operation: "initiative", id, input }));
  return db.$transaction(async tx => {
    await lockTenant(tx, requireTenant(auth).tenantId); const a = await authorize(tx, auth, true), g = await goalRow(tx, a.tenantId, id);
    if (await replay(tx, a.tenantId, auth.user.id, input.requestId, hash)) return detail(tx, a.auth, g, now);
    if (g.version !== input.version || g.state !== "active" || now >= g.periodEnd) throw new ApiError(409, "goal_changed", "Обновите действующую цель перед изменением инициатив.");
    const key = { tenantId: a.tenantId, goalId: id, taskId: input.taskId };
    if (input.remove) await tx.goalInitiative.deleteMany({ where: key });
    else {
      const [t] = await availableTasks(tx, a.tenantId, { ids: [input.taskId], open: true });
      if (!t) throw new ApiError(404, "not_found", "Действующая задача не найдена.");
      if (await tx.goalInitiative.count({ where: { tenantId: a.tenantId, goalId: id } }) >= 30 && !await tx.goalInitiative.findUnique({ where: { tenantId_goalId_taskId: key } })) throw new ApiError(409, "goal_initiatives", "Для цели доступно до 30 связанных задач.");
      const step = await tx.actionStep.findFirst({ where: { tenantId: a.tenantId, taskId: t.id, status: "succeeded", run: { userId: auth.user.id } }, orderBy: { finishedAt: "desc" }, select: { runId: true } });
      await tx.goalInitiative.upsert({ where: { tenantId_goalId_taskId: key }, update: {}, create: { ...key, actionRunId: step?.runId } });
    }
    const updated = await tx.businessGoal.update({ where: { id }, data: { version: { increment: 1 }, nextCheckAt: now } });
    await event(tx, updated, input.remove ? "initiative_removed" : "initiative_added", { taskId: input.taskId }, now, auth.user.id, input.requestId, hash);
    await measure(tx, updated, now);
    return detail(tx, a.auth, await goalRow(tx, a.tenantId, id), now);
  }, txOptions);
}
/** The old ops editor remains the only writer for monetary targets. */
export async function recordSalesGoalPlanChanges(db: Tx, tenantId: string, oldSettings: unknown, newSettings: unknown, userId: string, now = new Date()) {
  const goals = await db.businessGoal.findMany({ where: { tenantId, metric: "sales_won" } });
  for (const g of goals) {
    const before = goalTarget(g, oldSettings), after = goalTarget(g, newSettings);
    if (before === after) continue;
    const updated = await db.businessGoal.update({ where: { id: g.id }, data: { version: { increment: 1 }, nextCheckAt: g.state === "active" ? now : null } });
    await event(db, updated, "sales_plan_changed", { before, after, month: g.salesMonth, currency: g.currency }, now, userId);
  }
}
export async function sweepBusinessGoals(db: PrismaClient, now = new Date()) {
  const due = await db.businessGoal.findMany({ where: { state: "active", nextCheckAt: { lte: now }, tenant: { status: "active" } }, orderBy: [{ nextCheckAt: "asc" }, { id: "asc" }], take: 5, select: { id: true, tenantId: true } });
  for (const candidate of due) {
    try { await db.$transaction(async tx => {
      await lockTenant(tx, candidate.tenantId);
      const g = await goalRow(tx, candidate.tenantId, candidate.id);
      if (g.state !== "active" || !g.nextCheckAt || g.nextCheckAt > now) return;
      const auth = await situationWorkerAuth(tx, g.tenantId);
      if (!auth) { await tx.businessGoal.update({ where: { id: g.id }, data: { nextCheckAt: new Date(now.getTime() + DAY) } }); return; }
      await authorize(tx, auth); await measure(tx, g, now);
    }, txOptions); } catch (error) {
      logServerError(error, "background:business goal");
      await db.businessGoal.updateMany({ where: { id: candidate.id, state: "active", nextCheckAt: { lte: now } }, data: { nextCheckAt: new Date(now.getTime() + 15 * 60_000) } });
    }
  }
}
