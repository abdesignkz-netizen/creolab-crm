import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  conversationsAttentionWhere,
  conversationsHumanWhere,
  countContactsNew,
  countVisibleConversations,
  overdueTasksWhere,
} from "./attentionCounts.ts";
import { inquiryNeedsActionWhere, openIntakeWhere } from "./inquiryAttention.ts";

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function ruCount(n: number, one: string, few: string, many: string) {
  const n10 = n % 10;
  const n100 = n % 100;
  const word = n10 === 1 && n100 !== 11 ? one : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  return `${n} ${word}`;
}

function joinRu(parts: string[]) {
  if (parts.length <= 1) return parts[0] || "";
  if (parts.length === 2) return `${parts[0]} и ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}`;
}

export function badgeHint(total: number, parts: string[], empty = "") {
  if (total <= 0) return empty;
  if (!parts.length) return `${total} требуют внимания`;
  return `${ruCount(total, "пункт требует внимания", "пункта требуют внимания", "пунктов требуют внимания")}: ${joinRu(parts)}`;
}

/**
 * Lightweight attention counts for sidebar / mobile nav badges.
 * Keys are route paths used in App shell navigation.
 */
export async function getNavBadges(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const now = new Date();
  const inquiryAction = inquiryNeedsActionWhere(tid);

  const [
    conversationsAttention,
    conversationsHuman,
    tasksOverdue,
    contactsNew,
    inquiriesAttention,
    dealsAttention,
    companiesAttention,
    integrationsIssues,
    notificationsUnread,
    incompleteIntakes,
    documentsAttention,
  ] = await Promise.all([
    countVisibleConversations(prisma, conversationsAttentionWhere(tid)),
    countVisibleConversations(prisma, conversationsHumanWhere(tid)),
    prisma.task.count({
      where: overdueTasksWhere(tid, now),
    }),
    countContactsNew(prisma, tid),
    prisma.inquiry.count({ where: inquiryAction }),
    prisma.deal.count({
      where: {
        tenantId: tid,
        stage: { isTerminal: false },
        tasks: {
          some: {
            status: { in: ["open", "waiting"] },
            dueAt: { lt: now },
          },
        },
      },
    }),
    prisma.company.count({
      where: {
        tenantId: tid,
        archivedAt: null,
        OR: [
          {
            tasks: {
              some: {
                status: { in: ["open", "waiting"] },
                dueAt: { lt: now },
              },
            },
          },
          {
            inquiries: { some: inquiryAction },
          },
        ],
      },
    }),
    prisma.integration.count({
      where: {
        tenantId: tid,
        OR: [
          { healthStatus: { in: ["ERROR", "DEGRADED", "DOWN"] } },
          { connectionStatus: { in: ["error", "disconnected", "expired"] } },
        ],
      },
    }),
    prisma.notification.count({
      where: {
        tenantId: tid,
        recipientMembershipId: membership.id,
        readAt: null,
        resolvedAt: null,
      },
    }),
    prisma.incompleteIntake.count({ where: openIntakeWhere(tid) }),
    import("./documentInboxService.ts").then(({ countDocumentAttention }) => countDocumentAttention(prisma, tid)),
  ]);

  const conversations = conversationsAttention;
  const tasks = tasksOverdue;
  const inquiries = inquiriesAttention + incompleteIntakes;
  const control = conversationsHuman;
  const situation = conversationsAttention + tasksOverdue + inquiriesAttention + incompleteIntakes;

  const situationParts = [
    conversationsAttention
      ? ruCount(conversationsAttention, "диалог без ответа", "диалога без ответа", "диалогов без ответа")
      : "",
    tasksOverdue
      ? ruCount(tasksOverdue, "просроченная задача", "просроченные задачи", "просроченных задач")
      : "",
    inquiriesAttention
      ? ruCount(inquiriesAttention, "новая или ждущая заявка", "новые или ждущие заявки", "новых или ждущих заявок")
      : "",
    incompleteIntakes
      ? ruCount(incompleteIntakes, "обращение без телефона", "обращения без телефона", "обращений без телефона")
      : "",
  ].filter(Boolean);

  const hints: Record<string, string> = {
    "/today": badgeHint(situation, situationParts),
    "/conversations": conversations
      ? ruCount(conversations, "диалог требует внимания", "диалога требуют внимания", "диалогов требуют внимания")
      : "",
    "/tasks": tasks ? ruCount(tasks, "просроченная задача", "просроченные задачи", "просроченных задач") : "",
    "/contacts": contactsNew
      ? ruCount(contactsNew, "новый клиент", "новых клиента", "новых клиентов")
      : "",
    "/companies": companiesAttention
      ? `${ruCount(companiesAttention, "компания", "компании", "компаний")} с просроченной задачей или новой заявкой`
      : "",
    "/inquiries": inquiries
      ? `${ruCount(inquiries, "заявка требует внимания", "заявки требуют внимания", "заявок требуют внимания")}: новые, без ответа или без телефона. Не за сегодня — все открытые.`
      : "",
    "/deals": dealsAttention
      ? `${ruCount(dealsAttention, "сделка", "сделки", "сделок")} с просроченной задачей`
      : "",
    "/control": control ? `${ruCount(control, "диалог", "диалога", "диалогов")} у менеджера, не у AI` : "",
    "/integrations": integrationsIssues
      ? `${ruCount(integrationsIssues, "интеграция", "интеграции", "интеграций")} с ошибкой`
      : "",
    "/settings": notificationsUnread
      ? ruCount(notificationsUnread, "непрочитанное уведомление", "непрочитанных уведомления", "непрочитанных уведомлений")
      : "",
    "/documents": documentsAttention
      ? ruCount(documentsAttention, "документ требует внимания", "документа требуют внимания", "документов требуют внимания")
      : "",
  };

  return {
    asOf: now.toISOString(),
    badges: {
      "/today": situation,
      "/conversations": conversations,
      "/tasks": tasks,
      "/contacts": contactsNew,
      "/companies": companiesAttention,
      "/inquiries": inquiries,
      "/deals": dealsAttention,
      "/control": control,
      "/integrations": integrationsIssues,
      "/stats": 0,
      "/settings": notificationsUnread,
      "/documents": documentsAttention,
    } as Record<string, number>,
    hints,
    hrefs: {
      "/today": "/today",
      "/conversations": conversations ? "/conversations?filter=attention" : "/conversations",
      "/tasks": tasks ? "/tasks?filter=overdue" : "/tasks",
      "/contacts": contactsNew ? "/contacts?filter=new" : "/contacts",
      "/companies": "/companies",
      "/inquiries": inquiries ? "/inquiries?filter=attention" : "/inquiries",
      "/deals": dealsAttention ? "/deals" : "/deals",
      "/control": control ? "/control" : "/control",
      "/integrations": "/integrations",
      "/stats": "/stats",
      "/settings": "/settings",
      "/documents": documentsAttention ? "/documents?attention=1" : "/documents",
    } as Record<string, string>,
    parts: {
      "/today": situationParts,
    },
  };
}
