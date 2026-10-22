import { createHash } from "node:crypto";
import type { Prisma } from "@creolab/db";
import { aiIntakeExtractionSchema, aiIntakeSettingsSchema, intakeKindsForRoles, missingIntakeFields, readAiIntakeRecords, INTAKE_FIELDS, INTAKE_LABELS, taskCreatorSnapshot, type AiIntakeRecord } from "@creolab/contracts";
import { phoneFromContact } from "./contactLabels.ts";
import { writeActivity } from "./contactService.ts";
import { writeAudit } from "../lib/audit.ts";
import { createStaffNotification } from "./notificationService.ts";

const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** Only the active published snapshot may drive CRM writes. Unsaved and unpublished edits never do. */
export async function publishedIntakePolicy(tx: Prisma.TransactionClient, tenantId: string) {
  const config = await tx.aIConfiguration.findFirst({ where: { tenantId } });
  if (!config || config.promptStatus !== "published") return null;
  const setup = obj(obj(config.limitsJson).aiSetup);
  const version = Array.isArray(setup.versions) ? setup.versions.map(obj).find(v => v.id === setup.currentVersionId && v.prompt === config.systemPrompt) : undefined;
  if (!version || !setup.currentVersionId) return null;
  const draft = obj(version.draft);
  const roles = intakeKindsForRoles([draft.primaryRole, ...(Array.isArray(draft.additionalRoles) ? draft.additionalRoles : [])].filter((v): v is string => typeof v === "string"));
  const parsed = aiIntakeSettingsSchema.safeParse(draft.intake || {});
  if (!roles.length || !parsed.success || parsed.data.confirmation !== "staff") return null;
  return { roles, settings: parsed.data };
}

export async function applyAiIntake(tx: Prisma.TransactionClient, tenantId: string, input: {
  policy: Awaited<ReturnType<typeof publishedIntakePolicy>>;
  extraction: unknown; inquiryId?: string; conversationId: string; sourceMessageId: string;
  evidence: { id: string; direction: string; senderKind: string | null }[];
  createTasks: boolean; ownerMembershipId?: string | null;
}) {
  const parsed = aiIntakeExtractionSchema.safeParse(input.extraction);
  if (!parsed.success || !input.policy || !input.inquiryId) return null;
  const extraction = parsed.data;
  if (extraction.confidence !== "HIGH" || !input.policy.roles.includes(extraction.kind)) return null;
  const clientMessages = new Set(input.evidence.filter(m => m.direction === "inbound" && m.senderKind === "client").map(m => m.id));
  if (!extraction.evidenceMessageIds.includes(input.sourceMessageId) || !extraction.evidenceMessageIds.every(id => clientMessages.has(id))) return null;
  // Also serialize intake updates from linked conversations sharing this inquiry.
  await tx.$queryRaw`SELECT id FROM "Inquiry" WHERE id = ${input.inquiryId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const inquiry = await tx.inquiry.findFirst({ where: { tenantId, id: input.inquiryId, conversationId: input.conversationId, archived: false }, include: { contact: { include: { methods: true } } } });
  if (!inquiry || ["closed", "cancelled", "lost", "invalid", "spam", "duplicate"].includes(inquiry.status)) return null;
  const prior = readAiIntakeRecords(inquiry.normalizedJson).find(r => r.kind === extraction.kind);
  const fields = { ...prior?.fields, ...extraction.fields };
  // Fill an unknown contact, but respect explicit removal (null/empty) across later turns.
  // Never infer a phone from an opaque channel ID.
  if (fields.contact === undefined) fields.contact = phoneFromContact(inquiry.contact, inquiry) || undefined;
  const merged = { ...extraction, fields, items: extraction.items ?? prior?.items ?? [] };
  const missingFields = missingIntakeFields(merged, input.policy.settings);
  const unsupportedFulfillment = extraction.kind !== "booking" && fields.fulfillment && !input.policy.settings.fulfillment.includes(fields.fulfillment);
  if (unsupportedFulfillment && !missingFields.includes("fulfillment")) missingFields.push("fulfillment");
  const state = !missingFields.length || extraction.action !== "collect" ? "needs_review" : "collecting";
  const fingerprint = createHash("sha256").update(JSON.stringify([merged.action, Object.entries(fields).sort(), merged.items, missingFields])).digest("hex");
  if (prior?.fingerprint === fingerprint && (prior.taskId || !input.createTasks || state !== "needs_review")) return prior;
  const label = INTAKE_LABELS[extraction.kind][0];
  const actionLabel = extraction.action === "cancel" ? "Запрос на отмену" : extraction.action === "change" ? "Запрос на изменение" : label;
  const description = ["Предварительная заявка. Требуется проверка и подтверждение сотрудником.", actionLabel,
    ...Object.entries(fields).filter(([, v]) => v).map(([key, value]) => `${INTAKE_FIELDS[key as keyof typeof INTAKE_FIELDS][0]}: ${key === "fulfillment" ? value === "delivery" ? "Доставка" : "Самовывоз" : value}`),
    ...merged.items.map((item, i) => `${i + 1}. ${item.name} — ${item.quantity ?? "количество не указано"}${item.unit ? ` ${item.unit}` : ""}${item.variant ? ` · ${item.variant}` : ""}${item.notes ? ` · ${item.notes}` : ""}`),
    missingFields.length ? `Не хватает: ${missingFields.map(key => INTAKE_FIELDS[key][0]).join(", ")}` : "Данные собраны; наличие, стоимость и возможность исполнения ещё не подтверждены.",
  ].join("\n");
  let taskId = prior?.taskId || null;
  if ((state === "needs_review" || taskId) && input.createTasks) {
    const existing = taskId ? await tx.task.findFirst({ where: { tenantId, id: taskId, inquiryId: inquiry.id } }) : null;
    if (!existing) taskId = null;
    if (state === "needs_review" && (!existing || ["done", "canceled"].includes(existing.status))) {
      const ownerId = input.ownerMembershipId || inquiry.assigneeMembershipId || inquiry.contact.ownerMembershipId;
      const owner = ownerId ? await tx.membership.findFirst({ where: { tenantId, id: ownerId, active: true } }) : null;
      const task = await tx.task.create({ data: { tenantId, type: "other", title: `${actionLabel}: проверить и подтвердить`, description,
        contactId: inquiry.contactId, inquiryId: inquiry.id, conversationId: input.conversationId, dealId: inquiry.dealId,
        ownerMembershipId: owner?.id || null, source: "ai_intake", targetType: "client", status: "open",
        dedupeKey: `intake:${inquiry.id}:${extraction.kind}:${input.sourceMessageId}`,
        briefingText: description, sourceMessageIdsJson: json(extraction.evidenceMessageIds),
        contextSnapshotJson: json(taskCreatorSnapshot({ existing: { intakeKind: extraction.kind, intakeFingerprint: fingerprint, sourceMessageId: input.sourceMessageId, intakeDescription: description, intakeTitle: `${actionLabel}: проверить и подтвердить` }, createdByKind: "ai", executorType: "USER", createdByMembershipId: null })),
      } });
      taskId = task.id;
      await createStaffNotification(tx, { tenantId, membershipId: owner?.id || null, type: "intake.needs_review", entityType: "task", entityId: task.id,
        title: task.title, body: `${inquiry.contact.name || "Клиент"}. Проверьте заявку и свяжитесь с клиентом.`, priority: "high", episodeKey: `intake:${task.id}`, channels: ["in_app"] });
    }
    if (existing && !["done", "canceled"].includes(existing.status)) {
      const snapshot = obj(existing.contextSnapshotJson);
      // Refresh only AI-owned text; never overwrite staff edits, status, assignment or deadline.
      if (existing.source === "ai_intake" && existing.description === snapshot.intakeDescription && existing.briefingText === snapshot.intakeDescription) {
        const titleUntouched = existing.title === snapshot.intakeTitle;
        const title = titleUntouched ? `${actionLabel}: проверить и подтвердить` : existing.title;
        await tx.task.updateMany({ where: { tenantId, id: existing.id, status: existing.status, title: existing.title, description: existing.description, briefingText: existing.briefingText },
          data: { title, description, briefingText: description, sourceMessageIdsJson: json(extraction.evidenceMessageIds), contextSnapshotJson: json({ ...snapshot, intakeDescription: description, intakeTitle: titleUntouched ? title : snapshot.intakeTitle, intakeFingerprint: fingerprint }) } });
      }
      if (extraction.action !== "collect" && extraction.action !== prior?.action) await createStaffNotification(tx, { tenantId,
        membershipId: existing.ownerMembershipId, type: "intake.needs_review", entityType: "task", entityId: existing.id,
        title: actionLabel, body: `${inquiry.contact.name || "Клиент"}. Проверьте обновлённую заявку.`, priority: "high",
        episodeKey: `intake:${existing.id}:${input.sourceMessageId}`, channels: ["in_app"] });
    }
  }
  const record: AiIntakeRecord = { ...merged, state, missingFields, taskId, sourceMessageId: input.sourceMessageId, updatedAt: new Date().toISOString(), fingerprint };
  const normalized = obj(inquiry.normalizedJson);
  await tx.inquiry.update({ where: { tenantId, id: inquiry.id, version: inquiry.version }, data: { normalizedJson: json({ ...normalized, aiIntake: { ...obj(normalized.aiIntake), [record.kind]: record } }), version: { increment: 1 } } });
  await writeActivity(tx, { tenantId, contactId: inquiry.contactId, inquiryId: inquiry.id, dealId: inquiry.dealId,
    type: "ai.intake_updated", title: `${actionLabel} · ${state === "needs_review" ? "нужна проверка" : "сбор данных"}`, description,
    actorType: "ai", metadata: { before: prior || null, after: record, taskId, sourceMessageId: input.sourceMessageId } });
  await writeAudit(tx, { tenantId, action: "ai.intake_updated", entityType: "inquiry", entityId: inquiry.id, correlationId: input.sourceMessageId,
    changes: { kind: record.kind, state, taskId, evidenceMessageIds: record.evidenceMessageIds } });
  return record;
}
