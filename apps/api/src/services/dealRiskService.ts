import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@creolab/db";
import { taskCreatorSnapshot } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { conversationAccessWhere, dealAccessWhere, isManager, requireManageTasks, requireTenant, taskAccessWhere } from "../lib/access.ts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { writeActivity } from "./contactService.ts";
import { parseOpsSettings } from "./dealPipeline.ts";
import { tenantSalesSettings } from "./salesProcessService.ts";
import { deliveredConversationMessage } from "./conversationMessageState.ts";
import { assessDealRisk, type DealRiskInput } from "./dealRiskPolicy.ts";
import { businessDealWhere } from "./financialMetrics.ts";
import { parseDateTimeInput } from "./periodRange.ts";

type Db = PrismaClient | Prisma.TransactionClient;
const owner = { include: { user: { select: { name: true, status: true } } } } as const;
export const dealRiskInclude = (now: Date) => ({
  stage: true, assignee: owner, contact: { include: { methods: true } },
  tasks: { where: { OR: [{ status: { in: ["open", "in_progress", "waiting"] } }, { source: "control", status: { in: ["done", "canceled"] } }] },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }], include: { owner } },
  invoices: { where: { status: { in: ["ISSUED", "SENT", "PAID", "PARTIALLY_PAID", "OVERDUE"] } }, orderBy: [{ dueDate: "asc" }, { id: "asc" }] },
  conversations: { orderBy: { conversationId: "asc" }, include: { conversation: { select: {
    id: true, status: true, waitingFor: true, mode: true, needsAttention: true, attentionReason: true,
    messages: { where: { internal: false, direction: "inbound", senderKind: "client", createdAt: { lte: now } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true, direction: true, senderKind: true, createdAt: true } },
  } } } },
} as const satisfies Prisma.DealInclude);

/** At most one inbound + one accepted outbound per thread. No transcript scan. */
export async function riskReplyEvidence(db: Db, tenantId: string, deals: DealRiskInput[], now: Date) {
  const ids = [...new Set(deals.flatMap(d => d.conversations.map(c => c.conversation.id)))];
  const outbound = ids.length ? await db.message.groupBy({ by: ["conversationId"], where: { tenantId, conversationId: { in: ids }, direction: "outbound",
    ...deliveredConversationMessage, receiptState: { not: "failed" }, createdAt: { lte: now } }, _max: { createdAt: true } }) : [];
  const lastOut = new Map(outbound.map(row => [row.conversationId, row._max.createdAt]));
  return <T extends DealRiskInput>(deal: T): T => ({ ...deal, conversations: deal.conversations.map(row => {
    const at = lastOut.get(row.conversation.id);
    const messages = [...row.conversation.messages, ...(at ? [{ id: `outbound:${at.toISOString()}`, direction: "outbound", senderKind: "agent", createdAt: at }] : [])]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.direction === "outbound" ? -1 : 1));
    return { ...row, conversation: { ...row.conversation, messages } };
  }) });
}
export async function riskReadContext(db: Db, auth: AuthContext, deals: DealRiskInput[], now: Date, historyTaskIds: string[] = []) {
  const ids = [...new Set(deals.flatMap(d => d.conversations.map(c => c.conversation.id)))];
  const taskIds = [...new Set([...deals.flatMap(d => d.tasks.map(t => t.id)), ...historyTaskIds])];
  const [withMessages, tasks, threads] = await Promise.all([
    riskReplyEvidence(db, requireTenant(auth).tenantId, deals, now),
    taskIds.length ? db.task.findMany({ where: { AND: [taskAccessWhere(auth), { id: { in: taskIds } }] }, select: { id: true } }) : [],
    ids.length ? db.conversation.findMany({ where: { AND: [conversationAccessWhere(auth), { id: { in: ids } }] }, select: { id: true } }) : [],
  ]);
  return { withMessages, access: { taskIds: new Set(tasks.map(t => t.id)), conversationIds: new Set(threads.map(c => c.id)), canCreate: !isManager(auth) } };
}

const acceptSchema = z.object({
  confirmed: z.literal(true), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(3).max(500), dueAt: z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)]), ownerMembershipId: z.string().uuid(),
}).strict();

/** Explicit confirmation, fresh evidence and one task per accepted suggestion. */
export async function acceptDealRiskTask(prisma: PrismaClient, auth: AuthContext, dealId: string, input: unknown) {
  requireManageTasks(auth);
  const data = acceptSchema.parse(input), { tenantId } = requireTenant(auth);
  const requestHash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Deal" WHERE id = ${dealId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const now = new Date();
    const where = { AND: [dealAccessWhere(auth), await businessDealWhere(tx, tenantId), { id: dealId }] };
    const deal = await tx.deal.findFirst({ where, include: dealRiskInclude(now) });
    if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
    const key = { scope: "sales.risk_task", actorKey: tenantId, key: `${dealId}:${data.fingerprint}` };
    const previous = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: key } });
    if (previous) {
      if (previous.requestHash !== requestHash) throw new ApiError(409, "risk_changed", "Это предложение уже принято с другими параметрами. Обновите список сделок.");
      const id = (previous.resultJson as { id: string }).id;
      if (!await tx.task.findFirst({ where: { AND: [taskAccessWhere(auth), { id }] } })) throw new ApiError(409, "risk_changed", "Задача больше недоступна. Обновите список сделок.");
      return { id, reused: true };
    }
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const dueAt = parseDateTimeInput(data.dueAt, tenant.timezone);
    if (!Number.isFinite(dueAt.getTime()) || dueAt <= now || dueAt.getTime() > now.getTime() + 366 * 86400000) throw new ApiError(422, "invalid_deadline", "Укажите будущий срок в пределах года");
    if (data.dueAt.length === 16) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tenant.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(dueAt).map(p => [p.type, p.value]));
      if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` !== data.dueAt) throw new ApiError(422, "invalid_deadline", "Проверьте дату и время в часовом поясе компании");
    }
    const ctx = await riskReadContext(tx, auth, [deal], now);
    const risk = assessDealRisk(ctx.withMessages(deal), parseOpsSettings(tenant.settingsJson), tenant.timezone,
      tenantSalesSettings(tenant.settingsJson).nextStepHours, now, ctx.access);
    if (risk.fingerprint !== data.fingerprint || risk.recommendation?.kind !== "create_task" || !risk.recommendation.canCreate || deal.tasks.some(t => ["open", "in_progress", "waiting"].includes(t.status))) {
      throw new ApiError(409, "risk_changed", "Ситуация изменилась или задача уже есть. Обновите список и проверьте следующий шаг.");
    }
    const assignee = await tx.membership.findFirst({ where: { id: data.ownerMembershipId, tenantId, active: true, user: { status: "active" } } });
    if (!assignee) throw new ApiError(422, "invalid_assignee", "Выберите действующего сотрудника компании");
    const task = await tx.task.create({ data: {
      tenantId, dealId, contactId: deal.contactId, inquiryId: deal.inquiryId, companyId: deal.companyId,
      title: data.title, type: "follow_up", source: "control", targetType: "client", dueAt,
      ownerMembershipId: data.ownerMembershipId, priority: risk.priority === "urgent" ? "high" : "normal",
      contextSnapshotJson: taskCreatorSnapshot({ createdByKind: "user", createdByMembershipId: requireTenant(auth).id, executorType: "USER",
        existing: { salesRisk: { fingerprint: risk.fingerprint, reason: risk.recommendation.reason, checkedAt: risk.checkedAt } } }) as Prisma.InputJsonValue,
      dedupeKey: `sales-risk:${dealId}:${data.fingerprint}`,
    } });
    await writeActivity(tx, { tenantId, contactId: deal.contactId, inquiryId: deal.inquiryId, dealId, companyId: deal.companyId,
      type: "task.created", title: "Создан следующий шаг по результату проверки сделки", description: task.title,
      actorType: "user", actorId: auth.user.id, metadata: { taskId: task.id, source: "control", reason: risk.recommendation.reason,
        dueAt: dueAt.toISOString(), ownerMembershipId: data.ownerMembershipId, fingerprint: risk.fingerprint } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "task.created", entityType: "task", entityId: task.id,
      changes: { source: "control", dealId, title: task.title, reason: risk.recommendation.reason, dueAt: dueAt.toISOString(), ownerMembershipId: data.ownerMembershipId } });
    await tx.idempotencyRecord.create({ data: { ...key, requestHash, resultJson: { id: task.id }, expiresAt: new Date(now.getTime() + 30 * 86400000) } });
    return { id: task.id, reused: false };
  });
}
