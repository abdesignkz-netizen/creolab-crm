import { z } from "zod";
import type { ControlAction } from "@creolab/contracts";
import { addDaysYmd, zonedLocalToUtc, zonedYmd } from "./periodRange.ts";
import { ApiError } from "../errors.ts";
import { CONTROL_PERIODS } from "./controlPeriods.ts";

export const DEAL_READ_ACTIONS = ["GET_UNCHANGED_DEALS", "GET_PROPOSALS_WITHOUT_FOLLOWUP", "GET_LOST_REASONS", "GET_EXPECTED_PAYMENTS"] as const;

export const CHAT_ACTIONS = ["GET_SALES_CONTROL", "GET_BUSINESS_SUMMARY", "GET_SITUATION", "GET_LEADS_STATS", "GET_DEALS_STATS", "GET_REVENUE_STATS", "GET_PIPELINE_SUMMARY", "GET_STUCK_DEALS", ...DEAL_READ_ACTIONS, "GET_OVERDUE_TASKS", "GET_TASKS", "GET_TODAY_TASKS", "GET_CLIENTS", "FIND_CLIENT", "GET_CLIENT_DETAILS", "GET_DEAL", "FIND_DEAL", "GET_TEAM_STATUS", "GET_RECENT_LEADS", "GET_RECENT_DEALS", "CREATE_TASK", "CREATE_FOLLOW_UP", "COMPLETE_TASK", "UPDATE_TASK", "ADD_DEAL_NOTE", "MOVE_DEAL_STAGE", "ASSIGN_DEAL", "ASSIGN_TASK"] as const satisfies readonly ControlAction[];
// The model can name entities, but cannot select arbitrary database IDs or invent tools.
export const chatCommandSchema = z.object({
  action: z.enum(CHAT_ACTIONS),
  period: z.enum(CONTROL_PERIODS).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  scope: z.enum(["accessible", "mine", "team"]).optional(),
  inactiveDays: z.number().int().min(1).max(3650).optional(),
  changeBasis: z.enum(["activity", "stage"]).optional(),
  taskStatus: z.enum(["active", "completed", "all"]).optional(),
  leadFilter: z.enum(["all", "needs_reply"]).optional(),
  salesFilter: z.enum(["all", "attention", "ready", "goal"]).optional(),
  query: z.string().trim().min(1).max(160).optional(),
  client: z.string().trim().min(1).max(160).optional(),
  deal: z.string().trim().min(1).max(160).optional(),
  task: z.string().trim().min(1).max(160).optional(),
  assignee: z.string().trim().min(1).max(160).optional(),
  stage: z.string().trim().min(1).max(100).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  note: z.string().trim().min(1).max(2000).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  useSelectedClient: z.boolean().optional(),
}).strict().superRefine((command, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });
  if (command.period === "custom" ? !command.dateFrom || !command.dateTo : command.dateFrom || command.dateTo) reject("Укажите обе даты для собственного периода.");
  const scopedReads = ["GET_TASKS", "GET_TODAY_TASKS", "GET_OVERDUE_TASKS", "GET_RECENT_LEADS", "GET_RECENT_DEALS", ...DEAL_READ_ACTIONS];
  if (command.action === "GET_UNCHANGED_DEALS") {
    if (!command.inactiveDays || command.period) reject("Для сделок без изменений укажите число дней вместо периода отчёта.");
  } else if (command.inactiveDays != null || command.changeBasis) reject("Число дней без изменений относится только к соответствующему списку сделок.");
  if (command.action.startsWith("GET_") || command.action.startsWith("FIND_")) {
    if (command.query && ![...scopedReads, "FIND_CLIENT", "GET_CLIENT_DETAILS", "FIND_DEAL", "GET_DEAL"].includes(command.action)) reject("У этой команды нет текстового фильтра.");
    if (command.deal && command.action !== "GET_DEAL") reject("У этой команды нет фильтра сделки.");
    if (command.title || command.task || command.note || command.stage || command.dueAt) reject("Эти параметры не поддерживаются запросом данных.");
  }
  if (command.scope && !scopedReads.includes(command.action)) reject("У этой команды нет фильтра сотрудника.");
  if (command.assignee && ![...scopedReads, "CREATE_TASK", "CREATE_FOLLOW_UP", "ASSIGN_TASK", "ASSIGN_DEAL"].includes(command.action)) reject("У этой команды нет фильтра или назначения сотрудника.");
  if ((command.client || command.useSelectedClient) && !["GET_CLIENT_DETAILS", "CREATE_TASK", "CREATE_FOLLOW_UP", "GET_TASKS", "GET_TODAY_TASKS", "GET_OVERDUE_TASKS", ...DEAL_READ_ACTIONS].includes(command.action)) reject("У этой команды нет фильтра клиента.");
  if (command.salesFilter && command.action !== "GET_SALES_CONTROL") reject("Фильтр относится к контролю продаж.");
  if (command.period && ![...scopedReads, "GET_BUSINESS_SUMMARY", "GET_LEADS_STATS", "GET_DEALS_STATS", "GET_REVENUE_STATS"].includes(command.action)) reject("У этой команды нет фильтра периода.");
  if (command.taskStatus && command.action !== "GET_TASKS") reject("Уточните запрос задач и их статус.");
  if (command.leadFilter && command.action !== "GET_RECENT_LEADS") reject("Фильтр относится к списку заявок.");
  if (command.action === "GET_TODAY_TASKS" && command.period && command.period !== "today") reject("Для другого периода используйте список задач.");
});
export type ChatCommand = z.infer<typeof chatCommandSchema>;
export type ChatLanguage = "ru" | "kk";
export const words = (lang: ChatLanguage, ru: string, kk: string) => lang === "kk" ? kk : ru;
export const cleanText = (value: unknown, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max);
export const menuItems = [
  ["GET_BUSINESS_SUMMARY", "Сводка за сегодня", "Бүгінгі қорытынды"],
  ["GET_SITUATION", "Что требует внимания", "Назар аудару керек"],
  ["GET_TODAY_TASKS", "Задачи на сегодня", "Бүгінгі тапсырмалар"],
  ["GET_DEALS_STATS", "Продажи за сегодня", "Бүгінгі сатылымдар"],
  ["FIND_CLIENT", "Найти клиента", "Клиентті табу"],
  ["CREATE_TASK", "Создать задачу", "Тапсырма құру"],
] as const;
export function controlChatMenu(lang: ChatLanguage, allowed: readonly string[]) {
  return ["BasQar Control", ...menuItems.flatMap(([action, ru, kk], i) => allowed.includes(action) ? [`${i + 1}. ${words(lang, ru, kk)}`] : []), words(lang,
    "Пишите обычным сообщением в любой момент: «Какие задачи на сегодня?», «Найди клиента Айбек», «Создай задачу встреча завтра в 15:00». Вызывать меню не нужно. Изменения выполняются после подтверждения.",
    "Кез келген уақытта жазыңыз: «Бүгінгі тапсырмалар», «Айбек клиентін тап». Мәзірді шақыру қажет емес. Өзгерістер растаудан кейін орындалады.")].join("\n");
}
const periodWords: Record<string, ChatCommand["period"]> = {
  "сегодня": "today", "вчера": "yesterday", "эту неделю": "this_week", "этой неделе": "this_week", "текущую неделю": "this_week",
  "прошлую неделю": "last_week", "неделю": "last_7", "последние 7 дней": "last_7", "7 дней": "last_7", "последние 30 дней": "last_30", "30 дней": "last_30",
  "месяц": "this_month", "этот месяц": "this_month", "текущий месяц": "this_month", "прошлый месяц": "last_month", "этот год": "this_year", "все время": "all",
  "бүгін": "today", "кеше": "yesterday", "осы апта": "this_week", "осы аптада": "this_week", "өткен апта": "last_week", "соңғы 7 күн": "last_7",
  "соңғы 30 күн": "last_30", "осы ай": "this_month", "өткен ай": "last_month", "биыл": "this_year", "барлық уақыт": "all",
};
export function controlPeriodPhrase(raw: string): Pick<ChatCommand, "period" | "dateFrom" | "dateTo"> | null {
  const text = raw.toLowerCase().replace(/ё/g, "е").trim();
  if (periodWords[text]) return { period: periodWords[text] };
  const range = text.match(/^с (\d{4}-\d{2}-\d{2}) по (\d{4}-\d{2}-\d{2})$/);
  return range ? { period: "custom", dateFrom: range[1], dateTo: range[2] } : null;
}
export function quickControlPeriodFollowup(text: string) {
  const match = text.trim().replace(/[?!.]+$/g, "").match(/^(?:а (?:за |на )?|ал )(.+)$/i);
  return match ? controlPeriodPhrase(match[1]) : null;
}
function preciseRead(text: string): ChatCommand | null {
  const dealRead = preciseDealRead(text);
  if (dealRead) return dealRead;
  const task = text.match(/^(?:(мои|моей команды) )?(просроченные задачи|завершенные задачи|все задачи|задачи)(?: (мои|у меня|моей команды|всей команды))?(?: (?:на |за )?(.+))?$/);
  if (task) {
    const period = task[4] ? controlPeriodPhrase(task[4]) : null;
    if (task[4] && !period) return null;
    const scope = /команды/.test(`${task[1]} ${task[3]}`) ? "team" : task[1] === "мои" || task[3] === "мои" || task[3] === "у меня" ? "mine" : undefined;
    const overdue = task[2] === "просроченные задачи", completed = task[2] === "завершенные задачи", all = task[2] === "все задачи";
    return { action: overdue ? "GET_OVERDUE_TASKS" : period?.period === "today" && !completed && !all ? "GET_TODAY_TASKS" : "GET_TASKS",
      ...(scope ? { scope } : {}), ...(period || {}), ...(completed ? { taskStatus: "completed" } : all ? { taskStatus: "all" } : {}) };
  }
  const unanswered = text.match(/^заявки (.+?) (?:остались )?без ответа$/) || text.match(/^заявки без ответа(?: за (.+))?$/);
  if (unanswered) {
    const period = unanswered[1] ? controlPeriodPhrase(unanswered[1]) : { period: "all" as const };
    return period ? { action: "GET_RECENT_LEADS", leadFilter: "needs_reply", ...period } : null;
  }
  const report = text.match(/^(?:сводка|итоги|продажи|сделки|выручка|заявки|статистика заявок|отчет по продажам|последние заявки|последние сделки) (.+)$/);
  if (report) {
    const period = controlPeriodPhrase(report[1].replace(/^(?:за |на )/, ""));
    if (!period) return null;
    const action = /^(?:отчет по продажам|продажи|сделки) /.test(text) ? "GET_DEALS_STATS" : /^выручка /.test(text) ? "GET_REVENUE_STATS"
      : /^последние заявки /.test(text) ? "GET_RECENT_LEADS" : /^последние сделки /.test(text) ? "GET_RECENT_DEALS"
      : /^(?:заявки|статистика заявок) /.test(text) ? "GET_LEADS_STATS" : "GET_BUSINESS_SUMMARY";
    return { action, ...period };
  }
  // Whole phrases: never execute a read merely because a compound request contains its words.
  const kk = text.match(/^(бүгінгі|кешегі|осы аптадағы|өткен аптадағы|осы айдағы|өткен айдағы) (тапсырмалар|сатылымдар|өтінімдер)(?:ді|ды)?(?: көрсет)?$/);
  if (kk) {
    const period = ({ бүгінгі: "today", кешегі: "yesterday", "осы аптадағы": "this_week", "өткен аптадағы": "last_week", "осы айдағы": "this_month", "өткен айдағы": "last_month" } as const)[kk[1] as "бүгінгі"];
    return { action: kk[2] === "тапсырмалар" ? period === "today" ? "GET_TODAY_TASKS" : "GET_TASKS" : kk[2] === "сатылымдар" ? "GET_DEALS_STATS" : "GET_LEADS_STATS", period };
  }
  if (/^(?:менің |менің командамның |командамның )?мерзімі өткен тапсырмалар(?:ды)?(?: көрсет)?$/.test(text)) return { action: "GET_OVERDUE_TASKS", ...(/командам/.test(text) ? { scope: "team" as const } : text.startsWith("менің ") ? { scope: "mine" as const } : {}) };
  if (/^бүгін(?:гі)? жауапсыз (?:қалған )?өтінімдер(?:ді)?(?: көрсет)?$/.test(text)) return { action: "GET_RECENT_LEADS", leadFilter: "needs_reply", period: "today" };
  return null;
}
function preciseDealRead(raw: string): ChatCommand | null {
  const text = raw.replace(/^найди(?:те)?\s+/, "").replace(/,\s*/g, " ");
  const inactive = text.match(/^(мои |моей команды )?сделки (?:без изменений|которые не менялись|без смены этапа|у которых не менялся этап) (\d+|одну|две|три|четыре|двух) (день|дня|дней|неделю|недели|недель)(?: и более)?$/);
  if (inactive) {
    const count = Number(inactive[2]) || ({ одну: 1, две: 2, двух: 2, три: 3, четыре: 4 } as Record<string, number>)[inactive[2]];
    const inactiveDays = count * (inactive[3].startsWith("нед") ? 7 : 1);
    if (!Number.isInteger(inactiveDays) || inactiveDays < 1 || inactiveDays > 3650) return null;
    return { action: "GET_UNCHANGED_DEALS", inactiveDays, changeBasis: text.includes("этап") ? "stage" : "activity",
      ...(inactive[1] ? { scope: inactive[1] === "мои " ? "mine" : "team" } : {}) };
  }
  const definitions: Array<[RegExp, ChatCommand["action"]]> = [
    [/^(?:кп без следующего контакта|сделки с отправленным кп без следующего контакта|клиенты без следующего контакта после кп|клиентов которым отправили (?:кп|коммерческое предложение) но не назначили следующий контакт)(?: за (.+))?$/, "GET_PROPOSALS_WITHOUT_FOLLOWUP"],
    [/^(?:причины проигрыша(?: сделок)?|почему проиграли сделки)(?: за (.+))?$/, "GET_LOST_REASONS"],
    [/^(?:ожидаемые оплаты|сделки по которым ожидается оплата)(?: (?:за |на )?(.+))?$/, "GET_EXPECTED_PAYMENTS"],
  ];
  for (const [pattern, action] of definitions) {
    const match = text.match(pattern);
    if (match) {
      const period = match[1] ? controlPeriodPhrase(match[1]) : null;
      if (match[1] && !period) return null;
      return { action, ...(period || {}) };
    }
  }
  const kkInactive = text.match(/^(\d+) күн(?: бойы)? (өзгермеген|кезеңі өзгермеген) мәмілелер(?:ді)?(?: көрсет)?$/);
  if (kkInactive && Number(kkInactive[1]) >= 1 && Number(kkInactive[1]) <= 3650) return { action: "GET_UNCHANGED_DEALS", inactiveDays: Number(kkInactive[1]), changeBasis: kkInactive[2].startsWith("кезеңі") ? "stage" : "activity" };
  if (text === "ұсыныс жіберілген бірақ келесі байланыс жоспарланбаған клиенттер") return { action: "GET_PROPOSALS_WITHOUT_FOLLOWUP" };
  const kk = text.match(/^(?:(осы аптадағы|өткен аптадағы|осы айдағы|өткен айдағы) )?(күтілетін төлемдер|мәмілелерді жоғалту себептері)(?:ді)?(?: көрсет)?$/);
  if (kk) return { action: kk[2] === "күтілетін төлемдер" ? "GET_EXPECTED_PAYMENTS" : "GET_LOST_REASONS", ...(kk[1] ? { period: ({ "осы аптадағы": "this_week", "өткен аптадағы": "last_week", "осы айдағы": "this_month", "өткен айдағы": "last_month" } as const)[kk[1] as "осы аптадағы"] } : {}) };
  return null;
}
export function quickControlCommand(text: string, timeZone = "Asia/Almaty", now = new Date()): ChatCommand | null {
  const t = text.trim().toLowerCase().replace(/ё/g, "е").replace(/[?!.]+$/g, "").replace(/\s+/g, " ");
  const index = /^[1-6]$/.test(t) ? Number(t) - 1 : -1;
  if (index >= 0 && ![4, 5].includes(index)) return { action: menuItems[index][0] };
  // Keep "mine" when removing a conversational prefix.
  const readText = t.replace(/^(?:покажи(?:те)?|выведи(?:те)?|подготовь(?:те)?)\s+(?:мне\s+)?/, "")
    .replace(/^какие\s+(?:у меня\s+)?(?:есть\s+)?/, t.startsWith("какие у меня ") ? "мои " : "").replace(/,?\s*пожалуйста$/, "");
  const precise = preciseRead(readText);
  if (precise) return precise;
  const salesFilters: Record<string, ChatCommand["salesFilter"]> = {
    "какие клиенты близки к покупке": "ready", "клиенты близкие к покупке": "ready", "клиенты близки к покупке": "ready", "клиентов близких к покупке": "ready",
    "что мешает завершить сделки": "attention", "где нужно мое участие в продажах": "attention", "по каким сделкам цель достигнута": "goal",
  };
  if (salesFilters[t]) return { action: "GET_SALES_CONTROL", salesFilter: salesFilters[t] };
  const exact: Record<string, ChatCommand["action"]> = {
    "продажи под контролем": "GET_SALES_CONTROL", "что мешает завершить сделки": "GET_SALES_CONTROL", "какие клиенты близки к покупке": "GET_SALES_CONTROL",
    "где нужно мое участие в продажах": "GET_SALES_CONTROL", "бақылаудағы сатылымдар": "GET_SALES_CONTROL",
    "сводка": "GET_BUSINESS_SUMMARY", "сводка за сегодня": "GET_BUSINESS_SUMMARY", "бүгінгі қорытынды": "GET_BUSINESS_SUMMARY",
    "что требует внимания": "GET_SITUATION", "ситуация": "GET_SITUATION", "назар аудару керек": "GET_SITUATION",
    "где нужен сотрудник": "GET_SITUATION", "кому нужен сотрудник": "GET_SITUATION", "кому нужен менеджер": "GET_SITUATION", "где нужен менеджер": "GET_SITUATION", "кімге қызметкер керек": "GET_SITUATION",
    "задачи": "GET_TASKS", "тапсырмалар": "GET_TASKS", "задачи на сегодня": "GET_TODAY_TASKS", "бүгінгі тапсырмалар": "GET_TODAY_TASKS",
    "просроченные задачи": "GET_OVERDUE_TASKS", "мерзімі өткен тапсырмалар": "GET_OVERDUE_TASKS", "продажи": "GET_DEALS_STATS", "сатылымдар": "GET_DEALS_STATS",
    "команда": "GET_TEAM_STATUS", "новые заявки": "GET_RECENT_LEADS", "жаңа өтінімдер": "GET_RECENT_LEADS", "клиенты": "GET_CLIENTS", "клиенттер": "GET_CLIENTS",
  };
  if (exact[t]) return { action: exact[t] };
  // Common reads must remain available when the language model is unavailable.
  // Match the whole request, never a keyword inside a write or a compound request.
  const read = t.replace(/^(?:(?:покажи(?:те)?|расскажи(?:те)?|скажи(?:те)?|подскажи(?:те)?|выведи(?:те)?|дай(?:те)?)\s+(?:мне\s+)?|какие\s+(?:у нас\s+|у меня\s+)?(?:есть\s+)?|что\s+у нас\s+по\s+)/, "").replace(/,?\s*пожалуйста$/, "");
  if (salesFilters[read]) return { action: "GET_SALES_CONTROL", salesFilter: salesFilters[read] };
  if (/^(?:мои |все |у нас )?задачи(?: есть)?(?: у нас| у меня)?(?: на сегодня| сегодня)?$/.test(read)) return { action: read.includes("сегодня") ? "GET_TODAY_TASKS" : "GET_TASKS", ...(/мои|у меня/.test(read) ? { scope: "mine" as const } : {}) };
  if (/^(?:какие )?(?:просроченные задачи|задачи просрочены)$/.test(read)) return { action: "GET_OVERDUE_TASKS" };
  if (/^(?:кто|какие клиенты|клиенты которые) (?:ждет|ждут) (?:ответа|менеджера|сотрудника)$/.test(read)) return { action: "GET_SITUATION" };
  const periodMatch = read.match(/^(сводка|итоги|продажи|сделки|выручка|заявки|статистика заявок)(?: (?:за |на )?(сегодня|вчера|неделю|7 дней|30 дней|месяц|этот месяц|прошлый месяц))?$/);
  if (periodMatch) return { action: ({ сводка: "GET_BUSINESS_SUMMARY", итоги: "GET_BUSINESS_SUMMARY", продажи: "GET_DEALS_STATS", сделки: "GET_DEALS_STATS", выручка: "GET_REVENUE_STATS", заявки: "GET_LEADS_STATS", "статистика заявок": "GET_LEADS_STATS" } as const)[periodMatch[1] as "сводка"], period: ({ вчера: "yesterday", неделю: "last_7", "7 дней": "last_7", "30 дней": "last_30", месяц: "this_month", "этот месяц": "this_month", "прошлый месяц": "last_month" } as Record<string, ChatCommand["period"]>)[periodMatch[2]] || "today" };
  const reads: Record<string, ChatCommand["action"]> = { "воронка": "GET_PIPELINE_SUMMARY", "застрявшие сделки": "GET_STUCK_DEALS", "последние сделки": "GET_RECENT_DEALS", "последние заявки": "GET_RECENT_LEADS", "новые заявки": "GET_RECENT_LEADS", "команда": "GET_TEAM_STATUS", "клиенты": "GET_CLIENTS" };
  if (exact[read]) return { action: exact[read] };
  if (reads[read]) return { action: reads[read] };
  const find = text.match(/^(?:найди(?:те)? (?:клиента|контакт)|клиентті тап|клиент іздеу)\s+(.+)$/i);
  if (find) return { action: "FIND_CLIENT", query: find[1].trim() };
  const kazFind = text.match(/^(.+?)\s+клиентін тап$/i);
  if (kazFind) return { action: "FIND_CLIENT", query: kazFind[1].trim() };
  return quickTaskCommand(text, timeZone, now);
}

/** Conservative local parser. Entity assignments and complex schedules go to the
 * structured model parser; a simple dated task never depends on that model. */
function quickTaskCommand(text: string, timeZone: string, now: Date): ChatCommand | null {
  const match = text.trim().match(/^(?:создай(?:те)?|создать|добавь(?:те)?|поставь(?:те)?|запиши(?:те)?)\s+(?:мне\s+)?(?:задачу|напоминание)\s*:?\s+(.+)$/isu);
  if (!match) return null;
  let title = match[1].trim();
  const selectedClientRef = /(^|\s)(?:с (?:этим|данным|выбранным) клиентом|(?:этому|данному|выбранному) клиенту|для (?:этого|данного|выбранного) клиента)(?=\s|[,.!?]|$)/iu;
  const useSelectedClient = selectedClientRef.test(title);
  if (useSelectedClient) title = title.replace(selectedClientRef, "$1").replace(/\s+/g, " ").trim();
  // Ambiguous pronouns/deal references need the structured parser or a
  // clarification, never an unlinked task that only appears to name a client.
  if (/(?:^|\s)(?:ему|ей|с ним|с ней|по этой сделке)(?=\s|[,.!?]|$)/iu.test(title)) return null;
  if (/(?:ответственн|исполнитель|назначь|для клиента|клиенту|этому клиенту|;|\n)/i.test(title)) return null;
  const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const datePattern = new RegExp(`(?:\\s+(?:на|до))?\\s+(сегодня|завтра|послезавтра|\\d{1,2}\\s+(?:${months.join("|")})(?:\\s+\\d{4}(?:\\s*г(?:ода|\\.)?)?)?|\\d{1,2}\\.\\d{1,2}(?:\\.\\d{4})?)(?:\\s+(?:в|к)\\s+(\\d{1,2})(?::(\\d{2}))?)?[.!?]*$`, "i");
  const date = title.match(datePattern);
  let dueAt: string | undefined;
  if (date) {
    const today = zonedYmd(now, timeZone), raw = date[1].toLowerCase();
    let ymd = today;
    if (["сегодня", "завтра", "послезавтра"].includes(raw)) ymd = addDaysYmd(today, { сегодня: 0, завтра: 1, послезавтра: 2 }[raw]!);
    else {
      const named = raw.match(/^(\d{1,2})\s+([^\s]+)(?:\s+(\d{4}))?/);
      const numeric = raw.split(".").map(Number);
      ymd = { day: named ? Number(named[1]) : numeric[0], month: named ? months.indexOf(named[2]) + 1 : numeric[1], year: named ? Number(named[3] || today.year) : numeric[2] || today.year };
    }
    const hour = date[2] === undefined ? 18 : Number(date[2]), minute = Number(date[3] || 0);
    const check = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
    if (ymd.month < 1 || ymd.month > 12 || check.getUTCDate() !== ymd.day || check.getUTCMonth() + 1 !== ymd.month || hour > 23 || minute > 59) throw new ApiError(422, "invalid_due_date", "Уточните дату и время задачи: например, 22 октября в 18:00.");
    dueAt = zonedLocalToUtc(timeZone, ymd.year, ymd.month, ymd.day, hour, minute).toISOString();
    title = title.slice(0, date.index).trim();
  }
  // Never turn an unparsed deadline or assignment into a task silently.
  if (!title || /(?:сегодня|завтра|\d{1,2}:\d{2}|\d{1,2}\.\d{1,2}|понедельник|вторник|сред[ау]|четверг|пятниц|суббот|воскресень|через\s+\d|\s(?:в|к)\s+\d|назначить|ответственн)/i.test(title)) return null;
  return { action: "CREATE_TASK", title, ...(dueAt ? { dueAt } : {}), ...(useSelectedClient ? { useSelectedClient: true } : {}) };
}

// Requests for areas without a chat tool get a precise route, never a fabricated
// success or an invitation to restart the menu.
export function controlSectionHelp(text: string, lang: ChatLanguage): { label: string; path: string } | null {
  const t = text.toLowerCase();
  const sections = [
    [/рассыл|таратылым/, "Рассылки: получатели, подготовка и подтверждение отправки", "Таратылымдар", "/campaigns"],
    [/телеграм|telegram|инстаграм|instagram|интеграц|подключ.*(?:ватсап|whatsapp|сайт)/, "Подключения: WhatsApp, Telegram, Instagram и чат на сайте", "Арналарды қосу", "/integrations"],
    [/тариф|подписк|оплат.*(?:сервис|basqar)|биллинг/, "Тариф и оплата BasQar", "Тариф және төлем", "/billing"],
    [/договор|счет|счёт|акт |авр|эсф|документ/, "Документы: договоры, счета и акты", "Құжаттар", "/documents"],
    [/настро.*(?:ии|ai)|промп?т|баз.*знани/, "Настройка ИИ-менеджера и базы знаний", "ИИ-менеджерді баптау", "/settings/ai-manager"],
    [/уведомлен|оповещен/, "Настройки уведомлений Control", "Control хабарландырулары", "/settings?section=control"],
  ] as const;
  const match = sections.find(([pattern]) => pattern.test(t));
  return match ? { label: words(lang, match[1], match[2]), path: match[3] } : null;
}
