import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, Prisma } from "@creolab/db";
import { CONTROL_ACTION_META, type ControlAction } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { isManager } from "../lib/access.ts";
import { sha256 } from "../lib/hash.ts";
import { authorizeWebControl, executeWebControl, confirmWebControl, controlAuthorizationVersion } from "./aiControlService.ts";
import { runControlChatRequest } from "./controlChatService.ts";
import { record } from "./controlChatSettings.ts";

const inputSchema = z.object({ text: z.string().trim().min(1).max(2000), requestId: z.string().uuid() }).strict();
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const processingTimeout = 180000;
function version(ctx: Awaited<ReturnType<typeof authorizeWebControl>>) {
  const { lastActivityAt, updatedAt, createdAt, ...access } = ctx.access;
  return sha256(JSON.stringify({ access, member: ctx.auth.activeMembership }));
}
function readable(actions: unknown, access: Awaited<ReturnType<typeof authorizeWebControl>>["access"]) {
  return Array.isArray(actions) && actions.every((action: ControlAction) => {
    const meta = CONTROL_ACTION_META[action];
    return meta && (!meta.financial || access.canReadFinancialData) && (!meta.team || access.canReadTeamData)
      && (!Array.isArray(access.allowedActions) || !access.allowedActions.length || access.allowedActions.includes(action));
  });
}
export async function controlWebHistory(prisma: PrismaClient, auth: AuthContext) {
  const ctx = await authorizeWebControl(prisma, auth), tenantId = ctx.tenant.id;
  const identities = await prisma.controlIdentity.findMany({ where: { tenantId, userId: auth.user.id, enabled: true }, select: { id: true, provider: true, metadata: true } });
  const [web, whatsapp] = await Promise.all([
    prisma.auditEvent.findMany({ where: { tenantId, actorUserId: auth.user.id, action: "control.chat" }, orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.controlChatMessage.findMany({ where: { tenantId, identityId: { in: identities.filter(i => i.provider === "WHATSAPP").map(i => i.id) } }, orderBy: [{ createdAt: "desc" }, { queueOrder: "desc" }], take: 40 }),
  ]);
  const currentVersion = version(ctx);
  const whatsappVersion = controlAuthorizationVersion({ ...ctx, identity: { userId: auth.user.id } });
  const items = [
    ...web.filter(row => record(row.changesJson).accessVersion === currentVersion).map(row => {
      const data = record(row.changesJson);
      const interrupted = data.state === "processing" && Date.now() - row.createdAt.getTime() > processingTimeout;
      return { id: row.id, text: String(data.text || ""), reply: interrupted ? "Не удалось дождаться результата. Обновите историю и проверьте задачи или журнал действий перед повтором изменения." : String(data.reply || ""), state: interrupted ? "interrupted" : String(data.state || "processing"), source: "CRM_CHAT", createdAt: row.createdAt, actions: data.actions || [] };
    }),
    ...whatsapp.filter(row => row.accessVersion === whatsappVersion && readable(row.actionsJson, ctx.access)).map(row => ({ id: row.id, text: row.kind === "briefing" ? "Плановая сводка" : row.text, reply: row.replyText || "", state: row.state, source: "WHATSAPP", createdAt: row.createdAt, actions: row.actionsJson })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(-50);
  const webIdentity = identities.find(row => row.provider === "CRM_CHAT");
  const session = record(record(webIdentity?.metadata).web);
  const context = session.accessVersion === currentVersion && Number(session.expiresAt) > Date.now() ? record(session.context) : {};
  const pending = context.pendingId ? await prisma.controlConfirmation.findFirst({ where: { id: String(context.pendingId), tenantId, userId: auth.user.id, identityId: webIdentity!.id, source: "CRM_CHAT", status: "pending", expiresAt: { gt: new Date() } }, select: { id: true, summary: true, expiresAt: true } }) : null;
  return { items, pending, forecastAvailable: !isManager(auth) && readable(["GET_SALES_FORECAST"], ctx.access),
    choices: Array.isArray(context.choices?.items) ? context.choices.items.map((item: any, i: number) => ({ text: String(i + 1), label: String(item.label) })) : [], timezone: ctx.tenant.timezone || "Asia/Almaty" };
}

export async function sendControlWebMessage(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  const data = inputSchema.parse(input), ctx = await authorizeWebControl(prisma, auth), tenantId = ctx.tenant.id, accessVersion = version(ctx);
  const identity = await prisma.controlIdentity.upsert({ where: { tenantId_provider_externalUserId: { tenantId, provider: "CRM_CHAT", externalUserId: auth.user.id } },
    create: { tenantId, userId: auth.user.id, provider: "CRM_CHAT", externalUserId: auth.user.id, verifiedAt: new Date() }, update: {} });
  if (!identity.enabled) throw new ApiError(403, "control_disabled", "Доступ к Control отключён");
  const owner = randomUUID();
  const claim = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ControlIdentity" WHERE id = ${identity.id} FOR UPDATE`;
    const fresh = await tx.controlIdentity.findUniqueOrThrow({ where: { id: identity.id } });
    const previous = await tx.auditEvent.findFirst({ where: { tenantId, actorUserId: auth.user.id, action: "control.chat", correlationId: data.requestId } });
    if (previous) {
      if (record(previous.changesJson).text !== data.text) throw new ApiError(409, "request_conflict", "Этот запрос уже использован для другой команды");
      return { duplicate: true as const };
    }
    const metadata = record(fresh.metadata), session = record(metadata.web);
    if (Number(session.leaseUntil) > Date.now()) throw new ApiError(409, "control_busy", "Предыдущая команда ещё обрабатывается. Подождите несколько секунд.");
    const context = session.accessVersion === accessVersion && Number(session.expiresAt) > Date.now() ? record(session.context) : {};
    await tx.controlIdentity.update({ where: { id: identity.id }, data: { metadata: json({ ...metadata, web: { ...session, leaseOwner: owner, leaseUntil: Date.now() + processingTimeout } }) } });
    const entry = await tx.auditEvent.create({ data: { tenantId, actorUserId: auth.user.id, action: "control.chat", entityType: "control_chat", entityId: identity.id, correlationId: data.requestId,
      changesJson: json({ source: "CRM_CHAT", text: data.text, state: "processing", accessVersion }) } });
    return { duplicate: false as const, context, entry };
  });
  if (claim.duplicate) return controlWebHistory(prisma, auth);
  try {
    let response;
    try {
      response = await runControlChatRequest(prisma, { id: claim.entry.id, tenantId, identityId: identity.id, integrationId: "", text: data.text, kind: "web" }, claim.context, "ru", {
        authorize: action => authorizeWebControl(prisma, auth, action),
        execute: (action, params, requestId) => executeWebControl(prisma, auth, identity.id, action, params, requestId),
        confirm: id => confirmWebControl(prisma, auth, id),
      });
    } catch (error) {
      response = { text: error instanceof ApiError ? error.message : "Не удалось обработать запрос. Проверьте историю перед повтором изменения.", context: claim.context, actions: [] };
    }
    const after = await authorizeWebControl(prisma, auth);
    if (version(after) !== accessVersion) throw new ApiError(403, "access_changed", "Права доступа изменились. Обновите Control.");
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ControlIdentity" WHERE id = ${identity.id} FOR UPDATE`;
      const fresh = await tx.controlIdentity.findUniqueOrThrow({ where: { id: identity.id } }), metadata = record(fresh.metadata);
      if (record(metadata.web).leaseOwner !== owner) throw new ApiError(409, "control_busy", "Обработка прервана. Проверьте историю.");
      await tx.controlIdentity.update({ where: { id: identity.id }, data: { metadata: json({ ...metadata, web: { context: response.context, expiresAt: Date.now() + 1800000, accessVersion } }) } });
      await tx.auditEvent.update({ where: { id: claim.entry.id }, data: { changesJson: json({ source: "CRM_CHAT", text: data.text, reply: response.text, state: "done", actions: response.actions, accessVersion }) } });
    });
  } finally {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ControlIdentity" WHERE id = ${identity.id} FOR UPDATE`;
      const fresh = await tx.controlIdentity.findUniqueOrThrow({ where: { id: identity.id } }), metadata = record(fresh.metadata);
      if (record(metadata.web).leaseOwner === owner) await tx.controlIdentity.update({ where: { id: identity.id }, data: { metadata: json({ ...metadata, web: { ...record(metadata.web), leaseOwner: null, leaseUntil: null } }) } });
    });
  }
  return controlWebHistory(prisma, auth);
}
