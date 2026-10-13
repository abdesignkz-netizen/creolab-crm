import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { COMPANY_ADMIN_ROLES, FEATURES, CONTROL_NOTICE_CATEGORIES, CONTROL_NOTICE_CATEGORIES_KK, controlNoticeSchema, validateClientPhone, type ControlNoticeInput, type ControlNoticeCategory } from "@creolab/contracts";
import type { WASocket } from "@whiskeysockets/baileys";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireCompanyAdmin, requireTenant } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import { decryptSecret } from "../lib/secretBox.ts";
import { config } from "../config.ts";
import { canUseFeature, requireFeature } from "./entitlementService.ts";
import { EVENT_CATEGORY } from "./notificationPolicy.ts";

type Db = PrismaClient | Prisma.TransactionClient;
type Rule = Awaited<ReturnType<PrismaClient["controlNotificationRule"]["findUniqueOrThrow"]>>;
type Integration = Awaited<ReturnType<PrismaClient["integration"]["findUniqueOrThrow"]>>;
const roles = [...COMPANY_ADMIN_ROLES];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const settings = (rule: Rule) => rule.settingsJson as unknown as ControlNoticeInput;
const digits = (phone: string) => phone.replace(/\D/g, "");
const conflict = () => new ApiError(409, "control_notice_changed", "Настройки изменились в другой вкладке. Обновите страницу.");

function greenConfig(row: Integration) {
  const schema = row.schemaJson as Record<string, string>;
  const instance = schema.instanceId || "";
  const host = schema.greenApiHost || `${instance}.api.green-api.com`;
  const valid = /^\d{4,30}$/.test(instance) && /^(?:[a-z0-9-]+\.)*(?:green-api\.com|greenapi\.com)$/.test(host) && Boolean(schema.apiTokenEnc);
  return { instance, host, encryptedToken: schema.apiTokenEnc, valid };
}
function senderSupported(row: Integration) {
  return !row.testMode && (row.type === "whatsapp_qr" || row.type === "whatsapp_seller" && greenConfig(row).valid);
}
function senderReady(row: Integration) {
  return senderSupported(row) && row.status === "active" && (row.type !== "whatsapp_qr" || row.connectionStatus === "CONNECTED");
}
function senderPhone(row: Integration) { return digits(String((row.schemaJson as any)?.phone || "")); }

export async function controlNotificationSettings(prisma: PrismaClient, auth: AuthContext) {
  requireCompanyAdmin(auth); const { tenantId } = requireTenant(auth);
  const [members, integrations, rules, available] = await Promise.all([
    prisma.membership.findMany({ where: { tenantId, active: true, role: { in: roles }, user: { status: "active" } }, include: { user: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.integration.findMany({ where: { tenantId, type: { in: ["whatsapp_qr", "whatsapp_seller", "whatsapp_cloud"] }, status: { not: "disabled" } }, orderBy: { name: "asc" } }),
    prisma.controlNotificationRule.findMany({ where: { tenantId }, include: { batches: { where: { state: { not: "merged" } }, orderBy: { createdAt: "desc" }, take: 8, select: { id: true, kind: true, state: true, error: true, createdAt: true, finishedAt: true } } } }),
    canUseFeature(prisma, tenantId, FEATURES.AI_CONTROL),
  ]);
  return {
    available, members: members.map(m => ({ id: m.id, name: m.user.name, role: m.role })),
    senders: integrations.map(row => ({ id: row.id, name: row.name, phone: senderPhone(row), supported: senderSupported(row), ready: senderReady(row),
      note: row.type === "whatsapp_cloud" ? "Для Meta Cloud API нужен отдельный одобренный шаблон уведомлений. Выберите QR или Green API."
        : !senderSupported(row) ? "Для отправки нужны действующие параметры Green API." : !senderReady(row) ? "Восстановите подключение WhatsApp в интеграциях." : null })),
    rules: rules.map(rule => ({ id: rule.id, ...settings(rule), membershipId: rule.membershipId, integrationId: rule.integrationId, phone: rule.phone, enabled: rule.enabled, version: rule.version, history: rule.batches })),
  };
}

export async function saveControlNotificationSettings(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  requireCompanyAdmin(auth); const { tenantId, tenant } = requireTenant(auth);
  const parsed = controlNoticeSchema.parse(input);
  if (parsed.enabled) await requireFeature(prisma, auth, FEATURES.AI_CONTROL);
  const phone = validateClientPhone(parsed.phone, tenant.defaultRegion || "KZ");
  if (!phone.ok) throw new ApiError(422, phone.code, phone.message);
  const recipient = await prisma.membership.findFirst({ where: { tenantId, id: parsed.membershipId, active: true, role: { in: roles }, user: { status: "active" } } });
  if (!recipient) throw new ApiError(422, "control_notice_recipient", "Получатель должен быть действующим администратором или директором компании.");
  const integration = await prisma.integration.findFirst({ where: { id: parsed.integrationId, tenantId } });
  if (!integration || !senderSupported(integration)) throw new ApiError(422, "control_notice_sender", "Выберите WhatsApp, подключённый через QR или Green API.");
  if (senderPhone(integration) === digits(phone.normalized)) throw new ApiError(422, "control_notice_same_phone", "Номер получателя должен отличаться от номера отправителя.");
  if (parsed.enabled && !senderReady(integration)) throw new ApiError(409, "control_notice_offline", "Восстановите подключение WhatsApp перед включением уведомлений.");
  if (parsed.enabled && Object.values(parsed.events).every(value => value === "off")) throw new ApiError(422, "control_notice_empty", "Выберите хотя бы одно событие.");
  const result = await prisma.$transaction(async tx => {
    // Serialize initial creation for this member, then share the dispatcher's rule lock.
    // A table-wide lock can deadlock with a dispatcher already holding a row lock.
    await tx.$queryRaw`SELECT id FROM "Membership" WHERE id = ${parsed.membershipId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ControlNotificationRule" WHERE "membershipId" = ${parsed.membershipId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const current = await tx.controlNotificationRule.findUnique({ where: { tenantId_membershipId: { tenantId, membershipId: parsed.membershipId } } });
    if ((current?.version || 0) !== parsed.version) throw conflict();
    const other = await tx.controlNotificationRule.findFirst({ where: { tenantId, phone: phone.normalized, membershipId: { not: parsed.membershipId } } });
    if (other) throw new ApiError(409, "control_notice_phone_used", "Этот номер уже выбран для другого сотрудника.");
    const data = { phone: phone.normalized, integrationId: parsed.integrationId, enabled: parsed.enabled, version: (current?.version || 0) + 1,
      settingsJson: { ...parsed, phone: phone.normalized } as Prisma.InputJsonValue };
    const row = current ? await tx.controlNotificationRule.update({ where: { id: current.id }, data })
      : await tx.controlNotificationRule.create({ data: { ...data, tenantId, membershipId: parsed.membershipId } });
    // Never forward a previous recipient's queued notices to a newly entered number.
    await tx.controlNotificationBatch.updateMany({ where: { ruleId: row.id, state: "queued" }, data: { state: "skipped", error: "settings_changed", finishedAt: new Date() } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "control.notifications_updated", entityType: "control_access", entityId: row.id,
      changes: { membershipId: parsed.membershipId, enabled: parsed.enabled, events: parsed.events, recipientConfirmed: true } });
    return row;
  }).catch(error => {
    if (error?.code === "P2002") throw new ApiError(409, "control_notice_phone_used", "Этот номер уже выбран для другого сотрудника.");
    throw error;
  });
  return { id: result.id, version: result.version };
}

export async function pauseControlNotifications(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireCompanyAdmin(auth); const { tenantId } = requireTenant(auth);
  await prisma.$transaction(async tx => {
    const result = await tx.controlNotificationRule.updateMany({ where: { id, tenantId }, data: { enabled: false, version: { increment: 1 } } });
    if (!result.count) throw new ApiError(404, "not_found", "Настройка не найдена");
    await tx.controlNotificationBatch.updateMany({ where: { ruleId: id, state: "queued" }, data: { state: "skipped", error: "disabled", finishedAt: new Date() } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "control.notifications_paused", entityType: "control_access", entityId: id });
  });
  return { paused: true };
}

/** Company-wide operational events, deduplicated across all original staff recipients. No client text is copied. */
export async function queueControlNotification(prisma: Db, input: { tenantId: string; type: string; entityId: string; episodeKey?: string; priority?: string }) {
  const category = EVENT_CATEGORY[input.type] as ControlNoticeCategory | undefined;
  if (!category) return;
  const rules = await prisma.controlNotificationRule.findMany({ where: { tenantId: input.tenantId, enabled: true,
    membership: { active: true, role: { in: roles }, user: { status: "active" } } } });
  for (const rule of rules) {
    const mode = settings(rule).events[category];
    if (!mode || mode === "off") continue;
    const eventKey = hash(input.episodeKey || `${input.type}:${input.entityId}`);
    await prisma.controlNotificationItem.upsert({ where: { ruleId_eventKey: { ruleId: rule.id, eventKey } }, update: {},
      create: { ruleId: rule.id, version: rule.version, eventKey, category, mode, urgent: input.priority === "high" || input.priority === "urgent" } });
  }
}

export function controlLocalTime(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (key: string) => parts.find(p => p.type === key)!.value;
  return { day: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}
export function controlQuiet(prefs: ControlNoticeInput, now: Date) {
  if (!prefs.quietHours.enabled) return false;
  const { start, end } = prefs.quietHours, { time } = controlLocalTime(now, prefs.timezone);
  return start <= end ? time >= start && time < end : time >= start || time < end;
}
async function eligible(prisma: Db, rule: Rule) {
  return Boolean(await prisma.membership.findFirst({ where: { id: rule.membershipId, tenantId: rule.tenantId, active: true, role: { in: roles }, tenant: { status: "active" }, user: { status: "active" } }, select: { id: true } }));
}

export async function buildControlNotificationBatches(prisma: PrismaClient, now = new Date()) {
  const rules = await prisma.controlNotificationRule.findMany({ where: { enabled: true, membership: { tenant: { status: "active" } } } });
  for (const candidate of rules) {
    if (!await eligible(prisma, candidate) || !await canUseFeature(prisma, candidate.tenantId, FEATURES.AI_CONTROL)) continue;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ControlNotificationRule" WHERE id = ${candidate.id} FOR UPDATE`;
      const rule = await tx.controlNotificationRule.findUniqueOrThrow({ where: { id: candidate.id } });
      if (!rule.enabled) return;
      const prefs = settings(rule), local = controlLocalTime(now, prefs.timezone), quiet = controlQuiet(prefs, now);
      for (const mode of ["instant", "digest"] as const) {
        // Create the digest at its scheduled time even during quiet hours.
        // Dispatch waits for the morning; otherwise a 23:00 digest would never run.
        if (mode === "digest" && (local.time < prefs.digestTime || !Object.values(prefs.events).includes("digest"))) continue;
        if (mode === "instant" && rule.lastInstantAt && now.getTime() - rule.lastInstantAt.getTime() < prefs.minIntervalMinutes * 60000) continue;
        const key = mode === "digest" ? `${rule.version}:digest:${local.day}` : randomUUID();
        if (mode === "digest" && await tx.controlNotificationBatch.findUnique({ where: { ruleId_key: { ruleId: rule.id, key } } })) continue;
        const items = await tx.controlNotificationItem.findMany({ where: { ruleId: rule.id, version: rule.version, mode, batchId: null,
          ...(mode === "instant" && quiet ? { urgent: true } : {}), createdAt: { lte: now, gte: new Date(now.getTime() - 7 * 86400000) } }, orderBy: { createdAt: "asc" }, take: 5000 });
        if (!items.length || mode === "instant" && quiet && !prefs.urgentDuringQuiet) continue;
        const counts: Record<string, number> = {};
        for (const item of items) counts[item.category] = (counts[item.category] || 0) + 1;
        const batch = await tx.controlNotificationBatch.create({ data: { ruleId: rule.id, version: rule.version, key, kind: mode, countsJson: counts, urgent: mode === "instant" && items.every(item => item.urgent), availableAt: now, createdAt: now } });
        await tx.controlNotificationItem.updateMany({ where: { id: { in: items.map(item => item.id) }, batchId: null }, data: { batchId: batch.id } });
        if (mode === "instant") await tx.controlNotificationRule.update({ where: { id: rule.id }, data: { lastInstantAt: now } });
      }
    });
  }
}

export async function testControlNotification(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireCompanyAdmin(auth); const { tenantId } = requireTenant(auth); await requireFeature(prisma, auth, FEATURES.AI_CONTROL);
  const rule = await prisma.controlNotificationRule.findFirst({ where: { id, tenantId }, include: { integration: true } });
  if (!rule || !await eligible(prisma, rule)) throw new ApiError(404, "not_found", "Настройка не найдена");
  if (!senderReady(rule.integration)) throw new ApiError(409, "control_notice_offline", "Восстановите подключение WhatsApp.");
  // An explicit test may be sent before enabling automatic notifications; it still respects quiet hours.
  const key = `${rule.version}:test:${Math.floor(Date.now() / 60000)}`;
  const row = await prisma.controlNotificationBatch.upsert({ where: { ruleId_key: { ruleId: id, key } }, update: {}, create: { ruleId: id, version: rule.version, key, kind: "test" } });
  return { id: row.id, state: row.state };
}

export function controlNotificationText(company: string, kind: string, counts: Record<string, number>, language: string) {
  const kk = language === "kk";
  const title = kind === "test" ? (kk ? "Тексеру хабарламасы. WhatsApp хабарландырулары қосылды." : "Проверочное сообщение. WhatsApp-уведомления настроены.")
    : kind === "summary" ? (kk ? "Жиналған оқиғалардың жиынтығы" : "Сводка накопившихся событий")
    : kind === "digest" ? (kk ? "Жұмыс оқиғаларының күнделікті жинағы" : "Ежедневная сводка рабочих событий") : (kk ? "Жұмыс оқиғалары" : "Рабочие события");
  const labels = kk ? CONTROL_NOTICE_CATEGORIES_KK : CONTROL_NOTICE_CATEGORIES;
  const safeCompany = company.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 120);
  return [`BasQar Control · ${safeCompany}`, title, ...Object.entries(counts).filter(([key]) => key in labels).map(([key, count]) => `${labels[key as ControlNoticeCategory]}: ${count}`),
    `${kk ? "Кабинетті ашу" : "Открыть кабинет"}: ${config.appBaseUrl.replace(/\/$/, "")}/today`].join("\n");
}

type QrDispatch = { integrationId: string; socket: Pick<WASocket, "sendMessage">; checkLease: () => Promise<void> };
export async function deliverControlNotifications(prisma: PrismaClient, qr?: QrDispatch, now = new Date()) {
  const batches = await prisma.controlNotificationBatch.findMany({ where: { state: "queued", availableAt: { lte: now }, rule: { integration: qr ? { id: qr.integrationId, type: "whatsapp_qr" } : { type: "whatsapp_seller" } } }, include: { rule: { include: { integration: true, membership: { include: { tenant: true } } } } }, orderBy: { createdAt: "asc" }, take: 10 });
  for (const batch of batches) {
    const rule = batch.rule, prefs = settings(rule), row = rule.integration;
    const skip = async (error: string) => { await prisma.controlNotificationBatch.updateMany({ where: { id: batch.id, state: "queued" }, data: { state: "skipped", error, finishedAt: now } }); };
    if (rule.version !== batch.version || !rule.enabled && batch.kind !== "test" || !await eligible(prisma, rule) || !await canUseFeature(prisma, rule.tenantId, FEATURES.AI_CONTROL)) { await skip("disabled"); continue; }
    if (now.getTime() - batch.createdAt.getTime() > (batch.kind === "test" ? 86400000 : 7 * 86400000)) { await skip("expired"); continue; }
    if (row.status === "disabled" || !senderSupported(row) || senderPhone(row) === digits(rule.phone)) { await skip("sender_unavailable"); continue; }
    if (!senderReady(row) || controlQuiet(prefs, now) && !(prefs.urgentDuringQuiet && batch.urgent && batch.kind !== "test")) {
      await prisma.controlNotificationBatch.updateMany({ where: { id: batch.id, state: "queued" }, data: { availableAt: new Date(now.getTime() + 60000), error: !senderReady(row) ? "sender_offline" : "quiet_hours" } }); continue;
    }
    await qr?.checkLease();
    const claimed = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ControlNotificationRule" WHERE id = ${rule.id} FOR UPDATE`;
      const current = await tx.controlNotificationBatch.findFirst({ where: { id: batch.id, state: "queued", availableAt: { lte: now }, rule: { version: batch.version, ...(batch.kind !== "test" ? { enabled: true } : {}) } } });
      if (!current) return null;
      // A provider's Retry-After must also hold back newer notices for this recipient.
      const delayed = current.kind !== "test" && await tx.controlNotificationBatch.findFirst({ where: { ruleId: rule.id, version: batch.version, state: "queued", error: "rate_limit", availableAt: { gt: now } }, orderBy: { availableAt: "desc" } });
      if (delayed) {
        await tx.controlNotificationBatch.update({ where: { id: current.id }, data: { availableAt: delayed.availableAt, error: "rate_limit" } });
        return null;
      }
      // A due digest can absorb fast events. Apply the interval before ANY automatic
      // send so a digest cannot bypass the limit by becoming a combined summary.
      if (current.kind !== "test" && prefs.minIntervalMinutes > 0) {
        const recent = await tx.controlNotificationBatch.findFirst({ where: { ruleId: rule.id, id: { not: current.id }, kind: { in: ["instant", "summary", "digest"] }, state: { in: ["sending", "accepted", "uncertain"] }, claimedAt: { gt: new Date(now.getTime() - prefs.minIntervalMinutes * 60000) } }, orderBy: { claimedAt: "desc" } });
        if (recent?.claimedAt) {
          await tx.controlNotificationBatch.update({ where: { id: current.id }, data: { availableAt: new Date(recent.claimedAt.getTime() + prefs.minIntervalMinutes * 60000), error: "send_interval" } });
          return null;
        }
      }
      const counts = { ...current.countsJson as Record<string, number> };
      let kind = current.kind, urgent = current.urgent, attempts = current.attempts;
      if (current.kind !== "test") {
        // Only safe, unsent notices for the SAME recipient/settings can be combined.
        // Unknown results and in-flight sends are never included or retried.
        const quiet = controlQuiet(prefs, now), cutoff = new Date(now.getTime() - 7 * 86400000);
        const pending = await tx.controlNotificationBatch.findMany({ where: { ruleId: rule.id, version: current.version, id: { not: current.id }, state: "queued", kind: { in: ["instant", "digest", "summary"] }, createdAt: { gte: cutoff, lte: now },
          OR: [{ availableAt: { lte: now } }, { error: { in: ["sender_offline", "quiet_hours", "send_interval"] } }],
          ...(quiet ? { urgent: true, kind: { in: ["instant", "summary"] } } : {}),
        } });
        const items = await tx.controlNotificationItem.findMany({ where: { ruleId: rule.id, version: current.version, batchId: null, mode: "instant", createdAt: { gte: cutoff, lte: now }, ...(quiet ? { urgent: true } : {}) } });
        for (const peer of pending) {
          for (const [category, count] of Object.entries(peer.countsJson as Record<string, number>)) counts[category] = (counts[category] || 0) + count;
          urgent = urgent && peer.urgent; attempts = Math.max(attempts, peer.attempts);
        }
        for (const item of items) { counts[item.category] = (counts[item.category] || 0) + 1; urgent = urgent && item.urgent; }
        if (pending.length || items.length) {
          kind = "summary";
          // Retain merged digest keys: the daily schedule must not send a second digest.
          await tx.controlNotificationBatch.updateMany({ where: { id: { in: pending.map(peer => peer.id) } }, data: { state: "merged", finishedAt: now } });
          await tx.controlNotificationItem.updateMany({ where: { OR: [{ batchId: { in: pending.map(peer => peer.id) } }, { id: { in: items.map(item => item.id) } }] }, data: { batchId: current.id } });
        }
      }
      return tx.controlNotificationBatch.update({ where: { id: current.id }, data: { state: "sending", kind, countsJson: counts, urgent, claimedAt: now, attempts: attempts + 1, error: null } });
    });
    if (!claimed) continue;
    let networkStarted = false;
    try {
      // Recheck just before dispatch; queued data is never routed through client conversations.
      const current = await prisma.controlNotificationRule.findUniqueOrThrow({ where: { id: rule.id }, include: { integration: true } });
      if (current.version !== batch.version || !await eligible(prisma, current) || !senderReady(current.integration)) {
        await prisma.controlNotificationBatch.update({ where: { id: batch.id }, data: { state: "skipped", error: "settings_changed", finishedAt: now } }); continue;
      }
      const text = controlNotificationText(rule.membership.tenant.name, claimed.kind, claimed.countsJson as Record<string, number>, prefs.language);
      let providerRef: string | undefined;
      if (qr) {
        await qr.checkLease(); networkStarted = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([qr.socket.sendMessage(`${digits(rule.phone)}@s.whatsapp.net`, { text }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 20000); })]);
          providerRef = result?.key.id || undefined;
        } finally { clearTimeout(timer); }
      } else {
        const green = greenConfig(current.integration); const token = decryptSecret(green.encryptedToken);
        if (!/^[a-zA-Z0-9_-]+$/.test(token)) throw new Error("Invalid configuration");
        networkStarted = true;
        const response = await fetch(`https://${green.host}/waInstance${green.instance}/sendMessage/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: `${digits(rule.phone)}@c.us`, message: text, linkPreview: false }), redirect: "error", signal: AbortSignal.timeout(15000) });
        if (response.status === 429 && claimed.attempts < 5) {
          const retry = Math.min(86400, Math.max(60, Number(response.headers.get("retry-after")) || 60));
          await prisma.controlNotificationBatch.update({ where: { id: batch.id }, data: { state: "queued", error: "rate_limit", availableAt: new Date(now.getTime() + retry * 1000) } }); continue;
        }
        if (response.status >= 400 && response.status < 500) {
          await prisma.controlNotificationBatch.update({ where: { id: batch.id }, data: { state: "failed", error: "provider_rejected", finishedAt: now } }); continue;
        }
        const data = await response.json() as { idMessage?: string };
        if (response.ok && typeof data.idMessage === "string" && data.idMessage) providerRef = data.idMessage;
      }
      if (!providerRef) throw new Error("Unconfirmed");
      await prisma.controlNotificationBatch.update({ where: { id: batch.id }, data: { state: "accepted", providerRef, finishedAt: new Date(), error: null } });
    } catch {
      await prisma.controlNotificationBatch.updateMany({ where: { id: batch.id, state: "sending" }, data: { state: networkStarted ? "uncertain" : "failed", error: networkStarted ? "delivery_unknown" : "sender_unavailable", finishedAt: new Date() } });
    }
  }
}

export async function processControlNotifications(prisma: PrismaClient) {
  await prisma.controlNotificationBatch.updateMany({ where: { state: "sending", claimedAt: { lt: new Date(Date.now() - 120000) } }, data: { state: "uncertain", error: "delivery_unknown", finishedAt: new Date() } });
  // An offline QR connection has no dispatcher; expiry must still be visible in history.
  await prisma.controlNotificationBatch.updateMany({ where: { state: "queued", OR: [
    { kind: "test", createdAt: { lt: new Date(Date.now() - 86400000) } },
    { kind: { not: "test" }, createdAt: { lt: new Date(Date.now() - 7 * 86400000) } },
  ] }, data: { state: "skipped", error: "expired", finishedAt: new Date() } });
  await buildControlNotificationBatches(prisma);
  await deliverControlNotifications(prisma);
}
