import { systemText } from "@creolab/contracts";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  conversationsAttentionWhere,
  conversationsHumanWhere,
  countContactsNew,
  countVisibleConversations,
} from "./attentionCounts.ts";
import { inquiryNeedsActionWhere, openIntakeWhere } from "./inquiryAttention.ts";
import { isManager, inquiryAccessWhere, conversationAccessWhere, dealAccessWhere } from "../lib/access.ts";

function requireTenant(auth: AuthContext) {
  const locale = auth.user.locale || "ru";
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", systemText(locale, "Нет активной компании"));
  return auth.activeMembership;
}

function ruCount(n: number, one: string, few: string, many: string) {
  const n10 = n % 10;
  const n100 = n % 100;
  const word = n10 === 1 && n100 !== 11 ? one : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  return `${n} ${word}`;
}

function joinRu(parts: string[], locale = "ru") {
  if (parts.length <= 1) return parts[0] || "";
  if (parts.length === 2) return systemText(locale, "{p0} и {p1}", { p0: parts[0], p1: parts[1] });
  return systemText(locale, "{p0} и {p1}", { p0: parts.slice(0, -1).join(", "), p1: parts[parts.length - 1] });
}

export function badgeHint(total: number, parts: string[], empty = "", locale = "ru") {
  if (total <= 0) return empty;
  if (!parts.length) return systemText(locale, "{p0} требуют внимания", { p0: total });
  return `${ruCount(total, systemText(locale, "пункт требует внимания"), systemText(locale, "пункта требуют внимания"), systemText(locale, "пунктов требуют внимания"))}: ${joinRu(parts, locale)}`;
}

/**
 * Lightweight attention counts for sidebar / mobile nav badges.
 * Keys are route paths used in App shell navigation.
 */
export async function getNavBadges(prisma: PrismaClient, auth: AuthContext) {
  const locale = auth.user.locale || "ru";
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
    countVisibleConversations(prisma, { AND: [conversationsAttentionWhere(tid), conversationAccessWhere(auth)] }),
    countVisibleConversations(prisma, { AND: [conversationsHumanWhere(tid), conversationAccessWhere(auth)] }),
    prisma.task.count({
      where: {
        tenantId: tid,
        parentTaskId: null,
        ownerMembershipId: membership.id,
        status: { in: ["open", "in_progress", "waiting"] },
        dueAt: { lt: now },
      },
    }),
    countContactsNew(prisma, tid),
    prisma.inquiry.count({ where: { AND: [inquiryAction, inquiryAccessWhere(auth)] } }),
    prisma.deal.count({
      where: {
        AND: [
          dealAccessWhere(auth),
          {
            stage: { isTerminal: false },
            tasks: {
              some: {
                status: { in: ["open", "waiting"] },
                dueAt: { lt: now },
              },
            },
          },
        ],
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
  const manager = isManager(auth);
  const control = manager ? 0 : conversationsHuman;
  const documentsCount = manager ? 0 : documentsAttention;
  const integrationsCount = manager ? 0 : integrationsIssues;
  const situation = conversationsAttention + tasksOverdue + inquiriesAttention + incompleteIntakes;

  const situationParts = [
    conversationsAttention
      ? ruCount(conversationsAttention, systemText(locale, "диалог без ответа"), systemText(locale, "диалога без ответа"), systemText(locale, "диалогов без ответа"))
      : "",
    tasksOverdue
      ? ruCount(tasksOverdue, systemText(locale, "просроченная задача"), systemText(locale, "просроченные задачи"), systemText(locale, "просроченных задач"))
      : "",
    inquiriesAttention
      ? ruCount(inquiriesAttention, systemText(locale, "новая или ждущая заявка"), systemText(locale, "новые или ждущие заявки"), systemText(locale, "новых или ждущих заявок"))
      : "",
    incompleteIntakes
      ? ruCount(incompleteIntakes, systemText(locale, "обращение без телефона"), systemText(locale, "обращения без телефона"), systemText(locale, "обращений без телефона"))
      : "",
  ].filter(Boolean);

  const hints: Record<string, string> = {
    "/today": badgeHint(situation, situationParts, "", locale),
    "/conversations": conversations
      ? ruCount(conversations, systemText(locale, "диалог требует внимания"), systemText(locale, "диалога требуют внимания"), systemText(locale, "диалогов требуют внимания"))
      : "",
    "/tasks": tasks ? ruCount(tasks, systemText(locale, "просроченная задача"), systemText(locale, "просроченные задачи"), systemText(locale, "просроченных задач")) : "",
    "/contacts": contactsNew
      ? ruCount(contactsNew, systemText(locale, "новый клиент"), systemText(locale, "новых клиента"), systemText(locale, "новых клиентов"))
      : "",
    "/companies": companiesAttention
      ? systemText(locale, "{p0} с просроченной задачей или новой заявкой", { p0: ruCount(companiesAttention, systemText(locale, "компания"), systemText(locale, "компании"), systemText(locale, "компаний")) })
      : "",
    "/inquiries": inquiries
      ? systemText(locale, "{p0}: новые, без ответа или без телефона. Не за сегодня — все открытые.", { p0: ruCount(inquiries, systemText(locale, "заявка требует внимания"), systemText(locale, "заявки требуют внимания"), systemText(locale, "заявок требуют внимания")) })
      : "",
    "/deals": dealsAttention
      ? systemText(locale, "{p0} с просроченной задачей", { p0: ruCount(dealsAttention, systemText(locale, "сделка"), systemText(locale, "сделки"), systemText(locale, "сделок")) })
      : "",
    "/control": control ? systemText(locale, "{p0} у менеджера, не у AI", { p0: ruCount(control, systemText(locale, "диалог"), systemText(locale, "диалога"), systemText(locale, "диалогов")) }) : "",
    "/integrations": integrationsCount
      ? systemText(locale, "{p0} с ошибкой", { p0: ruCount(integrationsCount, systemText(locale, "интеграция"), systemText(locale, "интеграции"), systemText(locale, "интеграций")) })
      : "",
    "/settings": notificationsUnread
      ? ruCount(notificationsUnread, systemText(locale, "непрочитанное уведомление"), systemText(locale, "непрочитанных уведомления"), systemText(locale, "непрочитанных уведомлений"))
      : "",
    "/documents": documentsCount
      ? ruCount(documentsCount, systemText(locale, "документ требует внимания"), systemText(locale, "документа требуют внимания"), systemText(locale, "документов требуют внимания"))
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
      "/integrations": integrationsCount,
      "/stats": 0,
      "/settings": notificationsUnread,
      "/documents": documentsCount,
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
