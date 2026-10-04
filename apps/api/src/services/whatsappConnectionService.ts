import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import { LIMITS, FEATURES } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { requireIntegrationsAccess, requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { decryptSecret } from "../lib/secretBox.ts";
import { writeAudit } from "../lib/audit.ts";
import { requireFeature, requireLimitAvailable } from "./entitlementService.ts";

export const WHATSAPP_TYPES = ["whatsapp_seller", "whatsapp_qr", "whatsapp_cloud"];
export const directWhatsAppTypes = ["whatsapp_qr", "whatsapp_cloud"];
export const waDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export const qrEnabled = () => process.env.WHATSAPP_QR_ENABLED !== "0";

export async function requireWhatsAppSlot(prisma: PrismaClient, auth: AuthContext) {
  requireIntegrationsAccess(auth);
  await requireFeature(prisma, auth, FEATURES.WHATSAPP);
  const { tenantId } = requireTenant(auth);
  const used = await prisma.integration.count({ where: { tenantId, type: { in: WHATSAPP_TYPES }, status: { not: "disabled" }, connectionStatus: { not: "DISCONNECTED" } } });
  await requireLimitAvailable(prisma, tenantId, LIMITS.WHATSAPP_CONNECTIONS, used, "Лимит WhatsApp исчерпан. Подключите дополнительный номер.");
  // The database quota trigger serializes concurrent reservations across all providers.
  return tenantId;
}

export async function ownedWhatsApp(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireIntegrationsAccess(auth);
  const { tenantId } = requireTenant(auth);
  const row = await prisma.integration.findFirst({ where: { id, tenantId, type: { in: directWhatsAppTypes } } });
  if (!row) throw new ApiError(404, "not_found", "Подключение не найдено");
  return row;
}

export async function connectWhatsAppQr(prisma: PrismaClient, auth: AuthContext) {
  if (!qrEnabled()) throw new ApiError(503, "whatsapp_qr_unavailable", "QR-подключение временно недоступно");
  const tenantId = await requireWhatsAppSlot(prisma, auth);
  const id = randomUUID();
  await prisma.$transaction(async tx => {
    await tx.integration.create({ data: { id, tenantId, type: "whatsapp_qr", name: "WhatsApp · QR", status: "pending", connectionStatus: "CONNECTING", testMode: false } });
    await tx.$executeRaw`INSERT INTO "WhatsAppQrSession" ("integrationId") VALUES (${id})`;
    await tx.channelConnection.create({ data: { tenantId, integrationId: id, channelType: "whatsapp", status: "pending", capabilitiesJson: ["receive_messages", "send_text", "send_media"] } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.whatsapp_qr_created", entityType: "integration", entityId: id });
  });
  return { id, status: "CONNECTING" };
}

export async function listWhatsAppConnections(prisma: PrismaClient, auth: AuthContext) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const rows = await prisma.integration.findMany({ where: { tenantId, type: { in: directWhatsAppTypes }, status: { not: "disabled" } }, include: { channelConnections: { select: { autoReply: true } } }, orderBy: { name: "asc" } });
  const { directAiReadiness } = await import("./whatsappAiService.ts");
  const aiUnavailableReason = await directAiReadiness(prisma, tenantId);
  return { qrAvailable: qrEnabled(), items: rows.map(row => {
    const settings = row.schemaJson as Record<string, string>;
    return { id: row.id, provider: row.type === "whatsapp_qr" ? "qr" : "cloud", status: row.connectionStatus,
      phone: settings.phone || null, lastError: row.lastError, lastEventAt: row.lastEventAt,
      callbackUrl: settings.callbackUrl || null, webhookVerified: Boolean(settings.webhookVerifiedAt), aiAvailable: !aiUnavailableReason,
      aiUnavailableReason, aiEnabled: row.channelConnections.some(channel => channel.autoReply) };
  }) };
}

export async function getWhatsAppQr(prisma: PrismaClient, auth: AuthContext, id: string) {
  const row = await ownedWhatsApp(prisma, auth, id);
  if (row.type !== "whatsapp_qr" || row.status === "disabled") throw new ApiError(404, "not_found", "Подключение не найдено");
  const sessions = await prisma.$queryRaw<Array<{ encryptedQr: string | null; qrExpiresAt: Date | null }>>`SELECT "encryptedQr", "qrExpiresAt" FROM "WhatsAppQrSession" WHERE "integrationId" = ${id}`;
  const session = sessions[0];
  const qr = session?.encryptedQr && session.qrExpiresAt && session.qrExpiresAt.getTime() > Date.now() ? decryptSecret(session.encryptedQr) : null;
  const { default: QRCode } = await import("qrcode");
  return { status: row.connectionStatus, qr: qr ? await QRCode.toDataURL(qr, { width: 280, margin: 2 }) : null, expiresAt: qr ? session.qrExpiresAt : null };
}

export async function disconnectDirectWhatsApp(prisma: PrismaClient, auth: AuthContext, id: string) {
  const row = await ownedWhatsApp(prisma, auth, id);
  // A remote worker observes disabled state and logs out. Keep its lease until then.
  await prisma.$transaction(async tx => {
    await tx.integration.update({ where: { id }, data: { status: "disabled", connectionStatus: "DISCONNECTED", publicKey: null, secretHash: null, credentialId: null } });
    await tx.channelConnection.updateMany({ where: { integrationId: id, tenantId: row.tenantId }, data: { status: "disabled" } });
    if (row.credentialId) await tx.credential.deleteMany({ where: { id: row.credentialId, tenantId: row.tenantId } });
    await tx.$executeRaw`UPDATE "WhatsAppQrSession" SET "encryptedQr" = NULL, "qrExpiresAt" = NULL WHERE "integrationId" = ${id}`;
    await tx.$executeRaw`DELETE FROM "WhatsAppQrKey" WHERE "integrationId" = ${id}`;
    await tx.$executeRaw`DELETE FROM "WhatsAppQrJob" WHERE "integrationId" = ${id} AND state = 'queued'`;
    await tx.message.updateMany({ where: { tenantId: row.tenantId, conversation: { connection: { integrationId: id } }, operationState: "queued", direction: "outbound" }, data: { operationState: "failed" } });
    await tx.outboundOperation.updateMany({ where: { tenantId: row.tenantId, conversation: { connection: { integrationId: id } }, state: "queued" }, data: { state: "failed", error: "WhatsApp disconnected" } });
    await writeAudit(tx, { tenantId: row.tenantId, actorUserId: auth.user.id, action: `integration.${row.type}_disconnected`, entityType: "integration", entityId: id });
  });
  return { disconnected: true };
}
