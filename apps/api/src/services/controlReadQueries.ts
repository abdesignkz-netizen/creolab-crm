import { z } from "zod";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { dealAccessWhere, requireTenant, seesAllCompanyRecords, taskAccessWhere } from "../lib/access.ts";
import { phoneFromContact, displayName } from "./contactLabels.ts";
import { listInquiries } from "./inquiryService.ts";
import { resolvePeriodRange } from "./periodRange.ts";
import type { ControlPeriod } from "./controlPeriods.ts";
import { PROCESS_OPEN_TASK_STATUSES } from "./dealProcessPolicy.ts";

const filterSchema = z.object({
  scope: z.enum(["accessible", "mine", "team"]).optional().default("accessible"),
  ownerMembershipId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  query: z.string().trim().max(160).optional(),
  taskStatus: z.enum(["active", "completed", "all"]).optional().default("active"),
  leadFilter: z.enum(["all", "needs_reply"]).optional().default("all"),
});
export type ReadContext = { prisma: PrismaClient; auth: AuthContext; access: { canReadTeamData: boolean; canReadFinancialData: boolean }; params: Record<string, unknown>; period: ControlPeriod };

export async function controlReadFilters(ctx: ReadContext) {
  const checked = filterSchema.safeParse(ctx.params);
  if (!checked.success) throw new ApiError(422, "invalid_filter", "Проверьте фильтр и сотрудника в запросе.");
  const f = checked.data, membership = requireTenant(ctx.auth);
  if (f.scope === "mine" && f.ownerMembershipId && f.ownerMembershipId !== membership.id) throw new ApiError(422, "invalid_filter", "Уточните: ваши задачи или задачи выбранного сотрудника.");
  if ((f.scope === "team" || f.ownerMembershipId && f.ownerMembershipId !== membership.id) && (!ctx.access.canReadTeamData || !seesAllCompanyRecords(ctx.auth))) {
    throw new ApiError(403, "forbidden", "Нет права на данные всей команды. Можно запросить свои задачи.");
  }
  const ownerId = f.scope === "mine" ? membership.id : f.ownerMembershipId;
  const owner = ownerId ? await ctx.prisma.membership.findFirst({ where: { id: ownerId, tenantId: membership.tenantId, active: true }, select: { user: { select: { name: true } } } }) : null;
  if (ownerId && !owner) throw new ApiError(404, "not_found", "Сотрудник не найден в этой компании.");
  return { ...f, ownerId, ownerName: owner?.user.name || null };
}
const activeStatuses = PROCESS_OPEN_TASK_STATUSES;
const contactInclude = { include: { methods: true } } as const;

export async function controlTasks(ctx: ReadContext, action: "GET_TASKS" | "GET_TODAY_TASKS" | "GET_OVERDUE_TASKS") {
  const { prisma, auth, period } = ctx, f = await controlReadFilters(ctx);
  const clientConversations = f.clientId ? await prisma.conversation.findMany({
    where: { tenantId: requireTenant(auth).tenantId, contactId: f.clientId }, select: { id: true },
  }) : [];
  const base: Prisma.TaskWhereInput = { AND: [taskAccessWhere(auth), {
    parentTaskId: null,
    ...(f.ownerId ? { ownerMembershipId: f.ownerId } : {}),
    ...(f.clientId ? { OR: [{ contactId: f.clientId }, { inquiry: { contactId: f.clientId } }, { deal: { contactId: f.clientId } },
      { conversationId: { in: clientConversations.map(row => row.id) } }] } : {}),
    ...(f.query ? { title: { contains: f.query, mode: "insensitive" } } : {}),
  }] };
  const today = resolvePeriodRange(period.timeZone, "today", undefined, undefined, period.now);
  const range = action === "GET_TODAY_TASKS" ? today : period;
  const completedOnly = action === "GET_TASKS" && f.taskStatus === "completed";
  const where: Prisma.TaskWhereInput = { AND: [base, {
    ...(action !== "GET_TASKS" || f.taskStatus === "active" ? { status: { in: activeStatuses } } : f.taskStatus === "completed" ? { status: "done" } : {}),
    ...(range.from ? { [completedOnly ? "completedAt" : "dueAt"]: { gte: range.from, lt: range.to! } } : {}),
  }, ...(action === "GET_OVERDUE_TASKS" ? [{ dueAt: { lt: period.now } }] : [])] };
  const [total, rows, overdue] = await prisma.$transaction([
    prisma.task.count({ where }),
    prisma.task.findMany({ where, take: 50, orderBy: completedOnly ? [{ completedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }] : [{ dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }], include: {
      contact: contactInclude, inquiry: { include: { contact: contactInclude } }, deal: { include: { contact: contactInclude } },
      owner: { select: { user: { select: { name: true } } } },
    } }),
    prisma.task.count({ where: { AND: [base, { status: { in: activeStatuses }, dueAt: { lt: period.now } }] } }),
  ]);
  const conversationIds = rows.map(r => r.conversationId).filter((id): id is string => Boolean(id));
  const conversations = conversationIds.length ? await prisma.conversation.findMany({ where: { tenantId: requireTenant(auth).tenantId, id: { in: conversationIds } }, include: { contact: contactInclude } }) : [];
  const items = rows.map(row => {
    const conversation = conversations.find(c => c.id === row.conversationId);
    const contact = row.contact || row.inquiry?.contact || row.deal?.contact || conversation?.contact;
    return { id: row.id, title: row.title, type: row.type, status: row.status, dueAt: row.dueAt, completedAt: row.completedAt,
      overdue: Boolean(activeStatuses.includes(row.status) && row.dueAt && row.dueAt < period.now),
      contactName: contact ? displayName(contact) : null, phone: phoneFromContact(contact, row.inquiry) || phoneFromContact(null, conversation), ownerName: row.owner?.user.name || null };
  });
  return { items, total, hasMore: items.length < total, scope: f.scope, ownerName: f.ownerName, taskStatus: f.taskStatus,
    ...(action === "GET_TODAY_TASKS" ? { remaining: total, overdue, nearest: items } : {}) };
}

export async function controlRecentLeads(ctx: ReadContext) {
  const f = await controlReadFilters(ctx), p = ctx.period;
  const result = await listInquiries(ctx.prisma, ctx.auth, { period: p.period, dateFrom: p.dateFrom, dateTo: p.dateTo,
    filter: f.leadFilter, assignee: f.ownerId, q: f.query, sort: "newest", limit: "30" });
  return { items: result.items.map(r => ({ id: r.id, name: r.contactName, subject: r.subject || r.service,
    phone: r.phone, status: r.status, receivedAt: r.receivedAt })), total: result.total, hasMore: result.hasMore,
    scope: f.scope, ownerName: f.ownerName, leadFilter: f.leadFilter };
}

export async function controlRecentDeals(ctx: ReadContext) {
  const f = await controlReadFilters(ctx), p = ctx.period;
  const where: Prisma.DealWhereInput = { AND: [dealAccessWhere(ctx.auth), {
    ...(f.ownerId ? { assigneeMembershipId: f.ownerId } : {}), ...(f.query ? { title: { contains: f.query, mode: "insensitive" } } : {}),
    ...(p.from ? { createdAt: { gte: p.from, lt: p.to! } } : {}),
  }] };
  const [total, rows] = await ctx.prisma.$transaction([ctx.prisma.deal.count({ where }), ctx.prisma.deal.findMany({ where, take: 30,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], include: { stage: true, contact: contactInclude, assignee: { select: { user: { select: { name: true } } } } } })]);
  return { items: rows.map(row => ({ id: row.id, title: row.title, outcome: row.outcome, stage: row.stage.name,
    contactName: row.contact ? displayName(row.contact) : null, phone: row.contact ? phoneFromContact(row.contact) : null,
    assigneeName: row.assignee?.user.name || null, createdAt: row.createdAt,
    ...(ctx.access.canReadFinancialData ? { amountMinor: row.offerAmountMinor == null ? null : Number(row.offerAmountMinor), paymentStatus: row.paymentStatus } : {}),
  })), total, hasMore: rows.length < total, scope: f.scope, ownerName: f.ownerName };
}
