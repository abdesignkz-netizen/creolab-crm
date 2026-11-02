import { Prisma } from "@creolab/db";
import type { InsightContent } from "@creolab/contracts";
import type { DomainDb } from "../lib/transaction.ts";
import { evidenceHash, metricKey, type InsightEvidence, type InsightKey } from "./businessMetricRegistry.ts";
import { nextStepForDeal, PROCESS_OPEN_TASK_STATUSES } from "./dealProcessPolicy.ts";
import { LEGACY_STAGE_MAP } from "./dealPipeline.ts";
import { phoneFromContact } from "./contactLabels.ts";

export const OPPORTUNITY_REGISTRY = {
  opportunity_deal: { entityKind: "deal", formulaVersion: "commercial_deal_v1", title: "Возможность по сделке", formula: "Подтверждённые основания сделки объединены.", action: "Открыть сделку" },
  opportunity_inquiry: { entityKind: "inquiry", formulaVersion: "commercial_inquiry_v1", title: "Возможность по обращению", formula: "Новая заявка без первого контакта.", action: "Открыть заявку" },
} as const;
const brief = (value: string | null | undefined, fallback: string) => value?.trim().slice(0, 240) || fallback;
const contactSelect = { id: true, name: true, archivedAt: true, version: true,
  methods: { where: { type: { in: ["phone", "whatsapp"] } }, orderBy: [{ primary: "desc" }, { id: "asc" }], take: 3 } } satisfies Prisma.ContactSelect;
const taskSelect = { id: true, title: true, status: true, dueAt: true, ownerMembershipId: true } as const;
type ProposalProof = { dealId: string; agreementId: string; messageId: string; conversationId: string; requestedAt: Date; sent: boolean };

/** One canonical opportunity per deal, including its unhandled inquiry. No
 * contact-wide inference: two purchases by one customer remain separate. */
export async function loadOpportunityEvidence(db: DomainDb, tenantId: string, keys: InsightKey[], timezone: string, now: Date) {
  const dealIds = keys.filter(k => k.rule === "opportunity_deal").map(k => k.entityId);
  const inquiryIds = keys.filter(k => k.rule === "opportunity_inquiry").map(k => k.entityId);
  const [deals, inquiries, links, proofs] = await Promise.all([
    dealIds.length ? db.deal.findMany({ where: { tenantId, id: { in: dealIds } }, select: {
      id: true, title: true, contactId: true, outcome: true, inquiryId: true, nextAction: true, nextActionAt: true,
      stageEnteredAt: true, assigneeMembershipId: true, version: true, stage: { select: { systemKey: true, name: true, isTerminal: true, isArchived: true } },
      contact: { select: contactSelect }, tasks: { where: { status: { in: PROCESS_OPEN_TASK_STATUSES } },
        orderBy: [{ dueAt: { sort: "desc", nulls: "last" } }, { id: "asc" }], take: 1, select: taskSelect },
    } }) : [],
    inquiryIds.length ? db.inquiry.findMany({ where: { tenantId, id: { in: inquiryIds } }, select: {
      id: true, subject: true, status: true, firstContactAt: true, closedAt: true, test: true, archived: true, version: true,
      receivedAt: true, contactId: true, dealId: true, assigneeMembershipId: true, contact: { select: contactSelect },
      tasks: { where: { status: { in: PROCESS_OPEN_TASK_STATUSES } }, orderBy: { id: "asc" }, take: 1, select: taskSelect },
    } }) : [],
    dealIds.length || inquiryIds.length ? db.$queryRaw<Array<{ dealId: string; inquiryId: string; contactId: string; subject: string | null; status: string; firstContactAt: Date | null; closedAt: Date | null; test: boolean; archived: boolean }>>(Prisma.sql`
      SELECT d.id AS "dealId", i.id AS "inquiryId", i."contactId", i.subject, i.status, i."firstContactAt", i."closedAt", i.test, i.archived
      FROM "Deal" d JOIN "Inquiry" i ON i."tenantId" = d."tenantId" AND (i."dealId" = d.id OR d."inquiryId" = i.id)
      WHERE d."tenantId" = ${tenantId} AND (d.id IN (${Prisma.join(dealIds.length ? dealIds : [""])}) OR i.id IN (${Prisma.join(inquiryIds.length ? inquiryIds : [""])}))`) : [],
    // A request must be a confirmed, high-confidence agreement with an actual
    // inbound source in a conversation explicitly linked to this deal. A deal
    // stage or a generated summary alone is never evidence of a client's request.
    dealIds.length ? db.$queryRaw<ProposalProof[]>(Prisma.sql`
      SELECT d.id AS "dealId", p.*, (
        EXISTS (SELECT 1 FROM "Activity" a JOIN "Message" m ON m.id = a."metadataJson"->>'sourceMessageId' AND m."tenantId" = a."tenantId"
          WHERE a."tenantId" = d."tenantId" AND a."dealId" = d.id AND a.type = 'sales.proposal_sent'
            AND m."conversationId" = p."conversationId" AND m.direction = 'outbound' AND NOT m.internal
            AND m."operationState" NOT IN ('queued','sending','failed','partial','canceled','unknown') AND m."receiptState" <> 'failed'
            AND m."createdAt" >= p."requestedAt" AND m."createdAt" <= ${now})
        OR EXISTS (SELECT 1 FROM "Task" t JOIN "IdempotencyRecord" r ON r.scope = 'task.delivery' AND r."actorKey" = t."tenantId" AND r.key = t.id
          WHERE t."tenantId" = d."tenantId" AND t."dealId" = d.id AND t.type = 'proposal' AND t.status = 'done'
            AND t."executionStatus" = 'sent' AND t."sentAt" >= p."requestedAt" AND t."sentAt" <= ${now}
            AND jsonb_typeof(r."resultJson"->'parts') = 'array' AND r."resultJson"->'parts' <> '[]'::jsonb
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r."resultJson"->'parts') = 'array' THEN r."resultJson"->'parts' ELSE '[]'::jsonb END) part WHERE (part->>'state') IS DISTINCT FROM 'accepted'))
      ) AS sent
      FROM "Deal" d JOIN LATERAL (
        SELECT a.id AS "agreementId", m.id AS "messageId", m."conversationId", m."createdAt" AS "requestedAt"
        FROM "Agreement" a JOIN "Message" m ON m."tenantId" = a."tenantId" AND m."conversationId" = a."conversationId"
          AND a."sourceMessageIdsJson" @> jsonb_build_array(m.id)
        JOIN "Conversation" c ON c.id = m."conversationId" AND c."tenantId" = d."tenantId" AND c."contactId" = d."contactId"
        JOIN "DealConversation" dc ON dc."tenantId" = d."tenantId" AND dc."dealId" = d.id AND dc."conversationId" = c.id
        WHERE a."tenantId" = d."tenantId" AND a."dealId" = d.id AND a."contactId" = d."contactId"
          AND a.type = 'SEND_PROPOSAL' AND a.confidence = 'HIGH' AND a.status IN ('CONFIRMED','SCHEDULED','RESCHEDULED')
          AND a."cancelledAt" IS NULL AND a."completedAt" IS NULL
          AND m.direction = 'inbound' AND m."senderKind" = 'client' AND NOT m.internal AND m."createdAt" <= ${now}
        ORDER BY m."createdAt" DESC, a.id ASC LIMIT 1
      ) p ON true WHERE d."tenantId" = ${tenantId} AND d.id IN (${Prisma.join(dealIds)})`) : [],
  ]);
  // Inquiry tasks may predate deal creation. Use that exact link, never the
  // customer's most recent task from another purchase.
  const linkedIds = links.filter(l => dealIds.includes(l.dealId)).map(l => l.inquiryId);
  const inquiryTasks = linkedIds.length ? await db.inquiry.findMany({ where: { tenantId, id: { in: linkedIds } }, select: { id: true,
    tasks: { where: { dealId: null, status: { in: PROCESS_OPEN_TASK_STATUSES } }, orderBy: [{ dueAt: { sort: "desc", nulls: "last" } }, { id: "asc" }], take: 1, select: taskSelect } } }) : [];
  const evidence = new Map<string, InsightEvidence>();
  for (const key of keys) {
    if (key.rule !== "opportunity_deal" && key.rule !== "opportunity_inquiry") continue;
    const spec = OPPORTUNITY_REGISTRY[key.rule], row = key.rule === "opportunity_deal" ? deals.find(d => d.id === key.entityId) : inquiries.find(i => i.id === key.entityId);
    if (!row) continue;
    const href = `/${key.entityKind === "deal" ? "deals" : "requests"}/${key.entityId}`;
    const reasons: NonNullable<InsightContent["opportunity"]>["reasons"] = [];
    const content: InsightContent = { title: "Проверить возможность", subject: "", severity: "attention", explanation: "",
      formula: "", limitation: "Возможность основана на записях BasQar. Действия вне системы могли быть выполнены. Создание задачи не подтверждает продажу; денежный потенциал не рассчитывается.",
      facts: [], sources: [{ label: spec.action, href }], next: { label: spec.action, href }, period: { from: null, to: now.toISOString(), timezone, currency: null } };
    let available = !row.contact.archivedAt, existingTask = row.tasks[0] || null, basis: unknown;
    if (key.rule === "opportunity_deal") {
      const deal = deals.find(d => d.id === key.entityId)!;
      const related = links.filter(l => l.dealId === deal.id);
      available = available && !related.some(l => l.test || l.archived) && !deal.stage.isArchived;
      const proof = proofs.find(p => p.dealId === deal.id) || null;
      const inherited = inquiryTasks.filter(i => related.some(l => l.inquiryId === i.id)).flatMap(i => i.tasks);
      existingTask ||= inherited[0] || null;
      const noStep = nextStepForDeal({ ...deal, tasks: [...deal.tasks, ...inherited] }).issue !== null;
      const stageKey = LEGACY_STAGE_MAP[deal.stage.systemKey] || deal.stage.systemKey;
      if (deal.outcome === "open" && !deal.stage.isTerminal) {
        if (proof && !proof.sent) reasons.push("proposal_requested");
        if (["proposal_sent", "negotiation", "contract", "invoiced"].includes(stageKey) && noStep) reasons.push("late_no_step");
        if (related.some(i => i.contactId === deal.contactId && i.status === "new" && !i.firstContactAt && !i.closedAt)) reasons.push("unhandled_inquiry");
      }
      content.subject = `${brief(deal.title, "Сделка")} · ${brief(deal.contact.name, "Клиент")}`;
      content.period.from = deal.stageEnteredAt.toISOString();
      content.facts.push({ label: "Этап сделки", value: deal.stage.name });
      if (reasons.includes("proposal_requested") && proof) {
        content.facts.push({ label: "Запрос предложения в связанном диалоге", value: proof.requestedAt.toISOString() });
        content.sources.push({ label: "Диалог с запросом предложения", href: `/conversations/${proof.conversationId}` });
      }
      basis = { deal, related, proof, inherited };
    } else {
      const inquiry = inquiries.find(i => i.id === key.entityId)!;
      available = available && !inquiry.test && !inquiry.archived;
      if (!inquiry.dealId && !links.some(l => l.inquiryId === inquiry.id) && inquiry.status === "new" && !inquiry.firstContactAt && !inquiry.closedAt) reasons.push("unhandled_inquiry");
      content.subject = `${brief(inquiry.subject, "Заявка")} · ${brief(inquiry.contact.name, "Клиент")}`;
      content.period.from = inquiry.receivedAt.toISOString();
      content.facts.push({ label: "Заявка поступила", value: inquiry.receivedAt.toISOString() });
      basis = { inquiry, linked: links.filter(l => l.inquiryId === inquiry.id) };
    }
    const phone = phoneFromContact(row.contact);
    if (phone) content.facts.push({ label: "Телефон клиента", value: phone });
    const labels = { proposal_requested: "Проверить и подготовить запрошенное предложение", late_no_step: "Согласовать следующий шаг по сделке", unhandled_inquiry: "Разобрать обращение клиента" };
    content.title = reasons.length ? labels[reasons[0]] : "Возможность больше не требует действия";
    content.explanation = reasons.map(r => r === "proposal_requested" ? "Есть подтверждённая договорённость отправить предложение. После запроса отправка в BasQar не зарегистрирована."
      : r === "late_no_step" ? "Сделка дошла до предложения или согласования, но следующий шаг со сроком не указан." : "Первичная обработка обращения не зарегистрирована.").join(" ");
    content.formula = "Запрос предложения: подтверждённая договорённость с высокой уверенностью и входящим сообщением в связанном диалоге, без подтверждённой отправки после него. Поздняя стадия: предложение, переговоры, договор или счёт, без шага со сроком. Обращение: новая нетестовая заявка без первого контакта. Причины одной сделки объединены.";
    content.opportunity = { reasons, existingTask: existingTask ? { id: existingTask.id, title: existingTask.title } : null, taskTitle: `${content.title}: ${content.subject}`.slice(0, 240) };
    evidence.set(metricKey(key), { ...key, available, active: reasons.length > 0, content, formulaVersion: spec.formulaVersion,
      fingerprint: evidenceHash({ rule: key.rule, formulaVersion: spec.formulaVersion, timezone, reasons, available, basis }) });
  }
  return evidence;
}
