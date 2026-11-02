import { Prisma, type PrismaClient } from "@creolab/db";
import { z } from "zod";
import { experimentSaveSchema, experimentMethodSchema, experimentOperationSchema, experimentListSchema,
  type ExperimentMethod, type ExperimentSample, type ExperimentResult, type ExperimentOptions,
  type BusinessExperimentSummary, type BusinessExperimentDetail } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { isCompanyAdmin, requireTenant } from "../lib/access.ts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { authForUserInTenant } from "./authService.ts";
import { resolvePeriodRange, zonedYmd, pad } from "./periodRange.ts";
import { goalTaskScope } from "./businessGoalMetrics.ts";
import { validateDecisionRefs, businessMemoryContext } from "./businessMemoryService.ts";
import { validateDecisionText } from "./businessDecisionSource.ts";
import { measureProposalPreparation, compareExperiment, EXPERIMENT_METHOD_VERSION, EXPERIMENT_LIMITATIONS, stableExperimentHash } from "./businessExperimentMetrics.ts";

type Tx = Prisma.TransactionClient;
type Row = Prisma.BusinessExperimentGetPayload<Record<string, never>>;
const options = { maxWait: 10000, timeout: 25000 }, DAY = 86400000;
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
function parse<T>(schema: z.ZodType<T>, raw: unknown) { const r = schema.safeParse(raw); if (!r.success) throw new ApiError(422, "invalid_experiment", r.error.issues[0]?.message || "Проверьте условия проверки."); return r.data; }
function safeText(text: string) { if (!validateDecisionText({ topic: text, title: "", body: "", rationale: "" })) throw new ApiError(422, "sensitive_text", "Не сохраняйте пароли и ключи в описании проверки."); }
async function authorize(db: Tx | PrismaClient, auth: AuthContext, write = false) {
  if (auth.configurationTenant) throw new ApiError(403, "forbidden", "Проверки доступны в кабинете компании.");
  const fresh = await authForUserInTenant(db, auth.user.id, requireTenant(auth).tenantId, auth.sessionId), m = requireTenant(fresh);
  if (!["owner", "director", "sales_lead"].includes(m.role) || write && !isCompanyAdmin(fresh)) throw new ApiError(403, "forbidden", "Проверки утверждает владелец или директор. Просмотр доступен руководителям.");
  return { auth: fresh, tid: m.tenantId, canEdit: isCompanyAdmin(fresh) };
}
async function lock(db: Tx, auth: AuthContext) { await db.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${requireTenant(auth).tenantId} FOR UPDATE`; }
async function row(db: Tx, tid: string, id: string) { const r = await db.businessExperiment.findFirst({ where: { tenantId: tid, id } }); if (!r) throw new ApiError(404, "not_found", "Проверка не найдена."); return r; }
function ranges(method: ExperimentMethod, timezone: string, now: Date, preparing = false) {
  const b = resolvePeriodRange(timezone, "custom", method.baselineFrom, method.baselineTo, now), c = resolvePeriodRange(timezone, "custom", method.from, method.to, now);
  const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY + 1;
  const duration = days(method.from, method.to);
  if (![7, 14, 28].includes(duration) || duration !== days(method.baselineFrom, method.baselineTo) || b.to! > c.from!) throw new ApiError(422, "experiment_period", "Выберите два непересекающихся периода одинаковой длины: 7, 14 или 28 дней.");
  if (preparing && (b.to! > now || c.from! < now || c.from!.getTime() > now.getTime() + 31 * DAY || b.from!.getTime() < now.getTime() - 180 * DAY)) {
    throw new ApiError(422, "experiment_period", "Исходный период должен завершиться; проверку можно начать в течение следующих 31 дней. История — не старше 180 дней.");
  }
  return { baselineFrom: b.from!, baselineTo: b.to!, from: c.from!, to: c.to! };
}
async function initiative(db: Tx, tid: string, taskId: string, userId: string) {
  const [t] = await db.$queryRaw<Array<{ id: string; title: string; description: string | null; ownerMembershipId: string | null; type: string; status: string; completedAt: Date | null }>>(Prisma.sql`
    SELECT t.id, t.title, t.description, t."ownerMembershipId", t.type, t.status, t."completedAt" FROM "Task" t
    WHERE ${goalTaskScope(tid)} AND t.id = ${taskId} AND t.status <> 'canceled' AND t."parentTaskId" IS NULL AND t."targetType" <> 'group' LIMIT 1`);
  if (!t) return null;
  const step = await db.actionStep.findFirst({ where: { tenantId: tid, taskId, status: "succeeded", run: { userId, tenantId: tid } }, orderBy: { finishedAt: "desc" }, select: { runId: true } });
  return { ...t, href: `/tasks?open=${t.id}`, runHref: step ? `/control?view=plans&run=${step.runId}` : null };
}
async function validateRefs(db: Tx, auth: AuthContext, method: ExperimentMethod, now: Date) {
  const tid = requireTenant(auth).tenantId;
  if (!await initiative(db, tid, method.initiativeTaskId, auth.user.id)) throw new ApiError(422, "experiment_initiative", "Выберите доступную задачу внедрения изменения.");
  const members = await db.membership.count({ where: { tenantId: tid, id: { in: method.memberIds }, active: true, user: { status: "active" } } });
  if (members !== method.memberIds.length) throw new ApiError(422, "experiment_members", "Состав группы изменился. Выберите действующих сотрудников.");
  if (method.goal && !await db.businessGoal.findFirst({ where: { tenantId: tid, id: method.goal.id, version: method.goal.version, state: "active" } })) throw new ApiError(409, "experiment_goal", "Связанная цель изменилась или недоступна.");
  if (method.decision) {
    const shared = await db.businessDecision.findFirst({ where: { tenantId: tid, id: method.decision.id, privateUserId: null } });
    if (!shared) throw new ApiError(422, "experiment_decision", "Выберите общее утверждённое решение компании.");
    await validateDecisionRefs(db, auth, [method.decision], now);
  }
}
async function environment(db: Tx, tid: string, method: ExperimentMethod) {
  const [tenant, members, configs, task] = await Promise.all([
    db.tenant.findUniqueOrThrow({ where: { id: tid }, select: { timezone: true, settingsJson: true } }),
    db.membership.findMany({ where: { tenantId: tid, id: { in: method.memberIds } }, select: { id: true, role: true, active: true, permissions: true, user: { select: { status: true } } }, orderBy: { id: "asc" } }),
    db.aIConfiguration.findMany({ where: { tenantId: tid }, select: { id: true, model: true, enabled: true, publishedVersionId: true, systemPrompt: true }, orderBy: { id: "asc" }, take: 101 }),
    db.task.findFirst({ where: { tenantId: tid, id: method.initiativeTaskId }, select: { title: true, description: true, ownerMembershipId: true, type: true } }),
  ]);
  // Only a fingerprint is persisted, never settings, prompts, credentials or personal command text.
  if (configs.length > 100) throw new ApiError(422, "experiment_scope", "Слишком много настроек ИИ для этой ограниченной проверки.");
  return stableExperimentHash({ tenant, members, configs, task });
}
const summary = (r: Row): BusinessExperimentSummary => ({ id: r.id, title: r.title, state: r.state as BusinessExperimentSummary["state"], version: r.version, from: r.periodStart.toISOString(), to: r.periodEnd.toISOString(), updatedAt: r.updatedAt.toISOString() });
async function review(db: Tx, r: Row, now: Date) {
  const method = parse(experimentMethodSchema, r.methodJson), range = ranges(method, r.timezone, now);
  const baseline = await measureProposalPreparation(db, r.tenantId, method.memberIds, range.baselineFrom, range.baselineTo, now);
  const env = await environment(db, r.tenantId, method);
  return { baseline, env, hash: stableExperimentHash({ id: r.id, version: r.version, method, methodVersion: r.methodVersion, env, baseline: baseline.fingerprint }) };
}
async function detail(db: Tx, auth: AuthContext, r: Row, now: Date): Promise<BusinessExperimentDetail> {
  const method = parse(experimentMethodSchema, r.methodJson);
  const [events, measurements, task, draft, members] = await Promise.all([
    db.businessExperimentEvent.findMany({ where: { tenantId: r.tenantId, experimentId: r.id }, orderBy: [{ version: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: 30 }),
    db.experimentMeasurement.findMany({ where: { tenantId: r.tenantId, experimentId: r.id }, orderBy: [{ revision: "desc" }, { measuredAt: "desc" }, { id: "desc" }], take: 30 }),
    initiative(db, r.tenantId, method.initiativeTaskId, auth.user.id), r.state === "draft" ? review(db, r, now) : null,
    db.membership.findMany({ where: { tenantId: r.tenantId, id: { in: method.memberIds } }, select: { id: true, active: true, user: { select: { name: true, status: true } } } }),
  ]);
  return { ...summary(r), hypothesis: r.hypothesis, change: r.change, method, timezone: r.timezone, methodVersion: r.methodVersion,
    canEdit: isCompanyAdmin(auth), baseline: draft?.baseline || r.baselineJson as ExperimentSample | null, reviewHash: draft?.hash || null,
    result: measurements[0]?.resultJson as ExperimentResult || null, approvedAt: r.approvedAt?.toISOString() || null, stopReason: r.stopReason,
    initiative: task ? { id: task.id, title: task.title, status: task.status, href: task.href, runHref: task.runHref } : null,
    members: method.memberIds.map(id => { const m = members.find(m => m.id === id); return { id, name: m?.user.name || "Недоступный сотрудник", active: Boolean(m?.active && m.user.status === "active") }; }),
    history: events.map(e => ({ id: e.id, type: e.type, at: e.createdAt.toISOString(), version: e.version, note: e.note })),
    measurements: measurements.map(m => ({ id: m.id, at: m.measuredAt.toISOString(), result: m.resultJson as ExperimentResult })), limitations: EXPERIMENT_LIMITATIONS };
}
async function event(db: Tx, auth: AuthContext, r: Row, type: string, input: { requestId: string }, requestHash: string, now: Date, note?: string) {
  await db.businessExperimentEvent.create({ data: { tenantId: r.tenantId, experimentId: r.id, userId: auth.user.id, version: r.version, type, requestId: input.requestId, requestHash, createdAt: now, note } });
  await writeAudit(db, { tenantId: r.tenantId, actorUserId: auth.user.id, entityType: "business_experiment", entityId: r.id, action: `experiment.${type}`, changes: { version: r.version, ...(note ? { note } : {}) } });
}
async function replay(db: Tx, tid: string, userId: string, requestId: string, hash: string) {
  const old = await db.businessExperimentEvent.findUnique({ where: { tenantId_userId_requestId: { tenantId: tid, userId, requestId } } });
  if (old && old.requestHash !== hash) throw new ApiError(409, "request_conflict", "Этот запрос уже использован для другого изменения."); return old;
}
export async function experimentOptions(db: PrismaClient, auth: AuthContext, now = new Date()): Promise<ExperimentOptions> {
  return db.$transaction(async tx => {
    const a = await authorize(tx, auth), tenant = requireTenant(a.auth).tenant;
    const [members, goals, memory] = await Promise.all([
      tx.membership.findMany({ where: { tenantId: a.tid, active: true, user: { status: "active" } }, select: { id: true, user: { select: { name: true } } }, orderBy: { id: "asc" }, take: 200 }),
      tx.businessGoal.findMany({ where: { tenantId: a.tid, state: "active" }, select: { id: true, title: true, version: true }, orderBy: { updatedAt: "desc" }, take: 50 }),
      businessMemoryContext(tx, a.auth, {}, now),
    ]);
    const shared = await tx.businessDecision.findMany({ where: { tenantId: a.tid, id: { in: memory.entries.map(d => d.id) }, privateUserId: null }, select: { id: true } });
    const day = zonedYmd(now, tenant.timezone);
    return { canEdit: a.canEdit, timezone: tenant.timezone, today: `${day.year}-${pad(day.month)}-${pad(day.day)}`, members: members.map(m => ({ id: m.id, name: m.user.name })), goals,
      decisions: memory.entries.filter(d => shared.some(s => s.id === d.id)).map(d => ({ id: d.id, title: d.title, version: d.version })) };
  }, options);
}
export async function experimentTaskChoices(db: PrismaClient, auth: AuthContext, q: string) {
  return db.$transaction(async tx => {
    const a = await authorize(tx, auth);
    const items = await tx.$queryRaw<Array<{ id: string; title: string }>>(Prisma.sql`SELECT t.id, t.title FROM "Task" t
      WHERE ${goalTaskScope(a.tid)} AND t.status IN ('open','in_progress','waiting','done') AND t."parentTaskId" IS NULL AND t."targetType" <> 'group'
        AND strpos(lower(t.title), lower(${q.trim().slice(0, 120)})) > 0
      ORDER BY t."createdAt" DESC, t.id LIMIT 20`);
    return { items };
  }, options);
}
export async function listExperiments(db: PrismaClient, auth: AuthContext, raw: unknown = {}) {
  const input = parse(experimentListSchema, raw);
  return db.$transaction(async tx => {
    const a = await authorize(tx, auth), rows = await tx.businessExperiment.findMany({ where: { tenantId: a.tid,
      ...(input.state === "all" ? {} : { state: { in: input.state === "active" ? ["draft", "running"] : ["completed", "stopped"] } }), ...(input.cursor ? { id: { gt: input.cursor } } : {}) }, orderBy: { id: "asc" }, take: 21 });
    return { items: rows.slice(0, 20).map(summary), canEdit: a.canEdit, nextCursor: rows.length > 20 ? rows[19].id : null };
  }, options);
}
export async function getExperiment(db: PrismaClient, auth: AuthContext, id: string, now = new Date()) {
  return db.$transaction(async tx => { const a = await authorize(tx, auth); return detail(tx, a.auth, await row(tx, a.tid, id), now); }, { ...options, isolationLevel: "RepeatableRead" });
}
export async function saveExperiment(db: PrismaClient, auth: AuthContext, id: string | null, raw: unknown, now = new Date()) {
  const input = parse(experimentSaveSchema, raw), hash = stableExperimentHash({ operation: "save", id, input });
  safeText([input.title, input.hypothesis, input.change].join("\n"));
  return db.$transaction(async tx => {
    await lock(tx, auth); const a = await authorize(tx, auth, true);
    const old = await replay(tx, a.tid, auth.user.id, input.requestId, hash); if (old) return detail(tx, a.auth, await row(tx, a.tid, old.experimentId), now);
    const timezone = requireTenant(a.auth).tenant.timezone, range = ranges(input.method, timezone, now, true);
    await validateRefs(tx, a.auth, input.method, now);
    let existing = id ? await row(tx, a.tid, id) : null;
    if (existing && (existing.state !== "draft" || existing.version !== input.version)) throw new ApiError(409, "experiment_locked", "Изменять можно только актуальный черновик. После утверждения методика неизменна.");
    if (!existing && input.version !== undefined) throw new ApiError(422, "invalid_experiment", "Версия не нужна для новой проверки.");
    if (!existing && await tx.businessExperiment.count({ where: { tenantId: a.tid, state: { in: ["draft", "running"] } } }) >= 25) throw new ApiError(409, "experiment_limit", "Сначала завершите или остановите одну из 25 открытых проверок.");
    const data = { title: input.title, hypothesis: input.hypothesis, change: input.change, methodVersion: EXPERIMENT_METHOD_VERSION,
      methodJson: json(input.method), timezone, periodStart: range.from, periodEnd: range.to };
    const r = existing ? await tx.businessExperiment.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } })
      : await tx.businessExperiment.create({ data: { ...data, tenantId: a.tid, authorUserId: auth.user.id } });
    await event(tx, a.auth, r, existing ? "edited" : "created", input, hash, now);
    return detail(tx, a.auth, r, now);
  }, options);
}
export async function operateExperiment(db: PrismaClient, auth: AuthContext, id: string, operation: "approve" | "stop" | "result" | "note", raw: unknown, now = new Date()) {
  const input = parse(experimentOperationSchema, raw), hash = stableExperimentHash({ id, operation, input });
  if (input.note) safeText(input.note);
  return db.$transaction(async tx => {
    await lock(tx, auth); const a = await authorize(tx, auth, true), r = await row(tx, a.tid, id);
    if (await replay(tx, a.tid, auth.user.id, input.requestId, hash)) return detail(tx, a.auth, r, now);
    if (r.version !== input.version) throw new ApiError(409, "experiment_changed", "Проверка изменилась. Обновите страницу.");
    if (["completed", "stopped"].includes(r.state)) throw new ApiError(409, "experiment_finished", "Проверка уже завершена. История сохранена; для новых условий создайте другую.");
    const method = parse(experimentMethodSchema, r.methodJson);
    let updated = r;
    if (operation === "stop") {
      if (!input.note) throw new ApiError(422, "experiment_note", "Укажите причину остановки.");
      updated = await tx.businessExperiment.update({ where: { id }, data: { state: "stopped", stopReason: input.note, finishedAt: now, version: { increment: 1 } } });
    } else if (operation === "approve") {
      if (r.state !== "draft") throw new ApiError(409, "experiment_started", "Проверка уже утверждена.");
      if (r.timezone !== requireTenant(a.auth).tenant.timezone || r.methodVersion !== EXPERIMENT_METHOD_VERSION) throw new ApiError(409, "experiment_method_changed", "Изменились условия расчёта. Сохраните черновик заново.");
      ranges(method, r.timezone, now, true); await validateRefs(tx, a.auth, method, now);
      const draft = await review(tx, r, now);
      if (input.reviewHash !== draft.hash) throw new ApiError(409, "stale_review", "Данные проверки изменились. Откройте свежий обзор перед подтверждением.");
      const others = await tx.businessExperiment.findMany({ where: { tenantId: a.tid, id: { not: id }, state: "running", periodStart: { lt: r.periodEnd }, periodEnd: { gt: r.periodStart } }, select: { methodJson: true }, take: 26 });
      if (others.some(o => parse(experimentMethodSchema, o.methodJson).memberIds.some(m => method.memberIds.includes(m)))) throw new ApiError(409, "experiment_overlap", "Для этой группы уже идёт проверка в пересекающемся периоде.");
      updated = await tx.businessExperiment.update({ where: { id }, data: { state: "running", baselineJson: json(draft.baseline), environmentHash: draft.env, approvedAt: now, approvedByUserId: auth.user.id, version: { increment: 1 } } });
    } else if (operation === "note") {
      if (r.state !== "running" || !input.note) throw new ApiError(422, "experiment_note", "Зафиксируйте изменение условий действующей проверки.");
      updated = await tx.businessExperiment.update({ where: { id }, data: { version: { increment: 1 } } });
    } else {
      if (r.state !== "running" || !r.baselineJson) throw new ApiError(409, "experiment_not_started", "Сначала проверьте и подтвердите условия.");
      const changed: string[] = [], range = ranges(method, r.timezone, now);
      if (r.methodVersion !== EXPERIMENT_METHOD_VERSION) changed.push("Изменилась версия расчёта; сравнение по новой методике недопустимо.");
      if (await environment(tx, a.tid, method) !== r.environmentHash) changed.push("Изменились настройки компании, состав группы или задача внедрения относительно подтверждения.");
      if (await tx.businessExperimentEvent.count({ where: { tenantId: a.tid, experimentId: id, type: "note" } })) changed.push("Руководитель зафиксировал дополнительные изменения условий; проверьте историю.");
      try { await validateRefs(tx, a.auth, method, now); } catch (e) {
        if (e instanceof ApiError && [404, 409, 422].includes(e.status)) changed.push("Связанная инициатива, цель, решение или участник изменились либо недоступны."); else throw e;
      }
      const work = await initiative(tx, a.tid, method.initiativeTaskId, a.auth.user.id);
      if (!work || work.status !== "done" || !work.completedAt) changed.push("Выполнение задачи внедрения не подтверждено в CRM.");
      else if (work.completedAt < range.baselineTo || work.completedAt > range.from) changed.push("Внедрение не завершено между исходным периодом и началом проверки.");
      const current = await measureProposalPreparation(tx, a.tid, method.memberIds, range.from, range.to, now);
      const recheckedBaseline = await measureProposalPreparation(tx, a.tid, method.memberIds, range.baselineFrom, range.baselineTo, now);
      if (recheckedBaseline.fingerprint !== (r.baselineJson as ExperimentSample).fingerprint) changed.push("Записи исходного периода изменились после подтверждения. Сохранённый исходный показатель не переписывается.");
      const result = compareExperiment(method, r.baselineJson as ExperimentSample, current, range.to, now, changed);
      await tx.experimentMeasurement.create({ data: { tenantId: a.tid, experimentId: id, revision: r.version + 1, measuredAt: now, fingerprint: hash, resultJson: json(result) } });
      updated = await tx.businessExperiment.update({ where: { id }, data: { ...(now >= range.to ? { state: "completed", finishedAt: now } : {}), version: { increment: 1 } } });
    }
    await event(tx, a.auth, updated, operation, input, hash, now, input.note);
    return detail(tx, a.auth, updated, now);
  }, options);
}
