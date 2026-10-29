import { z } from "zod";
import { Prisma, type PrismaClient } from "@creolab/db";
import type { SetupState, SetupChannel } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { requireCompanyAdmin, requireTenant } from "../lib/access.ts";
import { ApiError } from "../errors.ts";
import { getEntitlements } from "./entitlementService.ts";
import { getEffectiveTenantSettings } from "./runtimeSettings.ts";

const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const channels: Record<SetupChannel, string[]> = {
  whatsapp: ["whatsapp_qr", "whatsapp_cloud", "whatsapp_seller"], telegram: ["telegram_bot"],
  instagram: ["instagram_direct"], "website-chat": ["website_chat"], form: ["form"],
};
const inputSchema = z.object({ channel: z.enum(["whatsapp", "telegram", "instagram", "website-chat", "form"]).optional(),
  replyMode: z.enum(["ai", "manual"]).optional(), deferred: z.boolean().optional(), finish: z.literal(true).optional() }).strict()
  .refine(v => !v.finish || Object.keys(v).length === 1, "Завершение не может одновременно менять маршрут");

export async function getOnboarding(prisma: PrismaClient, auth: AuthContext): Promise<SetupState> {
  requireCompanyAdmin(auth);
  const tenantId = requireTenant(auth).tenantId;
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const store = record(record(tenant.settingsJson).onboarding);
  const channel: SetupChannel | null = Object.hasOwn(channels, store.channel) ? store.channel : null;
  const started = Boolean(channel && store.startedAt);
  const replyMode = channel === "form" || store.replyMode === "manual" ? "manual" : "ai";
  const since = new Date(store.startedAt || tenant.createdAt);
  const [access, integrations, ai, knowledge, rules, settings] = await Promise.all([
    getEntitlements(prisma, tenantId),
    prisma.integration.findMany({ where: { tenantId, type: { in: channel ? channels[channel] : [] } },
      select: { id: true, status: true, connectionStatus: true,
        channelConnections: { where: { status: "active" }, select: { id: true } },
        forms: { where: { active: true }, select: { id: true } } } }),
    prisma.aIConfiguration.findFirst({ where: { tenantId, scope: "company" }, select: { promptStatus: true, systemPrompt: true } }),
    prisma.knowledgeDocument.findFirst({ where: { tenantId, status: "published", content: { not: "" } }, select: { id: true } }),
    prisma.auditEvent.findFirst({ where: { tenantId, action: "ai.automation_updated" }, select: { id: true } }),
    getEffectiveTenantSettings(prisma, tenantId),
  ]);
  const connected = integrations.filter(i => i.status === "active" && (channel === "form"
    ? i.forms.length > 0 && access.entitlements.CHANNELS && settings.features.forms.value
    : i.channelConnections.length > 0 && ["CONNECTED", "connected", "authorized"].includes(i.connectionStatus)));
  const connectionIds = connected.flatMap(i => i.channelConnections.map(c => c.id));
  const inbound = started ? await prisma.message.findFirst({ where: { tenantId, direction: "inbound", historical: false, internal: false,
    createdAt: { gte: since }, conversation: { connectionId: { in: connectionIds } } }, orderBy: { createdAt: "desc" }, select: { conversationId: true, createdAt: true } }) : null;
  const inquiry = started && channel === "form" ? await prisma.inquiry.findFirst({ where: { tenantId, integrationId: { in: connected.map(i => i.id) }, receivedAt: { gte: since } },
    orderBy: { receivedAt: "desc" }, select: { id: true } }) : null;
  // Any verified exchange since setup is enough. The next unanswered inbound
  // must not erase a previously successful test, even in another conversation.
  const replies = started && channel !== "form" && connectionIds.length ? await prisma.$queryRaw<Array<{ id: string; conversationId: string }>>(Prisma.sql`
    SELECT reply.id, reply."conversationId" FROM "Message" reply
    JOIN "Conversation" c ON c.id = reply."conversationId" AND c."tenantId" = reply."tenantId"
    WHERE reply."tenantId" = ${tenantId} AND c."connectionId" IN (${Prisma.join(connectionIds)})
      AND reply.direction = 'outbound' AND reply."senderKind" = ${replyMode === "ai" ? "ai" : "staff"}
      AND reply.internal = false AND reply.historical = false AND reply."createdAt" >= ${since}
      AND reply."operationState" IN ('accepted', 'sent') AND reply."receiptState" <> 'failed'
      AND (reply."connectionScopedId" IS NULL OR reply."connectionScopedId" NOT LIKE 'wa-ai-handoff:%')
      AND EXISTS (SELECT 1 FROM "Message" incoming WHERE incoming."tenantId" = ${tenantId}
        AND incoming."conversationId" = c.id AND incoming.direction = 'inbound'
        AND incoming.internal = false AND incoming.historical = false
        AND incoming."createdAt" >= ${since} AND incoming."createdAt" < reply."createdAt")
    ORDER BY reply."createdAt" DESC LIMIT 1
  `) : [];
  const reply = replies[0];
  const steps: SetupState["steps"] = [
    { id: "path", done: started }, { id: "channel", done: connected.length > 0 },
    ...(replyMode === "ai" ? [{ id: "knowledge" as const, done: Boolean(ai?.promptStatus === "published" && ai.systemPrompt?.trim() && knowledge) },
      { id: "rules" as const, done: Boolean(rules) }] : []),
    { id: "test", done: channel === "form" ? Boolean(inquiry) : Boolean(inbound && reply) },
  ];
  const e = access.entitlements;
  return { channel, replyMode, started, deferred: Boolean(store.deferred),
    suggested: Boolean(store.startedAt || ["not_started", "in_progress", "deferred"].includes(store.status)),
    completed: steps.every(s => s.done), steps,
    available: { whatsapp: Boolean(e.WHATSAPP), telegram: Boolean(e.TELEGRAM), instagram: Boolean(e.INSTAGRAM),
      "website-chat": Boolean(e.CHANNELS), form: Boolean(e.CHANNELS && settings.features.forms.value), ai: Boolean(e.AI_MANAGER) },
    evidence: { inbound: Boolean(inbound || inquiry), reply: Boolean(reply), conversationId: reply?.conversationId || inbound?.conversationId || null, inquiryId: inquiry?.id || null } };
}

export async function updateOnboarding(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  requireCompanyAdmin(auth);
  const tenantId = requireTenant(auth).tenantId, { finish, ...data } = inputSchema.parse(input);
  const verified = finish ? await getOnboarding(prisma, auth) : null;
  if (finish && !verified?.completed) throw new ApiError(409, "setup_incomplete", "Сначала выполните шаги и проверьте первое обращение");
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = record(tenant.settingsJson), previous = record(settings.onboarding);
    if (finish && (previous.channel !== verified?.channel || previous.replyMode !== verified?.replyMode)) {
      throw new ApiError(409, "setup_changed", "Маршрут изменился. Проверьте настройку ещё раз");
    }
    const changed = (data.channel && data.channel !== previous.channel) || (data.replyMode && data.replyMode !== previous.replyMode);
    const onboarding = { ...previous, ...data, schema: 2,
      ...(data.channel || data.replyMode ? { status: "in_progress", deferred: false,
        startedAt: changed || !previous.startedAt ? new Date().toISOString() : previous.startedAt } : {}),
      ...(data.deferred === true ? { status: "deferred", deferred: true } : {}),
      ...(data.deferred === false ? { status: previous.startedAt ? "in_progress" : "not_started", deferred: false } : {}),
      ...(finish ? { status: "completed", deferred: false, finishedAt: new Date().toISOString() } : {}) };
    if (onboarding.channel === "form") onboarding.replyMode = "manual";
    await tx.tenant.update({ where: { id: tenantId }, data: { settingsJson: { ...settings, onboarding } as Prisma.InputJsonValue } });
  });
  return getOnboarding(prisma, auth);
}

// Old clients must not mark a step complete just by opening its settings.
export async function validateLegacyOnboardingStep(prisma: PrismaClient, auth: AuthContext, step: string) {
  requireCompanyAdmin(auth);
  const state = await getOnboarding(prisma, auth);
  const mapping: Record<string, string> = { ai: "knowledge", whatsapp: "channel" };
  if (!mapping[step]) throw new ApiError(422, "invalid", "Продолжите настройку в разделе «Начало работы»");
  if (!state.steps.find(s => s.id === mapping[step])?.done) throw new ApiError(409, "setup_incomplete", "Сначала сохраните настройки и проверьте подключение");
}
