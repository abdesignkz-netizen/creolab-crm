import type { PrismaClient } from "@creolab/db";
import type { WASocket } from "@whiskeysockets/baileys";
import type { ControlAction } from "@creolab/contracts";
import { randomUUID } from "node:crypto";
import { authorizeNativeControl, controlAuthorizationVersion } from "./aiControlService.ts";
import { chatSettings, record } from "./controlChatSettings.ts";
import { processControlChatRequests } from "./controlChatService.ts";

type QrDispatch = { integrationId: string; socket: Pick<WASocket, "sendMessage">; checkLease: () => Promise<void> };
export function controlScheduleClock(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const val = (key: string) => parts.find(p => p.type === key)?.value || "";
  return { day: `${val("year")}-${val("month")}-${val("day")}`, minutes: Number(val("hour")) * 60 + Number(val("minute")), weekend: ["Sat", "Sun"].includes(val("weekday")) };
}
export async function buildControlBriefings(prisma: PrismaClient, now = new Date()) {
  let cursor: string | undefined;
  for (;;) {
    const identities = await prisma.controlIdentity.findMany({ where: { provider: "WHATSAPP", enabled: true, verifiedAt: { not: null }, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: "asc" }, take: 200 });
    if (!identities.length) break;
    cursor = identities.at(-1)!.id;
    for (const identity of identities) {
      const prefs = chatSettings(identity.metadata);
      if (!prefs?.enabled || !prefs.morningEnabled && !prefs.eveningEnabled) continue;
      let ctx;
      try { ctx = await authorizeNativeControl(prisma, prefs.integrationId, identity.id); } catch { continue; }
      if (ctx.integration.type !== "whatsapp_qr") continue;
      const clock = controlScheduleClock(now, ctx.integration.tenant.timezone || "Asia/Almaty");
      if (prefs.weekdaysOnly && clock.weekend) continue;
      const due = (["morning", "evening"] as const).filter(kind => {
        const [h, m] = prefs[`${kind}Time`].split(":").map(Number);
        return prefs[`${kind}Enabled`] && clock.minutes >= h * 60 + m && clock.minutes < h * 60 + m + 30;
      });
      if (!due.length) continue;
      // A single daily key per slot survives restarts. Never replay stale summaries after an outage.
      const revision = String(record(identity.metadata).chatRevision || identity.updatedAt.toISOString());
      const keys = due.map(kind => `brief:${identity.id}:${revision}:${clock.day}:${kind}`);
      const existing = await prisma.controlChatMessage.findMany({ where: { integrationId: prefs.integrationId, eventKey: { in: keys } }, select: { eventKey: true } });
      const missing = due.filter((_, i) => !existing.some(r => r.eventKey === keys[i]));
      if (!missing.length) continue;
      await prisma.$transaction(async tx => {
        // Serialize schedule builders across API and worker processes.
        await tx.$queryRaw`SELECT id FROM "ControlIdentity" WHERE id = ${identity.id} FOR UPDATE`;
        for (const kind of missing) {
          const eventKey = `brief:${identity.id}:${revision}:${clock.day}:${kind}`;
          await tx.controlChatMessage.upsert({ where: { integrationId_eventKey: { integrationId: prefs.integrationId, eventKey } }, update: {}, create: { tenantId: identity.tenantId, identityId: identity.id, integrationId: prefs.integrationId, eventKey, kind: "briefing", text: kind, identityVersion: identity.updatedAt.toISOString(), createdAt: now } });
        }
        const queued = await tx.controlChatMessage.findMany({ where: { identityId: identity.id, integrationId: prefs.integrationId, kind: "briefing", state: "queued", createdAt: { gte: new Date(now.getTime() - 30 * 60000) } }, orderBy: [{ createdAt: "asc" }, { queueOrder: "asc" }] });
        if (queued.length > 1) {
          await tx.controlChatMessage.update({ where: { id: queued[0].id }, data: { text: [...new Set(queued.flatMap(r => r.text.split(",")))].join(",") } });
          await tx.controlChatMessage.updateMany({ where: { id: { in: queued.slice(1).map(r => r.id) }, state: "queued" }, data: { state: "merged", finishedAt: now } });
        }
      });
    }
  }
}

export async function deliverControlChatReplies(prisma: PrismaClient, qr?: QrDispatch, now = new Date()) {
  const senders = qr ? [qr.integrationId] : (await prisma.integration.findMany({ where: { type: "whatsapp_cloud", status: "active" }, select: { id: true } })).map(row => row.id);
  const rows = await prisma.controlChatMessage.findMany({ where: { state: "ready", integrationId: { in: senders } }, orderBy: [{ createdAt: "asc" }, { queueOrder: "asc" }], take: 20 });
  for (const row of rows) {
    // Share the per-person lease with request processing: concurrent workers may not
    // deliver a later reply before the preceding menu, choice or confirmation.
    const session = await prisma.controlChatSession.findUnique({ where: { identityId_integrationId: { identityId: row.identityId, integrationId: row.integrationId } } });
    if (!session) continue;
    const owner = randomUUID(), leaseNow = new Date();
    const lease = await prisma.controlChatSession.updateMany({ where: { id: session.id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: leaseNow } }] }, data: { leaseOwner: owner, leaseUntil: new Date(leaseNow.getTime() + 60000) } });
    if (!lease.count) continue;
    try {
      const first = await prisma.controlChatMessage.findFirst({ where: { identityId: row.identityId, integrationId: row.integrationId, state: { in: ["queued", "processing", "ready", "sending"] } }, orderBy: [{ createdAt: "asc" }, { queueOrder: "asc" }], select: { id: true } });
      if (first?.id !== row.id) continue;
      const integration = await prisma.integration.findUnique({ where: { id: row.integrationId }, include: { tenant: true } });
      if (!integration || (!qr && integration.type === "whatsapp_qr")) continue;
      const identity = await prisma.controlIdentity.findUnique({ where: { id: row.identityId } });
      const prefs = chatSettings(identity?.metadata);
      const skip = async (error: string) => { await prisma.controlChatMessage.updateMany({ where: { id: row.id, state: "ready" }, data: { state: "skipped", error, finishedAt: now } }); };
      if (!identity?.enabled || !prefs?.enabled || prefs.integrationId !== row.integrationId || integration.tenant.status !== "active" || integration.status !== "active" || identity.updatedAt.toISOString() !== row.identityVersion) { await skip("access_changed"); continue; }
      if (now.getTime() - row.createdAt.getTime() > (row.kind === "briefing" ? 30 * 60000 : 15 * 60000)) { await skip("expired"); continue; }
      if (integration.connectionStatus !== "CONNECTED") continue;
      try {
        if (identity.verifiedAt) {
          const ctx = await authorizeNativeControl(prisma, row.integrationId, row.identityId);
          if (row.accessVersion !== controlAuthorizationVersion(ctx)) { await skip("access_changed"); continue; }
          for (const action of (Array.isArray(row.actionsJson) ? row.actionsJson : []) as ControlAction[]) await authorizeNativeControl(prisma, row.integrationId, row.identityId, action);
        } else if (Array.isArray(row.actionsJson) && row.actionsJson.length) { await skip("not_verified"); continue; }
      } catch { await skip("access_revoked"); continue; }
      await qr?.checkLease();
      const claimed = await prisma.controlChatMessage.updateMany({ where: { id: row.id, state: "ready" }, data: { state: "sending", claimedAt: now } });
      if (!claimed.count) continue;
      let started = false;
      try {
        const phone = identity.phoneNormalized?.replace(/\D/g, "");
        if (!phone || !row.replyText) throw new Error("Invalid recipient");
        let providerRef: string | undefined;
        if (qr) {
          await qr.checkLease(); started = true;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const sent = await Promise.race([qr.socket.sendMessage(`${phone}@s.whatsapp.net`, { text: row.replyText }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 20000); })]);
            providerRef = sent?.key.id || undefined;
          } finally { clearTimeout(timer); }
        } else if (integration.type === "whatsapp_cloud" && row.kind === "request") {
          const { cloudSecrets, cloudRequest } = await import("./whatsappCloudService.ts");
          const secrets = await cloudSecrets(prisma, integration), settings = record(integration.schemaJson);
          started = true;
          // Direct response to a fresh authenticated inbound, within Meta's service window.
          const sent = await cloudRequest<{ messages?: Array<{ id: string }> }>(secrets, settings.apiVersion, `/${settings.phoneNumberId}/messages`, { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "text", text: { body: row.replyText.slice(0, 4000), preview_url: false } }) });
          providerRef = sent.messages?.[0]?.id;
        }
        if (!providerRef) throw new Error("Delivery unknown");
        await prisma.controlChatMessage.update({ where: { id: row.id }, data: { state: "accepted", providerRef, finishedAt: new Date(), error: null } });
      } catch {
        // A timeout can occur after provider acceptance. Never re-execute or blindly resend.
        await prisma.controlChatMessage.updateMany({ where: { id: row.id, state: "sending" }, data: { state: started ? "uncertain" : "failed", error: started ? "delivery_unknown" : "sender_unavailable", finishedAt: new Date() } });
      }
    } finally {
      await prisma.controlChatSession.updateMany({ where: { id: session.id, leaseOwner: owner }, data: { leaseOwner: null, leaseUntil: null } });
    }
  }
}
export async function processControlChat(prisma: PrismaClient) {
  await prisma.controlChatMessage.updateMany({ where: { state: "sending", claimedAt: { lt: new Date(Date.now() - 120000) } }, data: { state: "uncertain", error: "delivery_unknown", finishedAt: new Date() } });
  await prisma.controlChatMessage.updateMany({ where: { state: { in: ["queued", "ready"] }, createdAt: { lt: new Date(Date.now() - 30 * 60000) } }, data: { state: "skipped", error: "expired", finishedAt: new Date() } });
  await buildControlBriefings(prisma);
  await processControlChatRequests(prisma);
  await deliverControlChatReplies(prisma);
}
