import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ACTION_PLAN_MAX_STEPS, actionPlanSchema, actionConfirmSchema, actionCancelSchema,
  actionStepSchema, type ActionInput, type ActionRunView, type ActionRunSummary } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { requireTenant, requireManageTasks } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import { ApiError } from "../errors.ts";
import { authForUserInTenant } from "./authService.ts";
import { authorizeWebControl } from "./aiControlService.ts";
import { requireFeature } from "./entitlementService.ts";
import { AI_ACTION_REGISTRY, actionHash, actionTask, executeAction, previewAction, recheckActionSnapshot, type ActionSnapshot } from "./aiActionRegistry.ts";
import { validateOpportunityTask } from "./opportunityAction.ts";
import { validateDecisionRefs } from "./businessMemoryService.ts";

type Tx = Prisma.TransactionClient;
type Run = Prisma.ActionRunGetPayload<{ include: { steps: true } }>;
const withSteps = { steps: { orderBy: { position: "asc" as const } } };
const pending = ["draft", "queued", "running"];
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const record = (v: unknown) => (v || {}) as Record<string, any>;
const TTL = 30 * 60_000;
const txOptions = { maxWait: 10_000, timeout: 30_000 };

async function readAuth(db: PrismaClient | Tx, auth: AuthContext) {
  if (auth.configurationTenant) throw new ApiError(403, "forbidden", "Планы выполняются только из кабинета сотрудника компании");
  const current = await authForUserInTenant(db, auth.user.id, requireTenant(auth).tenantId);
  requireManageTasks(current);
  if (!["owner", "director", "sales_lead"].includes(requireTenant(current).role)) throw new ApiError(403, "forbidden", "Планы доступны руководителям компании.");
  return current;
}
async function lockActor(tx: Tx, tenantId: string, userId: string) {
  // A single order for preview/confirm/worker/cancel. Revocation waits only for
  // the current small DB-only step; every following step reloads authorization.
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Membership" WHERE "tenantId" = ${tenantId} AND "userId" = ${userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "ControlAccess" WHERE "tenantId" = ${tenantId} AND "userId" = ${userId} FOR SHARE`;
}
async function authorization(tx: Tx, auth: AuthContext, input?: ActionInput) {
  const ctx = await authorizeWebControl(tx, auth, input ? AI_ACTION_REGISTRY[input.kind].permission : undefined);
  requireManageTasks(ctx.auth);
  await requireFeature(tx, ctx.auth, "TASKS");
  if (record(record(ctx.tenant.settingsJson).runtime).aiPaused) throw new ApiError(409, "action_paused", "Работа ИИ приостановлена. Проверьте настройки управления и подготовьте новый план после возобновления.");
  const { createdAt, updatedAt, lastActivityAt, ...access } = ctx.access;
  return { ...ctx, hash: actionHash({ access, role: ctx.auth.activeMembership!.role, permissions: ctx.auth.activeMembership!.permissions }) };
}
export function serializeActionRun(run: Run): ActionRunView {
  const expired = run.status === "draft" && run.expiresAt <= new Date();
  return { id: run.id, title: run.title, status: expired ? "expired" : run.status as ActionRunView["status"],
    planHash: String(record(run.snapshotJson).planHash), createdAt: run.createdAt.toISOString(), expiresAt: run.expiresAt.toISOString(),
    confirmedAt: run.confirmedAt?.toISOString() || null, finishedAt: run.finishedAt?.toISOString() || null,
    error: expired ? "Срок подтверждения истёк. Подготовьте новый план по актуальным данным." : run.errorText,
    source: record(run.snapshotJson).source === "autopilot" ? "autopilot" : record(run.snapshotJson).source === "architect" ? "architect" : record(run.snapshotJson).source === "opportunity" ? "opportunity" : "control",
    decisions: record(run.snapshotJson).decisions || [],
    canConfirm: run.status === "draft" && !expired && record(run.snapshotJson).source !== "architect", canCancel: pending.includes(run.status),
    completed: run.steps.filter(s => s.status === "succeeded").length,
    steps: run.steps.map(s => ({ key: s.key, kind: s.kind as ActionRunView["steps"][number]["kind"], label: s.label, detail: s.detail,
      status: s.status as ActionRunView["steps"][number]["status"], error: s.errorText, taskId: s.taskId,
      result: typeof record(s.resultJson).summary === "string" ? record(s.resultJson).summary : null, finishedAt: s.finishedAt?.toISOString() || null })) };
}
const serialize = serializeActionRun;
async function ownRun(db: PrismaClient | Tx, auth: AuthContext, id: string) {
  const run = await db.actionRun.findFirst({ where: { id, tenantId: requireTenant(auth).tenantId, userId: auth.user.id }, include: withSteps });
  if (!run) throw new ApiError(404, "not_found", "План не найден");
  return run;
}
export async function getActionRun(db: PrismaClient, auth: AuthContext, id: string) {
  return serialize(await ownRun(db, await readAuth(db, auth), id));
}
export async function listActionRuns(db: PrismaClient, auth: AuthContext, query: { offset?: unknown } = {}) {
  const current = await readAuth(db, auth), tenantId = requireTenant(current).tenantId;
  const rawOffset = Number(query.offset || 0), offset = Number.isSafeInteger(rawOffset) ? Math.max(0, Math.min(10_000, rawOffset)) : 0;
  const where = { tenantId, userId: auth.user.id }, limit = 20;
  const [items, total] = await Promise.all([
    db.actionRun.findMany({ where, select: { id: true, title: true, status: true, createdAt: true, expiresAt: true, snapshotJson: true, steps: { select: { status: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit, skip: offset }), db.actionRun.count({ where }),
  ]);
  return { items: items.map((run): ActionRunSummary => ({ id: run.id, title: run.title, createdAt: run.createdAt.toISOString(),
    source: record(run.snapshotJson).source === "autopilot" ? "autopilot" : record(run.snapshotJson).source === "architect" ? "architect" : record(run.snapshotJson).source === "opportunity" ? "opportunity" : "control",
    status: run.status === "draft" && run.expiresAt <= new Date() ? "expired" : run.status as ActionRunSummary["status"],
    completed: run.steps.filter(s => s.status === "succeeded").length, stepCount: run.steps.length })), total, offset, limit };
}

/** Separate pending/results queries: old pending work must not disappear behind recent history. */
export async function actionHomeFocus(db: PrismaClient, auth: AuthContext, now = new Date()) {
  const current = await readAuth(db, auth), tenantId = requireTenant(current).tenantId;
  const where = { tenantId, userId: current.user.id };
  const select = { id: true, title: true, status: true, createdAt: true, finishedAt: true, steps: { select: { status: true } } } as const;
  const [pending, recent] = await Promise.all([
    db.actionRun.findMany({ where: { ...where, OR: [{ status: "draft", expiresAt: { gt: now } }, { status: { in: ["queued", "running"] } }] },
      select, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 2 }),
    db.actionRun.findMany({ where: { ...where, status: { in: ["succeeded", "failed"] }, finishedAt: { gte: new Date(now.getTime() - 7 * 86400000), lte: now } },
      select, orderBy: [{ finishedAt: "desc" }, { id: "desc" }], take: 2 }),
  ]);
  const item = (r: typeof pending[number]) => ({ id: r.id, title: r.title, status: r.status,
    completed: r.steps.filter(s => s.status === "succeeded").length, steps: r.steps.length,
    at: (r.finishedAt || r.createdAt).toISOString(), href: `/control?view=plans&run=${r.id}` });
  return { items: pending.map(item), recent: recent.map(item) };
}

export async function actionPlanOptions(db: PrismaClient, auth: AuthContext, query: { kind?: unknown; q?: unknown } = {}) {
  const current = await readAuth(db, auth), member = requireTenant(current);
  const q = String(query.q || "").trim().slice(0, 120), tenantId = member.tenantId;
  if (query.kind === "task") {
    const items = await db.task.findMany({ where: { tenantId, status: "open", parentTaskId: null, targetType: { not: "group" },
      executionStatus: { in: ["none", "prepared"] }, confirmedAt: null, sentAt: null,
      ...(q ? { title: { contains: q, mode: "insensitive" } } : {}) }, select: { id: true, title: true }, orderBy: { createdAt: "desc" }, take: 30 });
    return { items: items.map(t => ({ id: t.id, label: t.title })) };
  }
  if (query.kind === "contact") {
    const items = await db.contact.findMany({ where: { tenantId, archivedAt: null,
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { methods: { some: { normalizedValue: { contains: q } } } }] } : {}) },
      select: { id: true, name: true, methods: { where: { type: "phone" }, select: { normalizedValue: true }, take: 1 } }, orderBy: { lastSeenAt: "desc" }, take: 30 });
    return { items: items.map(c => ({ id: c.id, label: [c.name || "Клиент", c.methods[0]?.normalizedValue].filter(Boolean).join(" · ") })) };
  }
  const members = await db.membership.findMany({ where: { tenantId, active: true, user: { status: "active" } }, include: { user: { select: { name: true } } }, orderBy: { createdAt: "asc" } });
  let blockedReason: string | null = null;
  const allowed: string[] = [];
  try {
    await requireFeature(db, current, "TASKS");
    const ctx = await authorizeWebControl(db, current);
    if (record(record(ctx.tenant.settingsJson).runtime).aiPaused) blockedReason = "Работа ИИ приостановлена в управлении. Возобновите её перед подготовкой плана.";
    for (const [kind, capability] of Object.entries(AI_ACTION_REGISTRY)) {
      try { await authorizeWebControl(db, current, capability.permission); allowed.push(kind); }
      catch (e) { if (!(e instanceof ApiError)) throw e; }
    }
    if (!allowed.length) blockedReason ||= "В настройках Control вам не разрешено изменять задачи.";
  } catch (error) { if (!(error instanceof ApiError)) throw error; blockedReason = error.message; }
  return { members: members.map(m => ({ id: m.id, name: m.user.name })), selfId: member.id, timezone: member.tenant.timezone, allowed, blockedReason };
}

export async function previewActionPlan(db: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = actionPlanSchema.parse(raw), tenantId = requireTenant(auth).tenantId;
  if (auth.configurationTenant) throw new ApiError(403, "forbidden", "Войдите под сотрудником компании");
  return db.$transaction(async tx => {
    await lockActor(tx, tenantId, auth.user.id);
    const ctx = await authorization(tx, auth), requestHash = actionHash(input);
    const existing = await tx.actionRun.findUnique({ where: { tenantId_userId_requestId: { tenantId, userId: auth.user.id, requestId: input.requestId } }, include: withSteps });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ApiError(409, "idempotency_conflict", "Этот запрос уже использован для другого плана");
      return serialize(existing);
    }
    if (await tx.actionRun.count({ where: { tenantId, userId: auth.user.id, status: { in: pending }, expiresAt: { gt: new Date() } } }) >= 20) {
      throw new ApiError(409, "action_limit", "Завершите или отмените один из текущих планов");
    }
    await validateDecisionRefs(tx, ctx.auth, input.decisions || []);
    const steps = [];
    for (const [position, step] of input.steps.entries()) {
      await authorization(tx, auth, step);
      const preview = await previewAction(tx, ctx.auth, step, input.steps.slice(0, position));
      steps.push({ position, key: step.key, kind: step.kind, label: preview.label, detail: preview.detail,
        inputJson: json(step), snapshotJson: json(preview.snapshot) });
    }
    const id = randomUUID(), expiresAt = new Date(Date.now() + TTL);
    const planHash = actionHash({ input, steps, authorization: ctx.hash });
    const confirmation = await tx.controlConfirmation.create({ data: { tenantId, userId: auth.user.id, source: "AI_ACTION_PLAN", action: "ACTION_PLAN",
      paramsJson: { runId: id, planHash }, summary: input.title, requestId: `action-plan:${id}`, expiresAt } });
    const run = await tx.actionRun.create({ data: { id, tenantId, userId: auth.user.id, initiatorMembershipId: ctx.auth.activeMembership!.id,
      requestId: input.requestId, requestHash, title: input.title, expiresAt, confirmationId: confirmation.id,
      snapshotJson: { version: 1, planHash, authorizationHash: ctx.hash, maxSteps: ACTION_PLAN_MAX_STEPS,
        decisions: input.decisions || [],
        ...(input.steps[0].kind === "opportunity.task" ? { source: "opportunity", insightId: input.steps[0].insightId } : {}) }, steps: { create: steps } }, include: withSteps });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, entityType: "action_run", entityId: id, action: "action.previewed", changes: { title: input.title, count: steps.length } });
    return serialize(run);
  }, txOptions);
}

async function recordRequest(tx: Tx, run: Run, operation: string, requestId: string, hash: string) {
  const key = { scope: `ai-actions.${operation}`, actorKey: `${run.tenantId}:${run.userId}`, key: requestId };
  const old = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: key } });
  if (old && old.requestHash !== hash) throw new ApiError(409, "idempotency_conflict", "Этот запрос уже использован для другого действия");
  if (!old) await tx.idempotencyRecord.create({ data: { ...key, requestHash: hash, resultJson: { runId: run.id }, expiresAt: new Date("9999-01-01") } });
}
async function lockOwnRun(tx: Tx, auth: AuthContext, id: string) {
  await lockActor(tx, requireTenant(auth).tenantId, auth.user.id);
  await readAuth(tx, auth);
  await tx.$queryRaw`SELECT id FROM "ActionRun" WHERE id = ${id} AND "tenantId" = ${requireTenant(auth).tenantId} AND "userId" = ${auth.user.id} FOR UPDATE`;
  return ownRun(tx, auth, id);
}
export async function stopActionRun(tx: Tx, run: Run, status: "failed" | "cancelled" | "expired", code: string, text: string, stepId?: string) {
  if (stepId) await tx.actionStep.updateMany({ where: { id: stepId, runId: run.id, tenantId: run.tenantId, status: "pending" }, data: { status: "failed", errorCode: code, errorText: text, finishedAt: new Date() } });
  await tx.actionStep.updateMany({ where: { runId: run.id, tenantId: run.tenantId, status: "pending" }, data: { status: "skipped", finishedAt: new Date() } });
  await tx.actionRun.update({ where: { id: run.id }, data: { status, errorCode: code, errorText: text, finishedAt: new Date() } });
  if (run.confirmationId) await tx.controlConfirmation.update({ where: { id: run.confirmationId }, data: { status, executedAt: new Date(), resultJson: { runId: run.id, status } } });
  await writeAudit(tx, { tenantId: run.tenantId, actorUserId: run.userId, entityType: "action_run", entityId: run.id, action: `action.${status}`, changes: { title: run.title, reason: text } });
}
const stopRun = stopActionRun;
async function validateStep(tx: Tx, auth: AuthContext, run: Run, step: Run["steps"][number], executing = false) {
  const input = actionStepSchema.parse(step.inputJson), ctx = await authorization(tx, auth, input);
  if (ctx.auth.activeMembership!.id !== run.initiatorMembershipId || ctx.hash !== record(run.snapshotJson).authorizationHash) {
    throw new ApiError(409, "action_access_changed", "Права инициатора изменились. Подготовьте новый план с текущими правами.");
  }
  const snapshot = step.snapshotJson as ActionSnapshot;
  await validateDecisionRefs(tx, ctx.auth, record(run.snapshotJson).decisions || []);
  if (input.kind === "opportunity.task") await validateOpportunityTask(tx, ctx.auth, input);
  await recheckActionSnapshot(tx, ctx.auth, snapshot);
  let taskId: string | null = null, expectedHash = snapshot.taskHash;
  if ("target" in input) {
    if ("taskId" in input.target) taskId = input.target.taskId;
    else {
      const source = run.steps.find(s => s.key === (input.target as { fromStep: string }).fromStep);
      if (executing && source?.status !== "succeeded") throw new ApiError(409, "action_dependency", "Предыдущий шаг не завершён");
      taskId = source?.taskId || null;
    }
    if (taskId) {
      const ownChange = run.steps.filter(s => s.position < step.position && s.status === "succeeded" && s.taskId === taskId).at(-1);
      if (ownChange) expectedHash = record(ownChange.resultJson).taskHash;
      await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} AND "tenantId" = ${run.tenantId} FOR UPDATE`;
      const task = await actionTask(tx, ctx.auth, taskId);
      if (!expectedHash || actionHash(task) !== expectedHash) throw new ApiError(409, "action_task_changed", "Задача изменилась после подготовки плана. Выполненные шаги сохранены. Проверьте задачу и подготовьте новый план для оставшихся действий.");
    }
  }
  return { input, auth: ctx.auth, taskId };
}
export async function confirmActionRun(db: PrismaClient, auth: AuthContext, id: string, raw: unknown) {
  const input = actionConfirmSchema.parse(raw);
  return db.$transaction(async tx => {
    const run = await lockOwnRun(tx, auth, id);
    if (record(run.snapshotJson).source === "autopilot") throw new ApiError(409, "autopilot_confirm_separately", "Сценарии подтверждаются в настройках контроля первого ответа.");
    if (record(run.snapshotJson).source === "architect") throw new ApiError(409, "architect_confirm_separately", "Применение настроек подтверждается в проекте компании.");
    if (input.planHash !== record(run.snapshotJson).planHash) throw new ApiError(409, "action_plan_changed", "Откройте актуальный план перед подтверждением");
    await recordRequest(tx, run, "confirm", input.requestId, actionHash({ id, planHash: input.planHash }));
    if (run.status !== "draft") return serialize(run);
    if (run.expiresAt <= new Date()) await stopRun(tx, run, "expired", "action_expired", "Срок подтверждения истёк. Подготовьте новый план.");
    else {
      try { for (const step of run.steps) await validateStep(tx, auth, run, step); }
      catch (error) {
        if (!(error instanceof ApiError)) throw error;
        await stopRun(tx, run, "failed", error.code, error.message);
        return serialize(await ownRun(tx, auth, id));
      }
      const event = await tx.outboxEvent.create({ data: { tenantId: run.tenantId, type: "ai.action_run", entityType: "action_run", entityId: run.id, payloadJson: { version: 1 } } });
      await tx.actionRun.update({ where: { id }, data: { status: "queued", confirmedAt: new Date(), outboxId: event.id } });
      await tx.controlConfirmation.update({ where: { id: run.confirmationId! }, data: { status: "confirmed", confirmedAt: new Date() } });
      await writeAudit(tx, { tenantId: run.tenantId, actorUserId: run.userId, entityType: "action_run", entityId: id, action: "action.confirmed", changes: { title: run.title, count: run.steps.length } });
    }
    return serialize(await ownRun(tx, auth, id));
  }, txOptions);
}
export async function cancelActionRun(db: PrismaClient, auth: AuthContext, id: string, raw: unknown) {
  const input = actionCancelSchema.parse(raw);
  return db.$transaction(async tx => {
    const run = await lockOwnRun(tx, auth, id);
    await recordRequest(tx, run, "cancel", input.requestId, actionHash({ id }));
    if (pending.includes(run.status)) await stopRun(tx, run, "cancelled", "action_cancelled", record(run.snapshotJson).source === "architect"
      ? "Применение проекта отменено. Рабочие настройки не изменены." : "Оставшиеся шаги отменены. Уже выполненные действия сохранены.");
    return serialize(await ownRun(tx, auth, id));
  }, txOptions);
}

/** One transaction = one effect + postcondition + result. A crash cannot split them. */
export async function processActionStep(db: PrismaClient, tenantId: string, id: string): Promise<boolean> {
  const head = await db.actionRun.findFirst({ where: { id, tenantId } });
  if (!head || !["queued", "running"].includes(head.status)) return false;
  if (record(head.snapshotJson).source === "architect") {
    await (await import("./aiArchitectApplyService.ts")).processArchitectApplication(db, tenantId, id);
    return false;
  }
  return db.$transaction(async tx => {
    await lockActor(tx, tenantId, head.userId);
    await tx.$queryRaw`SELECT id FROM "ActionRun" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const run = await tx.actionRun.findFirstOrThrow({ where: { id, tenantId }, include: withSteps });
    if (!["queued", "running"].includes(run.status)) return false;
    const step = run.steps.find(s => s.status === "pending");
    if (!step || run.steps.length > ACTION_PLAN_MAX_STEPS || record(run.snapshotJson).version !== 1) {
      await stopRun(tx, run, "failed", "action_invalid", "План не может быть выполнен. Подготовьте новый план.", step?.id); return false;
    }
    if (Date.now() - run.confirmedAt!.getTime() > TTL) {
      await stopRun(tx, run, "expired", "action_expired", "Время выполнения плана истекло. Проверьте выполненные шаги и подготовьте оставшиеся заново.", step.id); return false;
    }
    // Roll back domain writes if a later validation/postcondition rejects this step.
    await tx.$executeRawUnsafe("SAVEPOINT action_step");
    try {
      const auth = await authForUserInTenant(tx, run.userId, tenantId);
      const valid = await validateStep(tx, auth, run, step, true);
      const result = await executeAction(tx, valid.auth, valid.input, valid.taskId, run.id);
      await tx.actionStep.update({ where: { id: step.id }, data: { status: "succeeded", taskId: result.taskId, resultJson: json(result), finishedAt: new Date() } });
      await writeAudit(tx, { tenantId, actorUserId: run.userId, entityType: "task", entityId: result.taskId, action: "action.step_completed",
        correlationId: run.id, changes: { title: step.label, result: result.summary, source: "control" } });
      const done = run.steps.every(s => s.id === step.id || s.status === "succeeded");
      await tx.actionRun.update({ where: { id }, data: { status: done ? "succeeded" : "running", ...(done ? { finishedAt: new Date() } : {}) } });
      if (done) {
        await tx.controlConfirmation.update({ where: { id: run.confirmationId! }, data: { status: "executed", executedAt: new Date(), resultJson: { runId: id, status: "succeeded" } } });
        await writeAudit(tx, { tenantId, actorUserId: run.userId, entityType: "action_run", entityId: id, action: "action.succeeded", changes: { title: run.title, count: run.steps.length } });
      }
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT action_step");
      return !done;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error; // transient DB error: outer transaction rolls back; outbox retries
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT action_step");
      await stopRun(tx, run, "failed", error.code, error.message, step.id);
      return false;
    }
  }, txOptions);
}
export async function processActionRun(db: PrismaClient, tenantId: string, id: string) {
  for (let i = 0; i < ACTION_PLAN_MAX_STEPS; i++) if (!await processActionStep(db, tenantId, id)) return;
}
export async function failActionRunQueue(db: PrismaClient, tenantId: string, id: string) {
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "ActionRun" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const run = await tx.actionRun.findFirst({ where: { id, tenantId }, include: withSteps });
    if (run && ["queued", "running"].includes(run.status)) await stopRun(tx, run, "failed", "action_queue_failed",
      record(run.snapshotJson).source === "architect" ? "Применение проекта не удалось завершить. Рабочие настройки не изменены. Обновите проверку проекта."
        : "Обработку не удалось завершить. Выполненные шаги сохранены. Проверьте их и подготовьте новый план только для оставшихся действий.", run.steps.find(s => s.status === "pending")?.id);
  }, txOptions);
}
