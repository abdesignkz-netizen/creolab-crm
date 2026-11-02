import type { PrismaClient } from "@creolab/db";
import { z } from "zod";
import { autopilotConfigSchema, autopilotSaveSchema, autopilotOperationSchema, type AutopilotView, type AutopilotPreview } from "@creolab/contracts";
import { requireTenant, isCompanyAdmin } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { actionHash } from "./aiActionRegistry.ts";
import { authorize, cancelPolicyCases, event, lock, parse, record, replay, json, txOptions, activeStates, calendarContext, policyBlockers } from "./autopilotSupport.ts";

export async function getAutopilot(db: PrismaClient, auth: AuthContext, cursor?: unknown, now = new Date()): Promise<AutopilotView> {
  const current = await authorize(db, auth), tid = requireTenant(current).tenantId;
  const after = cursor ? parse(z.string().uuid(), cursor) : null;
  const anchor = after ? await db.autopilotCase.findFirst({ where: { id: after, tenantId: tid } }) : null;
  if (after && !anchor) throw new ApiError(404, "not_found", "Страница истории не найдена.");
  const [policy, members, context, rows] = await Promise.all([
    db.autopilotPolicy.findUnique({ where: { tenantId: tid } }),
    db.membership.findMany({ where: { tenantId: tid, active: true, role: { in: ["owner", "director", "sales_lead", "manager"] }, user: { status: "active" } }, include: { user: { select: { name: true } } }, orderBy: { id: "asc" }, take: 200 }),
    calendarContext(db, tid, now),
    db.autopilotCase.findMany({ where: { tenantId: tid, ...(anchor ? { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21,
      include: { inquiry: { select: { subject: true, contact: { select: { name: true } } } }, events: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 12 } } }),
  ]);
  const config = policy ? parse(autopilotConfigSchema, policy.configJson) : null;
  const blocked = config ? (await policyBlockers(db, current, config, now)).blockers : [];
  if (policy && policy.calendarHash !== context.hash) blocked.push("Рабочий календарь изменился. Сохраните правило заново и включите его после проверки.");
  const canEdit = isCompanyAdmin(current);
  return { policy: policy && config ? { version: policy.version, state: policy.state, enabledAt: policy.enabledAt?.toISOString() || null, config } : null,
    members: members.map(m => ({ id: m.id, name: m.user.name, role: m.role })), calendar: context.calendar, timezone: context.tenant.timezone,
    blocked, canEdit, canEnableAuto: current.activeMembership!.role === "owner",
    nextCursor: rows.length > 20 ? rows[19].id : null,
    items: rows.slice(0, 20).map(r => ({ id: r.id, version: r.version, inquiryId: r.inquiryId, title: r.inquiry.subject || "Новая заявка", customer: r.inquiry.contact.name || "Клиент",
      state: r.state, explanation: r.explanation, dueAt: r.dueAt?.toISOString() || null, taskId: r.taskId,
      assignedName: members.find(m => m.id === r.assignedMembershipId)?.user.name || null, createdAt: r.createdAt.toISOString(),
      canStart: canEdit && r.state === "proposed" && now.getTime() - r.createdAt.getTime() < 7 * 86400000 && policy?.state === "enabled" && r.policyVersion === policy.version && blocked.length === 0,
      canStop: canEdit && activeStates.includes(r.state),
      history: r.events.map(e => ({ id: e.id, type: e.type, at: e.createdAt.toISOString(), text: String(record(e.detailsJson).text || ""),
        runId: e.userId === auth.user.id ? record(e.detailsJson).runId || null : null })) })),
  };
}
export async function previewAutopilot(db: PrismaClient, auth: AuthContext, raw: unknown, now = new Date()): Promise<AutopilotPreview> {
  const current = await authorize(db, auth, true), c = parse(autopilotConfigSchema, raw);
  const ctx = await policyBlockers(db, current, c, now);
  return { calendarHash: ctx.hash, blockers: ctx.blockers, summary: [
    "Только новые заявки с входящим сообщением в диалоге после включения. Историческая очередь не запускается.",
    c.mode === "suggest" ? "Для каждой заявки сначала потребуется ваше подтверждение всего сценария." : "Владелец разрешает выполнение по этому правилу без отдельного подтверждения каждой заявки.",
    `Через ${c.remindMinutes} рабочих минут без ответа: назначить свободную заявку, создать внутреннюю задачу и напомнить в BasQar.`,
    `Ещё через ${c.escalateMinutes} рабочих минут без ответа: один раз передать работу выбранному руководителю. Обратной передачи не будет.`,
    `После передачи проверить ответ в течение ${c.verifyMinutes} рабочих минут. Если ответа нет, завершить автоматизацию с отметкой «Нужно внимание».`,
    `Не более ${c.hourlyLimit} этапов с изменениями в час и 100 одновременно отслеживаемых заявок. Существующая задача или ручное изменение останавливают сценарий.`,
    "Уведомления приходят только внутри BasQar. Сценарий сам не пишет клиентам и не закрывает задачи.",
  ] };
}
export async function saveAutopilot(db: PrismaClient, auth: AuthContext, raw: unknown, now = new Date()) {
  const input = parse(autopilotSaveSchema, raw), tid = requireTenant(auth).tenantId, hash = actionHash({ op: "save", ...input });
  await db.$transaction(async tx => {
    await lock(tx, tid); const fresh = await authorize(tx, auth, true);
    if (await replay(tx, tid, fresh.user.id, input.requestId, hash)) return;
    const old = await tx.autopilotPolicy.findUnique({ where: { tenantId: tid } });
    if ((old?.version || 0) !== input.version) throw new ApiError(409, "autopilot_changed", "Правило уже изменено. Обновите страницу.");
    const ctx = await policyBlockers(tx, fresh, input.config, now);
    if (old) await cancelPolicyCases(tx, old, "Правило изменено. Ранее запущенные сценарии остановлены.", now);
    const ruleData = { assigneeMembershipId: input.config.routing === "fixed" ? input.config.members[0] : null,
      queueJson: json({ strategy: input.config.routing, members: input.config.members, unavailable: input.config.unavailable }), cursor: 0 };
    const rule = old ? await tx.routingRule.update({ where: { tenantId_id: { tenantId: tid, id: old.routingRuleId } }, data: { ...ruleData, version: { increment: 1 } } })
      : await tx.routingRule.create({ data: { tenantId: tid, kind: "autopilot_first_reply", ...ruleData } });
    const data = { state: "paused", configJson: json(input.config), calendarHash: ctx.hash, enabledAt: null, actorUserId: null, actorMembershipId: null, cursorAt: null, cursorId: null, updatedAt: now };
    const policy = old ? await tx.autopilotPolicy.update({ where: { id: old.id }, data: { ...data, version: { increment: 1 } } })
      : await tx.autopilotPolicy.create({ data: { tenantId: tid, routingRuleId: rule.id, ...data, createdAt: now } });
    await event(tx, policy, "saved", { text: "Правило сохранено на паузе. Для работы включите его отдельно." }, now, undefined, fresh.user.id, input.requestId, hash);
    await writeAudit(tx, { tenantId: tid, actorUserId: fresh.user.id, action: "autopilot.saved", entityType: "autopilot", entityId: policy.id, changes: { version: policy.version, mode: input.config.mode } });
  }, txOptions);
  return getAutopilot(db, auth, undefined, now);
}
export async function operateAutopilot(db: PrismaClient, auth: AuthContext, op: "enable" | "pause", raw: unknown, now = new Date()) {
  const input = parse(autopilotOperationSchema, raw), tid = requireTenant(auth).tenantId, hash = actionHash({ op, ...input });
  await db.$transaction(async tx => {
    await lock(tx, tid); const fresh = await authorize(tx, auth, true);
    if (await replay(tx, tid, fresh.user.id, input.requestId, hash)) return;
    const policy = await tx.autopilotPolicy.findUnique({ where: { tenantId: tid } });
    if (!policy || policy.version !== input.version) throw new ApiError(409, "autopilot_changed", "Правило уже изменено. Обновите страницу.");
    if (op === "enable") {
      const c = parse(autopilotConfigSchema, policy.configJson), ctx = await policyBlockers(tx, fresh, c, now);
      if (policy.state !== "paused") throw new ApiError(409, "autopilot_changed", "Правило уже включено.");
      if (c.mode === "auto" && fresh.activeMembership!.role !== "owner") throw new ApiError(403, "forbidden", "Автоматический режим включает только владелец компании.");
      if (ctx.blockers.length || ctx.hash !== policy.calendarHash) throw new ApiError(409, "autopilot_blocked", ctx.blockers[0] || "Рабочий календарь изменился. Сохраните правило заново.");
    }
    await cancelPolicyCases(tx, policy, op === "pause" ? "Правило приостановлено руководителем." : "Начат новый период работы правила.", now);
    const row = await tx.autopilotPolicy.update({ where: { id: policy.id }, data: { version: { increment: 1 }, state: op === "enable" ? "enabled" : "paused",
      enabledAt: op === "enable" ? now : null, cursorAt: null, cursorId: null, actorUserId: fresh.user.id, actorMembershipId: fresh.activeMembership!.id, nextScanAt: now, updatedAt: now } });
    await event(tx, row, op, { text: op === "enable" ? "Правило включено для новых заявок." : "Правило на паузе. Созданные задачи сохранены." }, now, undefined, fresh.user.id, input.requestId, hash);
    await writeAudit(tx, { tenantId: tid, actorUserId: fresh.user.id, action: `autopilot.${op}`, entityType: "autopilot", entityId: row.id, changes: { version: row.version } });
  }, txOptions);
  return getAutopilot(db, auth, undefined, now);
}
