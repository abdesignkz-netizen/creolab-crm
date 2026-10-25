import { z } from "zod";
import type { ControlAction } from "@creolab/contracts";
import { addDaysYmd, zonedLocalToUtc, zonedYmd } from "./periodRange.ts";
import { ApiError } from "../errors.ts";

export const CHAT_ACTIONS = ["GET_SALES_CONTROL", "GET_BUSINESS_SUMMARY", "GET_SITUATION", "GET_LEADS_STATS", "GET_DEALS_STATS", "GET_REVENUE_STATS", "GET_PIPELINE_SUMMARY", "GET_STUCK_DEALS", "GET_OVERDUE_TASKS", "GET_TASKS", "GET_TODAY_TASKS", "GET_CLIENTS", "FIND_CLIENT", "GET_CLIENT_DETAILS", "GET_DEAL", "FIND_DEAL", "GET_TEAM_STATUS", "GET_RECENT_LEADS", "GET_RECENT_DEALS", "CREATE_TASK", "CREATE_FOLLOW_UP", "COMPLETE_TASK", "UPDATE_TASK", "ADD_DEAL_NOTE", "MOVE_DEAL_STAGE", "ASSIGN_DEAL", "ASSIGN_TASK"] as const satisfies readonly ControlAction[];
// The model can name entities, but cannot select arbitrary database IDs or invent tools.
export const chatCommandSchema = z.object({
  action: z.enum(CHAT_ACTIONS),
  period: z.enum(["today", "yesterday", "last_7", "last_30", "this_month", "last_month"]).optional(),
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
}).strict();
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
    "Тармақ нөмірін немесе сұрауды жазыңыз: «Бүгінгі тапсырмалар», «Айбек клиентін тап». Қайту: «Мәзір». Өзгерістер растаудан кейін орындалады.")].join("\n");
}
export function quickControlCommand(text: string, timeZone = "Asia/Almaty", now = new Date()): ChatCommand | null {
  const t = text.trim().toLowerCase().replace(/ё/g, "е").replace(/[?!.]+$/g, "").replace(/\s+/g, " ");
  const index = /^[1-6]$/.test(t) ? Number(t) - 1 : -1;
  if (index >= 0 && ![4, 5].includes(index)) return { action: menuItems[index][0] };
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
  if (/^(?:мои |все |у нас )?задачи(?: есть)?(?: у нас| у меня)?(?: на сегодня| сегодня)?$/.test(read)) return { action: read.includes("сегодня") ? "GET_TODAY_TASKS" : "GET_TASKS" };
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
