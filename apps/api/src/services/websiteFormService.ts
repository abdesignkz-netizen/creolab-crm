import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { publicFormKey, type WebsiteFormItem, type WebsiteFormsState } from "@creolab/contracts";
import type { Prisma, PrismaClient } from "@creolab/db";
import { config } from "../config.ts";
import { ApiError } from "../errors.ts";
import { requireIntegrationsAccess, requireTenant } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import type { AuthContext } from "../lib/types.ts";
import { canUseFeature } from "./entitlementService.ts";
import { getEffectiveTenantSettings } from "./runtimeSettings.ts";

const domains = z.array(z.string().trim().min(1).max(300)).min(1).max(10).transform(values => [...new Set(values.map(value => {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.port || url.pathname !== "/" || !url.hostname.includes(".") || url.hostname.length > 253
      || !url.hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
      || /[<>\s]/.test(value)) throw new Error();
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch { throw new ApiError(422, "invalid_domain", "Укажите домен сайта без пути, например company.kz"); }
}))]);
const fields = {
  name: z.string().trim().min(1, "Укажите название формы").max(100),
  allowedDomains: domains,
  assigneeMembershipId: z.string().uuid().nullable(),
};
const createSchema = z.object({ ...fields, requestId: z.string().uuid() }).strict();
const updateSchema = z.object({ ...fields, enabled: z.boolean() }).partial().strict().refine(v => Object.keys(v).length > 0, "Нет изменений");

async function availability(prisma: PrismaClient, tenantId: string) {
  const [allowed, settings] = await Promise.all([canUseFeature(prisma, tenantId, "CHANNELS"), getEffectiveTenantSettings(prisma, tenantId)]);
  return !settings.features.forms.value ? "disabled" as const : !allowed ? "plan" as const : null;
}
async function requireAvailable(prisma: PrismaClient, tenantId: string) {
  const reason = await availability(prisma, tenantId);
  if (reason) throw new ApiError(403, reason === "plan" ? "feature_required" : "feature_disabled", reason === "plan"
    ? "Приём заявок с сайта недоступен по текущему тарифу" : "Формы сайта отключены для этой компании");
}
async function validateAssignee(tx: Prisma.TransactionClient, tenantId: string, id: string | null | undefined) {
  if (id && !await tx.membership.findFirst({ where: { id, tenantId, active: true } })) {
    throw new ApiError(422, "invalid_assignee", "Выберите действующего сотрудника вашей компании");
  }
}

export async function listWebsiteForms(prisma: PrismaClient, auth: AuthContext): Promise<WebsiteFormsState> {
  requireIntegrationsAccess(auth);
  const { tenantId } = requireTenant(auth);
  const [rows, members, unavailableReason] = await Promise.all([
    prisma.integration.findMany({ where: { tenantId, type: "form" }, orderBy: [{ name: "asc" }, { id: "asc" }],
      include: { forms: true, inquiries: { orderBy: { receivedAt: "desc" }, take: 1, select: { id: true, receivedAt: true, test: true } } } }),
    prisma.membership.findMany({ where: { tenantId, active: true }, select: { id: true, user: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
    availability(prisma, tenantId),
  ]);
  const items: WebsiteFormItem[] = rows.flatMap(row => row.forms.map(form => {
    const assignment = row.assignmentJson as { membershipId?: string } | null;
    const last = row.inquiries[0];
    return { id: form.id, integrationId: row.id, name: form.name, publicKey: publicFormKey(form.publicKey),
      submitUrl: `${config.apiBaseUrl.replace(/\/$/, "")}/public/forms/${publicFormKey(form.publicKey)}/submissions`,
      enabled: form.active && row.status === "active", testMode: row.testMode, automationMode: row.automationMode || "inherit",
      allowedDomains: Array.isArray(form.allowedDomains) ? form.allowedDomains.map(String) : [], assigneeMembershipId: assignment?.membershipId || null,
      lastSubmission: last ? { ...last, receivedAt: last.receivedAt.toISOString() } : null };
  }));
  return { items, members: members.map(m => ({ id: m.id, name: m.user.name })), available: !unavailableReason, unavailableReason };
}

export async function createWebsiteForm(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  requireIntegrationsAccess(auth);
  const { tenantId } = requireTenant(auth), data = createSchema.parse(input);
  await requireAvailable(prisma, tenantId);
  const { requestId, ...settings } = data;
  const requestHash = createHash("sha256").update(JSON.stringify(settings)).digest("hex");
  return prisma.$transaction(async tx => {
    // A retried click/request must return the same form, including concurrent first-time setup.
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    const key = { scope: "website_form.create", actorKey: tenantId, key: requestId };
    const previous = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: key } });
    if (previous) {
      if (previous.requestHash !== requestHash) throw new ApiError(409, "conflict", "Запрос уже сохранён с другими настройками. Обновите страницу.");
      return previous.resultJson as { id: string };
    }
    await validateAssignee(tx, tenantId, data.assigneeMembershipId);
    if (await tx.formDefinition.count({ where: { tenantId } }) >= 20) throw new ApiError(422, "form_limit", "Можно подключить до 20 форм. Используйте или измените существующую.");
    const publicKey = `frm_${randomUUID().replaceAll("-", "")}`;
    const integration = await tx.integration.create({ data: { tenantId, type: "form", name: data.name, status: "active", publicKey,
      testMode: false, automationMode: "MANUAL", connectionStatus: "CONNECTED", healthStatus: "NO_EVENTS_YET",
      assignmentJson: data.assigneeMembershipId ? { kind: "member", membershipId: data.assigneeMembershipId } : { kind: "owner" },
      mappingJson: { version: 1, fields: { name: "name", phone: "phone", email: "email", message: "message", service: "service", company: "company" } },
    } });
    const form = await tx.formDefinition.create({ data: { tenantId, integrationId: integration.id, publicKey, name: data.name,
      allowedDomains: data.allowedDomains, antispamJson: { honeypot: "website" },
      fieldsJson: { fields: [{ key: "name", label: "Имя", required: true }, { key: "phone", label: "Телефон", required: true }, { key: "message", label: "Ваш вопрос", required: false }] },
    } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.website_form_created", entityType: "integration", entityId: integration.id,
      changes: { formId: form.id, name: data.name, allowedDomains: data.allowedDomains, assigneeMembershipId: data.assigneeMembershipId, automationMode: "MANUAL" } });
    const result = { id: form.id };
    await tx.idempotencyRecord.create({ data: { ...key, requestHash, resultJson: result, expiresAt: new Date(Date.now() + 7 * 86400000) } });
    return result;
  });
}

export async function updateWebsiteForm(prisma: PrismaClient, auth: AuthContext, id: string, input: unknown) {
  requireIntegrationsAccess(auth);
  const { tenantId } = requireTenant(auth), data = updateSchema.parse(input);
  // Pausing intake remains available after a plan expires.
  if (data.enabled !== false || Object.keys(data).length > 1) await requireAvailable(prisma, tenantId);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    const form = await tx.formDefinition.findFirst({ where: { id, tenantId, integration: { type: "form" } } });
    if (!form) throw new ApiError(404, "not_found", "Форма не найдена");
    await validateAssignee(tx, tenantId, data.assigneeMembershipId);
    await tx.formDefinition.update({ where: { id }, data: { name: data.name, allowedDomains: data.allowedDomains, active: data.enabled } });
    await tx.integration.update({ where: { id: form.integrationId }, data: { name: data.name,
      ...(data.assigneeMembershipId !== undefined ? { assignmentJson: data.assigneeMembershipId ? { kind: "member", membershipId: data.assigneeMembershipId } : { kind: "owner" } } : {}),
      ...(data.enabled !== undefined ? { status: data.enabled ? "active" : "disabled", connectionStatus: data.enabled ? "CONNECTED" : "DISCONNECTED" } : {}),
    } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.website_form_updated", entityType: "integration", entityId: form.integrationId, changes: data });
    return { id };
  });
}
