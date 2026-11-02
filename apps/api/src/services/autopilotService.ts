import { Prisma, type PrismaClient } from "@creolab/db";
import { autopilotConfigSchema, autopilotOperationSchema, taskCreatorSnapshot, type AutopilotConfig } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireTenant } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import { logServerError } from "../lib/redact.ts";
import { authForUserInTenant } from "./authService.ts";
import { actionHash } from "./aiActionRegistry.ts";
import { createStaffNotification } from "./notificationService.ts";
import { writeActivity } from "./contactService.ts";
import { lockSituationEpisodes, observeSituationEvidence } from "./situationEpisodeService.ts";
import { eligibleAutopilotMember, routeAutopilot } from "./routingRuleService.ts";
import { autopilotFacts } from "./autopilotFacts.ts";
import { activeStates, authorize, cancelPolicyCases, event, json, lock, parse, policyBlockers, record, replay, txOptions, type Tx, type Policy, type Case } from "./autopilotSupport.ts";

const MINUTE = 60_000, HOUR = 3_600_000;
const terminal = (row: Case) => !activeStates.includes(row.state);
async function policyRuntime(tx: Tx, p: Policy, now: Date) {
  if (p.state !== "enabled" || !p.actorUserId) return null;
  try {
    await tx.$queryRaw`SELECT id FROM "Membership" WHERE "tenantId" = ${p.tenantId} AND id = ${p.actorMembershipId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${p.actorUserId} FOR SHARE`;
    const auth = await authorize(tx, await authForUserInTenant(tx, p.actorUserId, p.tenantId), true);
    const config = parse(autopilotConfigSchema, p.configJson), ctx = await policyBlockers(tx, auth, config, now, false);
    if (config.mode === "auto" && auth.activeMembership!.role !== "owner" || ctx.hash !== p.calendarHash || ctx.blockers.length) throw new ApiError(409, "autopilot_policy_changed", "Правило больше не действует.");
    return { auth, config, ...ctx };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    await cancelPolicyCases(tx, p, "Правило остановлено: изменились права, доступность сотрудников, календарь или разрешение на автоматизацию.", now);
    await tx.autopilotPolicy.update({ where: { id: p.id }, data: { state: "paused", version: { increment: 1 }, enabledAt: null, updatedAt: now } });
    await event(tx, p, "paused_by_check", { text: "Проверьте настройки и включите правило заново." }, now);
    return null;
  }
}
async function schedule(tx: Tx, row: Case, at: Date) {
  if (await tx.scheduledAction.findFirst({ where: { tenantId: row.tenantId, type: "autopilot_check", parentId: row.id, state: { in: ["scheduled", "running"] } } })) return;
  await tx.scheduledAction.create({ data: { tenantId: row.tenantId, type: "autopilot_check", parentType: "autopilot_case", parentId: row.id, dueAt: at, payloadJson: { policyVersion: row.policyVersion } } });
}
async function finish(tx: Tx, p: Policy, row: Case, state: "resolved" | "stopped" | "attention", text: string, now: Date, details = {}) {
  const updated = await tx.autopilotCase.update({ where: { id: row.id }, data: { state, explanation: text, dueAt: null, version: { increment: 1 }, updatedAt: now } });
  await tx.scheduledAction.updateMany({ where: { tenantId: row.tenantId, type: "autopilot_check", parentId: row.id, state: { in: ["scheduled", "running"] } }, data: { state: state === "resolved" ? "done" : "canceled", cancelReason: state === "resolved" ? null : text, version: { increment: 1 } } });
  await event(tx, p, state, { text, ...details }, now, row.id);
  if (state === "resolved") {
    await lockSituationEpisodes(tx, row.tenantId);
    const episode = await tx.situationEpisode.findFirst({ where: { tenantId: row.tenantId, id: row.episodeId } });
    if (episode) await observeSituationEvidence(tx, row.tenantId, { itemId: episode.itemId, active: false, evidenceKey: actionHash({ reply: details }), title: episode.title, ownerMembershipId: row.assignedMembershipId, links: { inquiryId: row.inquiryId, taskId: row.taskId } }, episode);
  }
  return updated;
}

/** An indexed discovery cursor visits only new inquiries. A single tenant lock
 * serializes policy changes, claims, rotation and hourly accounting. */
export async function sweepAutopilotTenant(db: PrismaClient, tenantId: string, now = new Date()) {
  return db.$transaction(async tx => {
    await lock(tx, tenantId);
    const p = await tx.autopilotPolicy.findUnique({ where: { tenantId } });
    if (!p || p.state !== "enabled" || !p.enabledAt || p.nextScanAt > now) return 0;
    const runtime = await policyRuntime(tx, p, now); if (!runtime) return 0;
    const { config: c, clock } = runtime;
    const count = await tx.autopilotCase.count({ where: { tenantId, state: { in: activeStates } } });
    if (count >= 100) { await tx.autopilotPolicy.update({ where: { id: p.id }, data: { nextScanAt: new Date(now.getTime() + MINUTE) } }); return 0; }
    const rows = await tx.inquiry.findMany({ where: { tenantId, receivedAt: { gte: p.enabledAt, lte: now },
      ...(p.cursorAt && p.cursorId !== null ? { OR: [{ receivedAt: { gt: p.cursorAt } }, { receivedAt: p.cursorAt, id: { gt: p.cursorId } }] } : {}) },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }], take: Math.min(20, 100 - count) });
    let added = 0;
    for (const inquiry of rows) {
      if (await tx.autopilotCase.findUnique({ where: { tenantId_inquiryId: { tenantId, inquiryId: inquiry.id } } })) continue;
      const facts = await autopilotFacts(tx, tenantId, inquiry.id, now, { since: p.enabledAt, lock: true });
      if (!facts?.open || facts.replyId) continue;
      await lockSituationEpisodes(tx, tenantId);
      const episode = await observeSituationEvidence(tx, tenantId, { itemId: `autopilot_reply:${inquiry.id}`, active: true,
        evidenceKey: actionHash({ inboundId: facts.inbound.id }), title: "Новая заявка без ответа", ownerMembershipId: inquiry.assigneeMembershipId,
        links: { inquiryId: inquiry.id, contactId: inquiry.contactId, conversationId: inquiry.conversationId } });
      if (!episode) continue;
      const dueAt = clock.afterHours(new Date(Math.max(inquiry.receivedAt.getTime(), facts.inbound.createdAt.getTime())), c.remindMinutes / 60);
      const row = await tx.autopilotCase.create({ data: { tenantId, policyId: p.id, policyVersion: p.version, inquiryId: inquiry.id, episodeId: episode.id,
        inboundId: facts.inbound.id, inboundAt: facts.inbound.createdAt, state: c.mode === "suggest" ? "proposed" : "ready", dueAt,
        expectedJson: { manualHash: facts.manualHash }, authorizedAt: c.mode === "auto" ? now : null, authorizedByUserId: c.mode === "auto" ? p.actorUserId : null,
        explanation: c.mode === "suggest" ? "Предложение: напомнить сотруднику и при отсутствии ответа передать руководителю." : "Ожидаем срок первого ответа по рабочему календарю.", createdAt: now, updatedAt: now } });
      await event(tx, p, "detected", { text: row.explanation }, now, row.id);
      await schedule(tx, row, clock.nextWorkingTime(now)); added++;
    }
    const last = rows.at(-1);
    await tx.autopilotPolicy.update({ where: { id: p.id }, data: { nextScanAt: new Date(now.getTime() + MINUTE), ...(last ? { cursorAt: last.receivedAt, cursorId: last.id } : { cursorAt: new Date(Math.max(p.enabledAt.getTime(), now.getTime() - 10 * MINUTE)), cursorId: "" }) } });
    return added;
  }, txOptions);
}
export async function sweepAutopilot(db: PrismaClient, now = new Date()) {
  const policies = await db.autopilotPolicy.findMany({ where: { state: "enabled", nextScanAt: { lte: now } }, orderBy: [{ nextScanAt: "asc" }, { id: "asc" }], take: 3 });
  for (const p of policies) try { await sweepAutopilotTenant(db, p.tenantId, now); }
  catch (e) { logServerError(e, "autopilot:discovery"); await db.autopilotPolicy.updateMany({ where: { id: p.id, version: p.version }, data: { nextScanAt: new Date(now.getTime() + MINUTE) } }); }
}
export async function operateAutopilotCase(db: PrismaClient, auth: AuthContext, id: string, op: "start" | "stop", raw: unknown, now = new Date()) {
  const input = parse(autopilotOperationSchema, raw), tid = requireTenant(auth).tenantId, hash = actionHash({ id, op, ...input });
  return db.$transaction(async tx => {
    await lock(tx, tid); const fresh = await authorize(tx, auth, true);
    if (await replay(tx, tid, fresh.user.id, input.requestId, hash)) return { ok: true };
    const row = await tx.autopilotCase.findFirst({ where: { id, tenantId: tid } });
    if (!row) throw new ApiError(404, "not_found", "Сценарий не найден.");
    if (row.version !== input.version || terminal(row)) throw new ApiError(409, "autopilot_changed", "Сценарий изменился. Обновите страницу.");
    const p = await tx.autopilotPolicy.findUniqueOrThrow({ where: { tenantId: tid } });
    if (op === "stop") await finish(tx, p, row, "stopped", "Сценарий остановлен руководителем. Созданная задача сохранена.", now);
    else {
      if (row.state !== "proposed" || p.version !== row.policyVersion || p.state !== "enabled" || now.getTime() - row.createdAt.getTime() >= 7 * 86400000)
        throw new ApiError(409, "autopilot_changed", "Предложение больше не действует.");
      const c = parse(autopilotConfigSchema, p.configJson), ctx = await policyBlockers(tx, fresh, c, now);
      if (ctx.blockers.length || ctx.hash !== p.calendarHash) throw new ApiError(409, "autopilot_blocked", ctx.blockers[0] || "Рабочий календарь изменился.");
      const facts = await autopilotFacts(tx, tid, row.inquiryId, now, { inboundId: row.inboundId, lock: true });
      if (!facts?.open || facts.replyId || facts.manualHash !== record(row.expectedJson).manualHash)
        throw new ApiError(409, "autopilot_changed", "Заявка уже изменена или клиенту ответили. Обновите страницу.");
      const ready = await tx.autopilotCase.update({ where: { id }, data: { state: "ready", authorizedAt: now, authorizedByUserId: fresh.user.id, version: { increment: 1 }, updatedAt: now,
        explanation: "Сценарий подтверждён. Ожидаем срок по рабочему календарю." } });
      await tx.scheduledAction.updateMany({ where: { tenantId: tid, type: "autopilot_check", parentId: id, state: "scheduled" }, data: { dueAt: ctx.clock.nextWorkingTime(now) } });
      await schedule(tx, ready, ctx.clock.nextWorkingTime(now));
    }
    await event(tx, p, op, { text: op === "start" ? "Руководитель подтвердил напоминание, одну передачу и проверку ответа." : "Остановка подтверждена." }, now, id, fresh.user.id, input.requestId, hash);
    await writeAudit(tx, { tenantId: tid, actorUserId: fresh.user.id, action: `autopilot.case_${op}`, entityType: "autopilot", entityId: id });
    return { ok: true };
  }, txOptions);
}

/** Ledger records only effects actually committed by this closed internal
 * handler. These runs cannot be supplied to the general plan/execution API. */
async function ledger(tx: Tx, p: Policy, row: Case, auth: AuthContext, phase: string, summary: string, taskId: string, now: Date) {
  const run = await tx.actionRun.create({ data: { tenantId: p.tenantId, userId: auth.user.id, initiatorMembershipId: requireTenant(auth).id,
    requestId: `autopilot:${row.id}:${phase}`, requestHash: actionHash({ policyVersion: p.version, caseId: row.id, phase }), title: `Контроль ответа: ${phase === "reminded" ? "напоминание" : "передача руководителю"}`,
    status: "succeeded", snapshotJson: { source: "autopilot", policyId: p.id, policyVersion: p.version, caseId: row.id, authorizedAt: row.authorizedAt?.toISOString(), authorizedByUserId: row.authorizedByUserId },
    expiresAt: now, confirmedAt: row.authorizedAt, finishedAt: now, createdAt: now,
    steps: { create: [{ position: 0, key: phase, kind: "autopilot.internal", label: summary, detail: "Внутреннее действие по утверждённому правилу; ожидаем фактический ответ клиенту.",
      inputJson: { caseId: row.id }, snapshotJson: {}, status: "succeeded", taskId, resultJson: { summary }, finishedAt: now }] } } });
  await writeAudit(tx, { tenantId: p.tenantId, actorUserId: auth.user.id, action: "autopilot.step_completed", entityType: "action_run", entityId: run.id, correlationId: row.id, changes: { phase, taskId, policyVersion: p.version } });
  return run.id;
}

export async function processAutopilotCheck(db: PrismaClient, item: { id: string; tenantId: string; parentId: string; version: number }, now = new Date()) {
  return db.$transaction(async tx => {
    await lock(tx, item.tenantId);
    const job = await tx.scheduledAction.findFirst({ where: { id: item.id, tenantId: item.tenantId, type: "autopilot_check", state: "running", version: item.version + 1 } });
    if (!job) return;
    const row = await tx.autopilotCase.findFirst({ where: { id: item.parentId, tenantId: item.tenantId } });
    const p = await tx.autopilotPolicy.findUnique({ where: { tenantId: item.tenantId } });
    if (!row || !p || terminal(row) || p.version !== row.policyVersion || p.state !== "enabled") {
      await tx.scheduledAction.update({ where: { id: job.id }, data: { state: "canceled", cancelReason: "Сценарий больше не действует." } }); return;
    }
    const rt = await policyRuntime(tx, p, now); if (!rt) return;
    const { config: c, clock } = rt;
    const requeue = async (at: Date) => tx.scheduledAction.update({ where: { id: job.id }, data: { state: "scheduled", version: { increment: 1 }, dueAt: clock.nextWorkingTime(at), payloadJson: { policyVersion: p.version } } });
    const facts = await autopilotFacts(tx, p.tenantId, row.inquiryId, now, { inboundId: row.inboundId, lock: true });
    if (!facts) { await finish(tx, p, row, "stopped", "Исходная заявка или сообщение недоступны. Проверьте вручную.", now); return; }
    if (facts.replyId) { await finish(tx, p, row, "resolved", "Ответ клиенту подтверждён отправленным сообщением. Созданную задачу сотрудник завершает отдельно.", now, { messageId: facts.replyId }); return; }
    if (!facts.open || facts.manualHash !== record(row.expectedJson).manualHash) { await finish(tx, p, row, "stopped", "Заявка или управление диалогом изменены. Автоматизация уступила управление сотруднику.", now); return; }
    const relatedItems = ["inquiry_new", "inquiry_accepted", "inquiry_ai_blocked", "missing_next_action"].map(kind => `${kind}:${row.inquiryId}`)
      .concat(["conversation_human", "conversation_paused", "conversation_attention"].map(kind => `${kind}:${facts.conversation.id}`));
    if (await tx.situationEpisodeEvent.findFirst({ where: { tenantId: p.tenantId, actorUserId: { not: null }, OR: [
      { episodeId: row.episodeId }, { createdAt: { gte: row.createdAt }, episode: { tenantId: p.tenantId, itemId: { in: relatedItems } } },
    ] }, select: { id: true } })) {
      await finish(tx, p, row, "stopped", "Ситуация изменена сотрудником. Автоматические назначения остановлены.", now); return;
    }
    if (row.taskId) {
      await tx.$queryRaw`SELECT id FROM "Task" WHERE "tenantId" = ${p.tenantId} AND id = ${row.taskId} FOR UPDATE`;
      const task = await tx.task.findFirst({ where: { id: row.taskId, tenantId: p.tenantId } });
      if (!task || actionHash(task) !== record(row.expectedJson).taskHash) { await finish(tx, p, row, "stopped", "Задача изменена сотрудником. Автоматические назначения остановлены.", now); return; }
    }
    if (!clock.isWorkingTime(now)) { await requeue(now); return; }
    if (row.state === "proposed") {
      if (now.getTime() - row.createdAt.getTime() >= 7 * 86400000) { await finish(tx, p, row, "stopped", "Предложение не подтверждено за 7 дней. Проверьте заявку вручную.", now); return; }
      await requeue(new Date(now.getTime() + 5 * MINUTE)); return;
    }
    // Every approved scenario also rechecks its individual approver, independently
    // from the owner who enabled the company policy.
    let actor: AuthContext;
    try { actor = await authorize(tx, await authForUserInTenant(tx, row.authorizedByUserId!, p.tenantId), true); }
    catch (e) { if (!(e instanceof ApiError)) throw e; await finish(tx, p, row, "stopped", "У подтвердившего сценарий сотрудника больше нет необходимых прав.", now); return; }
    if (row.dueAt && row.dueAt > now) { await requeue(new Date(Math.min(row.dueAt.getTime(), now.getTime() + MINUTE))); return; }
    if (row.state === "escalated") { await finish(tx, p, row, "attention", "К концу срока проверки подтверждённого ответа не было. Проверьте заявку вручную; новых переназначений не будет.", now); return; }
    const operations = await tx.autopilotEvent.count({ where: { tenantId: p.tenantId, type: "effect", createdAt: { gt: new Date(now.getTime() - HOUR), lte: now } } });
    if (operations >= c.hourlyLimit) { await tx.autopilotCase.update({ where: { id: row.id }, data: { explanation: "Достигнут лимит этапов в час. Проверим снова через 5 рабочих минут.", updatedAt: now } }); await requeue(clock.afterHours(now, 5 / 60)); return; }
    const otherTask = await tx.task.findFirst({ where: { tenantId: p.tenantId, status: { in: ["open", "in_progress", "waiting"] }, ...(row.taskId ? { id: { not: row.taskId } } : {}),
      OR: [{ inquiryId: row.inquiryId }, { conversationId: facts.conversation.id },
        { contactId: facts.inquiry.contactId, inquiryId: null, conversationId: null, dealId: null }] } });
    if (otherTask || facts.conversation.assigneeMembershipId && facts.conversation.assigneeMembershipId !== facts.inquiry.assigneeMembershipId) {
      await finish(tx, p, row, "stopped", "У заявки уже есть задача или отдельный ответственный диалога. Проверьте текущую работу; дубль не создан.", now); return;
    }
    const member = row.state === "ready" ? await routeAutopilot(tx, p.tenantId, p.routingRuleId, c, facts.inquiry, now)
      : await eligibleAutopilotMember(tx, p.tenantId, c.escalationMemberId, row.inquiryId, facts.conversation.id, c, now);
    if (!member || row.state === "reminded" && !["owner", "director", "sales_lead"].includes(member.role)) { await finish(tx, p, row, "attention", "Нет доступного сотрудника с необходимой ролью, доступом к заявке и уведомлениями в BasQar. Требуется ручное назначение.", now); return; }
    if (row.state === "reminded" && member.id === row.assignedMembershipId) {
      await finish(tx, p, row, "attention", "Заявку уже ведёт выбранный руководитель, но ответа нет. Повторного назначения не будет.", now); return;
    }
    let taskId = row.taskId;
    const title = `Ответить клиенту: ${facts.inquiry.contact.name || facts.inquiry.subject || "Новая заявка"}`.slice(0, 240);
    const nextDue = clock.afterHours(now, (row.state === "ready" ? c.escalateMinutes : c.verifyMinutes) / 60);
    if (row.state === "ready") {
      const task = await tx.task.create({ data: { tenantId: p.tenantId, type: "note", title, description: "Клиент ждёт первый ответ. Откройте диалог и ответьте; отправка выполняется сотрудником.",
        contactId: facts.inquiry.contactId, inquiryId: row.inquiryId, conversationId: facts.conversation.id, ownerMembershipId: member.id,
        source: "autopilot", status: "open", targetType: "client", dedupeKey: `autopilot:${row.id}`, dueAt: nextDue,
        contextSnapshotJson: { ...taskCreatorSnapshot({ createdByKind: "system", createdByMembershipId: actor.activeMembership!.id, executorType: "USER" }), autopilotCaseId: row.id, policyVersion: p.version } } });
      taskId = task.id;
      await writeAudit(tx, { tenantId: p.tenantId, actorUserId: actor.user.id, action: "task.created", entityType: "task", entityId: taskId, changes: { title, source: "autopilot", caseId: row.id } });
    } else {
      await tx.task.update({ where: { tenantId_id: { tenantId: p.tenantId, id: taskId! } }, data: { ownerMembershipId: member.id, dueAt: nextDue } });
      await writeAudit(tx, { tenantId: p.tenantId, actorUserId: actor.user.id, action: "task.assigned", entityType: "task", entityId: taskId, changes: { membershipId: member.id, source: "autopilot", caseId: row.id } });
    }
    if (facts.inquiry.assigneeMembershipId !== member.id) await tx.inquiry.update({ where: { tenantId_id: { tenantId: p.tenantId, id: row.inquiryId } }, data: { assigneeMembershipId: member.id, version: { increment: 1 } } });
    if (facts.conversation.assigneeMembershipId !== member.id) await tx.conversation.update({ where: { tenantId_id: { tenantId: p.tenantId, id: facts.conversation.id } }, data: { assigneeMembershipId: member.id, controlVersion: { increment: 1 } } });
    const summary = row.state === "ready" ? "Создана задача и напоминание сотруднику" : "Задача и заявка переданы руководителю один раз";
    const notice = await createStaffNotification(tx, { tenantId: p.tenantId, membershipId: member.id, type: "action.task_notice", entityType: "task", entityId: taskId!, title,
      body: `${summary}. Клиенту ещё не ответили.`, episodeKey: `autopilot:${row.id}:${row.state}`, internalOnly: true, channels: ["in_app"] });
    if (!notice || !await tx.notificationDelivery.findFirst({ where: { notificationId: notice.id, channel: "in_app", state: "delivered" } })) throw new Error("Autopilot notification was not persisted");
    const phase = row.state === "ready" ? "reminded" : "escalated";
    const runId = await ledger(tx, p, row, actor, phase, summary, taskId!, now);
    await writeActivity(tx, { tenantId: p.tenantId, contactId: facts.inquiry.contactId, inquiryId: row.inquiryId, type: phase === "reminded" ? "task.created" : "task.assigned",
      title: summary, description: title, actorType: "system", actorId: actor.user.id, metadata: { taskId, autopilotCaseId: row.id, actionRunId: runId } });
    const updatedFacts = await autopilotFacts(tx, p.tenantId, row.inquiryId, now, { inboundId: row.inboundId });
    const task = await tx.task.findFirstOrThrow({ where: { tenantId: p.tenantId, id: taskId! } });
    if (!updatedFacts || task.ownerMembershipId !== member.id || updatedFacts.inquiry.assigneeMembershipId !== member.id || updatedFacts.conversation.assigneeMembershipId !== member.id) throw new Error("Autopilot postcondition failed");
    await tx.autopilotCase.update({ where: { id: row.id }, data: { state: phase, taskId, assignedMembershipId: member.id, lastRunId: runId,
      expectedJson: { manualHash: updatedFacts.manualHash, taskHash: actionHash(task) }, dueAt: nextDue, explanation: `${summary}. Ожидаем фактический ответ клиенту.`, version: { increment: 1 }, updatedAt: now } });
    await lockSituationEpisodes(tx, p.tenantId);
    const episode = await tx.situationEpisode.update({ where: { tenantId_id: { tenantId: p.tenantId, id: row.episodeId } }, data: { taskId, assignedMembershipId: member.id, state: "in_progress", version: { increment: 1 }, updatedAt: now } });
    await tx.situationEpisodeEvent.create({ data: { tenantId: p.tenantId, episodeId: episode.id, version: episode.version, kind: "autopilot_assigned", detailsJson: { occurrence: episode.occurrence, taskId, runId } } });
    await event(tx, p, "effect", { text: `${summary}. Ожидаем фактический ответ сотрудника клиенту.`, runId, phase }, now, row.id, actor.user.id);
    await requeue(new Date(Math.min(nextDue.getTime(), now.getTime() + MINUTE)));
  }, txOptions);
}

export async function failAutopilotCheck(db: PrismaClient, item: { id: string; tenantId: string; parentId: string; version: number }, now = new Date()) {
  await db.$transaction(async tx => {
    await lock(tx, item.tenantId);
    const job = await tx.scheduledAction.findFirst({ where: { id: item.id, tenantId: item.tenantId, state: "running", version: item.version + 1 } });
    if (!job) return;
    const failures = Number(record(job.payloadJson).failures || 0) + 1;
    if (failures < 3) { await tx.scheduledAction.update({ where: { id: job.id }, data: { state: "scheduled", version: { increment: 1 }, dueAt: new Date(now.getTime() + MINUTE), payloadJson: { failures } } }); return; }
    const p = await tx.autopilotPolicy.findUnique({ where: { tenantId: item.tenantId } });
    const row = await tx.autopilotCase.findFirst({ where: { tenantId: item.tenantId, id: item.parentId } });
    if (p && row && !terminal(row)) await finish(tx, p, row, "attention", "Не удалось выполнить внутренний этап после 3 попыток. Проверьте заявку вручную.", now);
    else await tx.scheduledAction.update({ where: { id: job.id }, data: { state: "failed", cancelReason: "Внутренний этап не выполнен." } });
  }, txOptions);
}
