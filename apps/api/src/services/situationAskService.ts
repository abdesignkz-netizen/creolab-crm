import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import type { PrismaClient } from "@creolab/db";
import { answerSituationAskWithLlm } from "./llmClient.ts";
import { getSituationOverview, type PeriodPreset } from "./situationOverviewService.ts";

const TASK_COMMAND_RE = /постав(ь|и)|создай задачу|позвон|напиш|отправ(ь|и)|уточн|follow-?up|кп\b|сообщени/i;
const LEADING_QUESTION_RE = /^(что|какие|какой|какая|где|у кого|сравни|сколько|почему|кто)\b/i;

export type SituationAskIntent =
  | "attention"
  | "deals"
  | "inquiries"
  | "tasks"
  | "team"
  | "funnel"
  | "period"
  | "clients"
  | "command"
  | "other";

export type SituationAskItem = { text: string; href?: string };
export type SituationAskLink = { label: string; href: string };

export type SituationAskResult = {
  question: string;
  intent: SituationAskIntent;
  command: boolean;
  usedLlm: boolean;
  period?: string;
  suggestedPeriod?: PeriodPreset | null;
  headline: string;
  bullets: SituationAskItem[];
  links: SituationAskLink[];
};

function safeHref(value?: string | null) {
  const href = String(value || "").trim();
  if (!href) return undefined;
  if (href.startsWith("#") && href.length < 80) return href;
  if (!href.startsWith("/")) return undefined;
  if (href.startsWith("//") || href.includes("://") || href.toLowerCase().startsWith("/\\")) return undefined;
  return href.slice(0, 240);
}

function itemLabel(item: {
  contactName?: string | null;
  title?: string | null;
  reason?: string | null;
  phone?: string | null;
}) {
  const who = [item.contactName, item.phone].filter(Boolean).join(" · ");
  const title = item.title && item.title !== item.contactName ? item.title : "";
  return [who || title || "Пункт", item.reason].filter(Boolean).join(" — ");
}

export function classifySituationQuestion(text: string): {
  intent: SituationAskIntent;
  command: boolean;
  suggestedPeriod: PeriodPreset | null;
} {
  const q = text.toLowerCase();
  const command = TASK_COMMAND_RE.test(text) && !LEADING_QUESTION_RE.test(q.trim());
  let suggestedPeriod: PeriodPreset | null = null;
  if (/прошл\w* недел|за недел|сравни.*недел/.test(q)) suggestedPeriod = "last_7";
  else if (/вчера/.test(q)) suggestedPeriod = "yesterday";
  else if (/прошл\w* месяц/.test(q)) suggestedPeriod = "last_month";
  else if (/(^| )за месяц|этот месяц/.test(q)) suggestedPeriod = "this_month";

  if (command) return { intent: "command", command: true, suggestedPeriod };
  if (/вниман|требует|приоритет|с чего начать/.test(q)) return { intent: "attention", command: false, suggestedPeriod };
  if (/завис|stall|без активн|сделк/.test(q) && /завис|stall|без активн|какие сдел|воронк/.test(q)) {
    return { intent: /воронк|этап|теря/.test(q) ? "funnel" : "deals", command: false, suggestedPeriod };
  }
  if (/воронк|этап|теряются клиент/.test(q)) return { intent: "funnel", command: false, suggestedPeriod };
  if (/заявк|обращен/.test(q)) return { intent: "inquiries", command: false, suggestedPeriod };
  if (/нагруз|менеджер|команд|у кого/.test(q)) return { intent: "team", command: false, suggestedPeriod };
  if (/просроч|задач на сегодня|какие задач/.test(q)) return { intent: "tasks", command: false, suggestedPeriod };
  if (/ждут ответа|не ответил|нужно ответить|клиент.*ждёт/.test(q)) return { intent: "clients", command: false, suggestedPeriod };
  if (/недел|сравни|изменил|динамика|результат/.test(q)) return { intent: "period", command: false, suggestedPeriod };
  return { intent: "other", command: false, suggestedPeriod };
}

function snapshotFromOverview(overview: Awaited<ReturnType<typeof getSituationOverview>>) {
  const attentionItems = (overview.attention?.items || []).slice(0, 8).map((item: any) => ({
    group: item.group || item.kind,
    title: item.title || null,
    contactName: item.contactName || null,
    phone: item.phone || null,
    reason: item.reason || null,
    href: item.href || null,
  }));
  return {
    period: overview.period,
    brief: overview.brief,
    attention: {
      ...overview.attention.summary,
      items: attentionItems,
    },
    result: {
      inquiries: overview.result.inquiries,
      newClients: overview.result.newClients,
      dealsCreated: overview.result.dealsCreated,
      wonDeals: overview.result.wonDeals,
      wonAmountLabel: overview.result.wonAmountLabel,
      lostDeals: overview.result.lostDeals,
      deltas: overview.result.deltas,
    },
    current: {
      activeDeals: overview.current.activeDeals,
      newInquiries: overview.current.newInquiries,
      inWorkInquiries: overview.current.inWorkInquiries,
      needsReply: overview.current.needsReply,
      overdueTasks: overview.current.overdueTasks,
      stalledDeals: overview.current.stalledDeals,
      waitingClient: overview.current.waitingClient,
      noNextAction: overview.current.noNextAction,
    },
    team: (overview.team || []).slice(0, 8).map((row: any) => ({
      name: row.name,
      newInquiries: row.newInquiries,
      inWork: row.inWork,
      attention: row.attention,
      overdueTasks: row.overdueTasks,
    })),
    funnel: {
      stages: (overview.pipeline?.stages || []).map((stage: any) => ({ name: stage.name, count: stage.count })),
      biggestDrop: overview.pipeline?.biggestDrop || null,
    },
    todayTasks: {
      overdue: overview.todayTasks.overdue,
      remaining: overview.todayTasks.remaining,
      nearest: (overview.todayTasks.nearest || []).slice(0, 6).map((task: any) => ({
        title: task.title,
        contactName: task.contactName,
        dueAt: task.dueAt,
        overdue: task.overdue,
        href: task.href,
      })),
    },
    importantDeals: (overview.importantDeals || []).slice(0, 5).map((deal: any) => ({
      title: deal.title,
      reason: deal.reason,
      href: deal.href,
    })),
    recentInquiries: (overview.recentInquiries || []).slice(0, 5).map((item: any) => ({
      title: item.title,
      contactName: item.contactName,
      status: item.status,
      href: item.href,
    })),
    insights: (overview.insights || []).map((item: any) => ({ text: item.text, href: item.href })),
  };
}

function fallbackAnswer(
  intent: SituationAskIntent,
  overview: Awaited<ReturnType<typeof getSituationOverview>>,
): { headline: string; bullets: SituationAskItem[]; links: SituationAskLink[] } {
  const s = overview.attention.summary;
  const c = overview.current;
  const r = overview.result;
  const items = (overview.attention.items || []) as Array<{
    group?: string;
    kind?: string;
    title?: string | null;
    contactName?: string | null;
    phone?: string | null;
    reason?: string | null;
    href?: string;
  }>;

  if (intent === "attention" || intent === "other") {
    const headline =
      s.needsReply || s.overdueTasks || s.needsHuman || c.newInquiries
        ? `Сейчас требуют внимания: ${s.needsReply} ждут ответа, ${s.needsHuman} диалогов без человека, ${s.overdueTasks} просроченных задач, ${c.newInquiries} новых заявок.`
        : "Критических действий сейчас нет — можно разобрать плановые задачи и сделки в работе.";
    const bullets = items.slice(0, 6).map((item) => ({ text: itemLabel(item), href: safeHref(item.href) }));
    return {
      headline,
      bullets: bullets.length ? bullets : (overview.insights || []).map((item: any) => ({ text: item.text, href: safeHref(item.href) })),
      links: [
        { label: "Требует внимания", href: "/today#attention" },
        { label: "Ждут ответа", href: "/contacts?filter=needs_reply" },
        { label: "Просроченные задачи", href: "/tasks?filter=overdue" },
      ],
    };
  }

  if (intent === "clients") {
    const reply = items.filter((item) => item.group === "needs_reply" || item.kind === "contact_needs_reply");
    return {
      headline: s.needsReply
        ? `${s.needsReply} клиент(ов) ждут ответа — это входящие без исходящего после них.`
        : "Клиентов, которые ждут ответа, сейчас нет.",
      bullets: (reply.length ? reply : items).slice(0, 6).map((item) => ({ text: itemLabel(item), href: safeHref(item.href) })),
      links: [{ label: "Клиенты · нужен ответ", href: "/contacts?filter=needs_reply" }],
    };
  }

  if (intent === "deals") {
    const deals = (overview.importantDeals || []) as Array<{ title?: string; reason?: string; href?: string }>;
    return {
      headline: c.stalledDeals
        ? `${c.stalledDeals} сделок зависли без активности. В работе ${c.activeDeals}.`
        : `Открытых сделок: ${c.activeDeals}. Зависших по активности нет.`,
      bullets: deals.slice(0, 6).map((deal) => ({
        text: [deal.title, deal.reason].filter(Boolean).join(" — "),
        href: safeHref(deal.href),
      })),
      links: [
        { label: "Зависшие сделки", href: "/deals?focus=stalled" },
        { label: "Все сделки", href: "/deals" },
      ],
    };
  }

  if (intent === "inquiries") {
    const recent = (overview.recentInquiries || []) as Array<{
      title?: string;
      contactName?: string;
      status?: string;
      href?: string;
    }>;
    return {
      headline: `${c.newInquiries} новых заявок ещё не взяты, ${c.inWorkInquiries} уже в работе. За период: ${r.inquiries} обращений.`,
      bullets: recent.slice(0, 6).map((item) => ({
        text: [item.contactName || item.title, item.status].filter(Boolean).join(" · "),
        href: safeHref(item.href),
      })),
      links: [
        { label: "Новые заявки", href: "/inquiries?filter=new&test=false" },
        { label: "Требуют внимания", href: "/inquiries?filter=attention" },
      ],
    };
  }

  if (intent === "tasks") {
    const nearest = (overview.todayTasks.nearest || []) as Array<{
      title?: string;
      contactName?: string;
      overdue?: boolean;
      href?: string;
    }>;
    return {
      headline: `${overview.todayTasks.overdue} просрочено, сегодня ещё ${overview.todayTasks.remaining} задач со сроком.`,
      bullets: nearest.slice(0, 6).map((task) => ({
        text: `${task.overdue ? "Просрочено · " : ""}${[task.title, task.contactName].filter(Boolean).join(" — ")}`,
        href: safeHref(task.href) || "/tasks",
      })),
      links: [
        { label: "Просроченные", href: "/tasks?filter=overdue" },
        { label: "Запланированные", href: "/tasks?filter=scheduled" },
      ],
    };
  }

  if (intent === "team") {
    const team = (overview.team || []) as Array<{
      name?: string;
      attention?: number;
      overdueTasks?: number;
      inWork?: number;
    }>;
    const loaded = [...team].sort((a, b) => (b.attention || 0) - (a.attention || 0));
    return {
      headline: loaded[0]
        ? `Выше нагрузка у «${loaded[0].name}»: ${loaded[0].attention || 0} пунктов внимания, ${loaded[0].overdueTasks || 0} просроченных задач.`
        : "По команде за выбранные условия данных нет.",
      bullets: loaded.slice(0, 6).map((row) => ({
        text: `${row.name}: внимание ${row.attention || 0}, в работе ${row.inWork || 0}, просрочено ${row.overdueTasks || 0}`,
      })),
      links: [{ label: "Команда на Главной", href: "/today#team" }],
    };
  }

  if (intent === "funnel") {
    const drop = overview.pipeline?.biggestDrop;
    const stages = (overview.pipeline?.stages || []) as Array<{ name?: string; count?: number }>;
    return {
      headline: drop
        ? `Клиенты чаще всего теряются между «${drop.fromName}» и «${drop.toName}» (${drop.fromCount} → ${drop.toCount}).`
        : "По открытой воронке сильного провала между стадиями нет.",
      bullets: stages.map((stage) => ({ text: `${stage.name}: ${stage.count ?? 0}` })),
      links: [{ label: "Воронка сделок", href: "/today#funnel" }],
    };
  }

  const d = r.deltas || {};
  const inqDelta = typeof d.inquiries === "number" ? d.inquiries : null;
  const extra =
    inqDelta == null
      ? ""
      : inqDelta === 0
        ? " Обращений столько же, сколько в прошлом периоде."
        : ` Обращений ${inqDelta > 0 ? "на " + inqDelta + " больше" : "на " + Math.abs(inqDelta) + " меньше"}, чем в прошлом периоде.`;
  return {
    headline: `${overview.brief}${extra}`,
    bullets: (overview.insights || []).map((item: any) => ({ text: item.text, href: safeHref(item.href) })),
    links: [
      { label: "Результат периода", href: "/today#sit-result" },
      { label: "Статистика", href: "/stats" },
    ],
  };
}

export async function askSituation(
  prisma: PrismaClient,
  auth: AuthContext,
  input: {
    text: string;
    period?: string;
    dateFrom?: string;
    dateTo?: string;
    scope?: string;
    onlyImportant?: boolean;
  },
): Promise<SituationAskResult> {
  const text = String(input.text || "").trim();
  if (text.length < 2) throw new ApiError(422, "invalid", "Напишите вопрос");

  const classified = classifySituationQuestion(text);
  if (classified.command) {
    return {
      question: text,
      intent: "command",
      command: true,
      usedLlm: false,
      period: input.period,
      suggestedPeriod: classified.suggestedPeriod,
      headline: "Это команда на действие. Откройте постановку задачи — CRM подготовит черновик.",
      bullets: [],
      links: [{ label: "Поставить задачу", href: `/tasks?command=${encodeURIComponent(text)}` }],
    };
  }

  const period = classified.suggestedPeriod || input.period || "today";
  const overview = await getSituationOverview(prisma, auth, {
    period,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    scope: input.scope,
    onlyImportant: input.onlyImportant ? "true" : undefined,
  });
  const snapshot = snapshotFromOverview(overview);
  const llm = process.env.NODE_ENV === "test" ? null : await answerSituationAskWithLlm(text, snapshot);
  const base = llm
    ? {
        headline: llm.headline,
        bullets: llm.bullets
          .map((row) => ({ text: row.text, href: safeHref(row.href) }))
          .filter((row) => row.text),
        links: llm.links
          .map((row) => ({ label: row.label, href: safeHref(row.href) || "" }))
          .filter((row): row is SituationAskLink => Boolean(row.label && row.href)),
        intent: (["attention", "deals", "inquiries", "tasks", "team", "funnel", "period", "clients", "other"].includes(
          llm.intent,
        )
          ? llm.intent
          : classified.intent) as SituationAskIntent,
      }
    : { ...fallbackAnswer(classified.intent, overview), intent: classified.intent };

  if (!base.bullets.length && !base.links.length) {
    const fallback = fallbackAnswer(classified.intent, overview);
    base.bullets = fallback.bullets;
    base.links = fallback.links;
  }

  return {
    question: text,
    intent: base.intent,
    command: false,
    usedLlm: Boolean(llm),
    period,
    suggestedPeriod: classified.suggestedPeriod,
    headline: base.headline,
    bullets: base.bullets.slice(0, 8),
    links: base.links.slice(0, 6),
  };
}
