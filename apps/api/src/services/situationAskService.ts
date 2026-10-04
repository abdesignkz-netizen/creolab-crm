import { systemText } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import type { PrismaClient } from "@creolab/db";
import { answerSituationAskWithLlm } from "./llmClient.ts";
import { detectDocumentCommand } from "./documentCommandService.ts";
import { getSituationOverview, type PeriodPreset } from "./situationOverviewService.ts";

const TASK_COMMAND_RE =
  /постав(ь|и)|создай задачу|позвон|напиш|отправ(ь|и)|уточн|follow-?up|кп\b|сообщени|сформируй|выставь\s+сч|подготовь\s+(договор|счёт|счет|авр|эсф|акт)|создай\s+(договор|счёт|счет|авр|эсф|акт)|закрой\s+сделк|проверь\s+(авр|эсф|акт|договор|счёт|счет)|валидир/i;
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
  documentCommand?: boolean;
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
}, locale = "ru") {
  const who = [item.contactName, item.phone].filter(Boolean).join(" · ");
  const title = item.title && item.title !== item.contactName ? item.title : "";
  return [who || title || systemText(locale, "Пункт"), item.reason].filter(Boolean).join(" — ");
}

export function classifySituationQuestion(text: string): {
  intent: SituationAskIntent;
  command: boolean;
  suggestedPeriod: PeriodPreset | null;
} {
  const q = text.toLowerCase();
  // Kazakh presets and natural questions use the same stable intents as Russian.
  const kkPeriod: PeriodPreset | null = /өткен апта|аптамен салыстыр|апта ішінде/.test(q) ? "last_7"
    : /кеше/.test(q) ? "yesterday" : /өткен ай/.test(q) ? "last_month" : /осы ай/.test(q) ? "this_month" : null;
  if (/^(?:тапсырма (?:құр|жаса)|қоңырау шал|хабарлама (?:жаз|жібер)|жаз|жібер|нақтыла)(?:\s|$)/i.test(q.trim())) {
    return { intent: "command", command: true, suggestedPeriod: kkPeriod };
  }
  if (/назар|басымдық|неден баст/.test(q)) return { intent: "attention", command: false, suggestedPeriod: kkPeriod };
  if (/клиенттер.*қай кезең|сату кезең|клиенттер.*кетіп/.test(q)) return { intent: "funnel", command: false, suggestedPeriod: kkPeriod };
  if (/мәміле.*тоқтап|қай мәміле/.test(q)) return { intent: "deals", command: false, suggestedPeriod: kkPeriod };
  if (/өтінім|өтініш/.test(q)) return { intent: "inquiries", command: false, suggestedPeriod: kkPeriod };
  if (/жүктеме|кімнің жұмысы/.test(q)) return { intent: "team", command: false, suggestedPeriod: kkPeriod };
  if (/қай тапсырма|мерзімі өткен/.test(q)) return { intent: "tasks", command: false, suggestedPeriod: kkPeriod };
  if (/жауап күт|жауап берілмеген/.test(q)) return { intent: "clients", command: false, suggestedPeriod: kkPeriod };
  if (/салыстыр|не өзгер|нәтиже/.test(q)) return { intent: "period", command: false, suggestedPeriod: kkPeriod };
  const command = TASK_COMMAND_RE.test(text) && !LEADING_QUESTION_RE.test(q.trim());
  let suggestedPeriod: PeriodPreset | null = kkPeriod;
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
  overview: Awaited<ReturnType<typeof getSituationOverview>>, locale = "ru",
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
      s.needsReply || s.overdueTasks || s.needsHuman || c.newInquiries || s.overSlaDeals || s.paymentOverdue || s.noNextAction
        ? systemText(locale, "Сейчас требуют внимания: {p0} ждут ответа, {p1} диалогов без человека, {p2} просроченных задач, {p3} без следующего шага, {p4} сверх SLA, {p5} с просроченной оплатой.", { p0: s.needsReply, p1: s.needsHuman, p2: s.overdueTasks, p3: s.noNextAction ?? 0, p4: s.overSlaDeals ?? 0, p5: s.paymentOverdue ?? 0 })
        : systemText(locale, "Критических действий сейчас нет — можно разобрать плановые задачи и сделки в работе.");
    const bullets = items.slice(0, 6).map((item) => ({ text: itemLabel(item, locale), href: safeHref(item.href) }));
    return {
      headline,
      bullets: bullets.length ? bullets : (overview.insights || []).map((item: any) => ({ text: item.text, href: safeHref(item.href) })),
      links: [
        { label: systemText(locale, "Требует внимания"), href: "/today#attention" },
        { label: systemText(locale, "Ждут ответа"), href: "/contacts?filter=needs_reply" },
        { label: systemText(locale, "Просроченные задачи"), href: "/tasks?filter=overdue" },
      ],
    };
  }

  if (intent === "clients") {
    const reply = items.filter((item) => item.group === "needs_reply" || item.kind === "contact_needs_reply");
    return {
      headline: s.needsReply
        ? systemText(locale, "{p0} клиент(ов) ждут ответа — это входящие без исходящего после них.", { p0: s.needsReply })
        : systemText(locale, "Клиентов, которые ждут ответа, сейчас нет."),
      bullets: (reply.length ? reply : items).slice(0, 6).map((item) => ({ text: itemLabel(item, locale), href: safeHref(item.href) })),
      links: [{ label: systemText(locale, "Клиенты · нужен ответ"), href: "/contacts?filter=needs_reply" }],
    };
  }

  if (intent === "deals") {
    const deals = (overview.importantDeals || []) as Array<{ title?: string; reason?: string; href?: string }>;
    return {
      headline: c.stalledDeals || s.overSlaDeals || s.noNextAction
        ? systemText(locale, "{p0} сделок зависли. {p1} сверх SLA. {p2} без следующего шага. В работе {p3}.", { p0: c.stalledDeals, p1: s.overSlaDeals ?? 0, p2: s.noNextAction ?? 0, p3: c.activeDeals })
        : systemText(locale, "Открытых сделок: {p0}. Зависших по активности нет.", { p0: c.activeDeals }),
      bullets: deals.slice(0, 6).map((deal) => ({
        text: [deal.title, deal.reason].filter(Boolean).join(" — "),
        href: safeHref(deal.href),
      })),
      links: [
        { label: systemText(locale, "Зависшие сделки"), href: "/deals?focus=stalled" },
        { label: systemText(locale, "Все сделки"), href: "/deals" },
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
      headline: systemText(locale, "{p0} новых заявок ещё не взяты, {p1} уже в работе. За период: {p2} обращений.", { p0: c.newInquiries, p1: c.inWorkInquiries, p2: r.inquiries }),
      bullets: recent.slice(0, 6).map((item) => ({
        text: [item.contactName || item.title, item.status].filter(Boolean).join(" · "),
        href: safeHref(item.href),
      })),
      links: [
        { label: systemText(locale, "Новые заявки"), href: "/inquiries?filter=new&test=false" },
        { label: systemText(locale, "Требуют внимания"), href: "/inquiries?filter=attention" },
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
      headline: systemText(locale, "{p0} просрочено, сегодня ещё {p1} задач со сроком.", { p0: overview.todayTasks.overdue, p1: overview.todayTasks.remaining }),
      bullets: nearest.slice(0, 6).map((task) => ({
        text: `${task.overdue ? systemText(locale, "Просрочено · ") : ""}${[task.title, task.contactName].filter(Boolean).join(" — ")}`,
        href: safeHref(task.href) || "/tasks",
      })),
      links: [
        { label: systemText(locale, "Просроченные"), href: "/tasks?filter=overdue" },
        { label: systemText(locale, "Запланированные"), href: "/tasks?filter=scheduled" },
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
        ? systemText(locale, "Выше нагрузка у «{p0}»: {p1} пунктов внимания, {p2} просроченных задач.", { p0: loaded[0].name || "", p1: loaded[0].attention || 0, p2: loaded[0].overdueTasks || 0 })
        : systemText(locale, "По команде за выбранные условия данных нет."),
      bullets: loaded.slice(0, 6).map((row) => ({
        text: systemText(locale, "{p0}: внимание {p1}, в работе {p2}, просрочено {p3}", { p0: row.name || "", p1: row.attention || 0, p2: row.inWork || 0, p3: row.overdueTasks || 0 }),
      })),
      links: [{ label: systemText(locale, "Команда на Главной"), href: "/today#team" }],
    };
  }

  if (intent === "funnel") {
    const drop = overview.pipeline?.biggestDrop;
    const stages = (overview.pipeline?.stages || []) as Array<{ name?: string; count?: number }>;
    return {
      headline: drop
        ? systemText(locale, "Клиенты чаще всего теряются между «{p0}» и «{p1}» ({p2} → {p3}).", { p0: drop.fromName, p1: drop.toName, p2: drop.fromCount, p3: drop.toCount })
        : systemText(locale, "По открытой воронке сильного провала между стадиями нет."),
      bullets: stages.map((stage) => ({ text: `${stage.name}: ${stage.count ?? 0}` })),
      links: [{ label: systemText(locale, "Воронка сделок"), href: "/today#funnel" }],
    };
  }

  const d = r.deltas || {};
  const inqDelta = typeof d.inquiries === "number" ? d.inquiries : null;
  const extra =
    inqDelta == null
      ? ""
      : inqDelta === 0
        ? systemText(locale, " Обращений столько же, сколько в прошлом периоде.")
        : systemText(locale, inqDelta > 0 ? " Обращений на {count} больше, чем в прошлом периоде." : " Обращений на {count} меньше, чем в прошлом периоде.", { count: Math.abs(inqDelta) });
  return {
    headline: `${overview.brief}${extra}`,
    bullets: (overview.insights || []).map((item: any) => ({ text: item.text, href: safeHref(item.href) })),
    links: [
      { label: systemText(locale, "Результат периода"), href: "/today#sit-result" },
      { label: systemText(locale, "Статистика"), href: "/stats" },
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
  const locale = auth.user.locale || "ru";
  const text = String(input.text || "").trim();
  if (text.length < 2) throw new ApiError(422, "invalid", systemText(locale, "Напишите вопрос"));

  const classified = classifySituationQuestion(text);
  if (classified.command) {
    const document = detectDocumentCommand(text);
    return {
      question: text,
      intent: "command",
      command: true,
      documentCommand: Boolean(document),
      usedLlm: false,
      period: input.period,
      suggestedPeriod: classified.suggestedPeriod,
      headline: document
        ? systemText(locale, "Это команда по документам сделки. Откройте раздел «Документы».")
        : systemText(locale, "Это команда на действие. Откройте постановку задачи — CRM подготовит черновик."),
      bullets: [],
      links: document
        ? [{ label: systemText(locale, "Открыть документы"), href: `/documents?command=${encodeURIComponent(text)}` }]
        : [{ label: systemText(locale, "Поставить задачу"), href: `/tasks?command=${encodeURIComponent(text)}` }],
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
  const llm = process.env.NODE_ENV === "test" ? null : await answerSituationAskWithLlm(text, snapshot, {
    prisma,
    tenantId: auth.activeMembership?.tenantId,
  }, locale);
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
    : { ...fallbackAnswer(classified.intent, overview, locale), intent: classified.intent };

  if (!base.bullets.length && !base.links.length) {
    const fallback = fallbackAnswer(classified.intent, overview, locale);
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
