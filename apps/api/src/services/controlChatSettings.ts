import type { PrismaClient, Prisma } from "@creolab/db";
import { controlChatSettingsSchema, type ControlChatSettings } from "@creolab/contracts";
import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.ts";
import { requireCompanyAdmin, requireTenant } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import type { AuthContext } from "../lib/types.ts";
export const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export function chatSettings(metadata: unknown): ControlChatSettings | null {
  const parsed = controlChatSettingsSchema.safeParse(record(metadata).chat);
  return parsed.success ? parsed.data : null;
}
export async function saveControlChatSettings(prisma: PrismaClient, auth: AuthContext, identityId: string, body: unknown) {
  requireCompanyAdmin(auth); const { tenantId } = requireTenant(auth);
  const prefs = controlChatSettingsSchema.parse(body);
  const identity = await prisma.controlIdentity.findFirst({ where: { id: identityId, tenantId, provider: "WHATSAPP" } });
  if (!identity) throw new ApiError(404, "not_found", "Номер не найден");
  const sender = await prisma.integration.findFirst({ where: { id: prefs.integrationId, tenantId, type: { in: ["whatsapp_qr", "whatsapp_cloud"] } } });
  if (!sender) throw new ApiError(422, "invalid", "Выберите WhatsApp компании");
  if (prefs.enabled && (sender.status !== "active" || sender.connectionStatus !== "CONNECTED")) throw new ApiError(409, "sender_unavailable", "Сначала подключите WhatsApp компании в разделе интеграций");
  const phone = String(record(sender.schemaJson).phone || "").replace(/\D/g, "");
  if (phone && phone === identity.phoneNormalized?.replace(/\D/g, "")) throw new ApiError(422, "same_phone", "Личный номер сотрудника должен отличаться от номера WhatsApp компании");
  if ((prefs.morningEnabled || prefs.eveningEnabled) && sender.type !== "whatsapp_qr") throw new ApiError(422, "schedule_unavailable", "Плановые сводки доступны через WhatsApp QR. Для Cloud API нужны согласованные шаблоны Meta.");
  const changed = await prisma.$transaction(async tx => {
    const updated = await tx.controlIdentity.updateMany({ where: { id: identity.id, tenantId, updatedAt: identity.updatedAt }, data: { metadata: { ...record(identity.metadata), chat: prefs, chatRevision: randomUUID() } as Prisma.InputJsonValue } });
    if (!updated.count) throw new ApiError(409, "settings_changed", "Настройки изменились. Обновите страницу.");
    await tx.controlChatSession.updateMany({ where: { identityId, tenantId }, data: { contextJson: {}, expiresAt: new Date(0) } });
    await tx.controlChatMessage.updateMany({ where: { identityId, tenantId, state: { in: ["queued", "ready"] } }, data: { state: "skipped", error: "settings_changed", finishedAt: new Date() } });
    await tx.controlConfirmation.updateMany({ where: { identityId, tenantId, source: "WHATSAPP", status: "pending" }, data: { status: "canceled" } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "control.whatsapp_settings_updated", entityType: "control_identity", entityId: identityId, changes: prefs });
    return prefs;
  });
  return changed;
}
