import { z } from "zod";
import type { ControlAction } from "@creolab/contracts";

export const CHAT_ACTIONS = ["GET_BUSINESS_SUMMARY", "GET_SITUATION", "GET_LEADS_STATS", "GET_DEALS_STATS", "GET_REVENUE_STATS", "GET_PIPELINE_SUMMARY", "GET_STUCK_DEALS", "GET_OVERDUE_TASKS", "GET_TASKS", "GET_TODAY_TASKS", "GET_CLIENTS", "FIND_CLIENT", "GET_CLIENT_DETAILS", "GET_DEAL", "FIND_DEAL", "GET_TEAM_STATUS", "GET_RECENT_LEADS", "GET_RECENT_DEALS", "CREATE_TASK", "CREATE_FOLLOW_UP", "COMPLETE_TASK", "UPDATE_TASK", "ADD_DEAL_NOTE", "MOVE_DEAL_STAGE", "ASSIGN_DEAL", "ASSIGN_TASK"] as const satisfies readonly ControlAction[];
// The model can name entities, but cannot select arbitrary database IDs or invent tools.
export const chatCommandSchema = z.object({
  action: z.enum(CHAT_ACTIONS),
  period: z.enum(["today", "yesterday", "last_7", "last_30", "this_month", "last_month"]).optional(),
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
    "Напишите номер пункта или запрос: «Задачи на сегодня», «Найди клиента Айбек». Для возврата — «Меню». Изменения выполняются после подтверждения.",
    "Тармақ нөмірін немесе сұрауды жазыңыз: «Бүгінгі тапсырмалар», «Айбек клиентін тап». Қайту: «Мәзір». Өзгерістер растаудан кейін орындалады.")].join("\n");
}
export function quickControlCommand(text: string): ChatCommand | null {
  const t = text.trim().toLowerCase().replace(/[?!.]+$/g, "");
  const index = /^[1-6]$/.test(t) ? Number(t) - 1 : -1;
  if (index >= 0 && ![4, 5].includes(index)) return { action: menuItems[index][0] };
  const exact: Record<string, ChatCommand["action"]> = {
    "сводка": "GET_BUSINESS_SUMMARY", "сводка за сегодня": "GET_BUSINESS_SUMMARY", "бүгінгі қорытынды": "GET_BUSINESS_SUMMARY",
    "что требует внимания": "GET_SITUATION", "ситуация": "GET_SITUATION", "назар аудару керек": "GET_SITUATION",
    "задачи": "GET_TASKS", "тапсырмалар": "GET_TASKS", "задачи на сегодня": "GET_TODAY_TASKS", "бүгінгі тапсырмалар": "GET_TODAY_TASKS",
    "просроченные задачи": "GET_OVERDUE_TASKS", "мерзімі өткен тапсырмалар": "GET_OVERDUE_TASKS", "продажи": "GET_DEALS_STATS", "сатылымдар": "GET_DEALS_STATS",
    "команда": "GET_TEAM_STATUS", "новые заявки": "GET_RECENT_LEADS", "жаңа өтінімдер": "GET_RECENT_LEADS", "клиенты": "GET_CLIENTS", "клиенттер": "GET_CLIENTS",
  };
  if (exact[t]) return { action: exact[t] };
  const find = text.match(/^(?:найди(?:те)? (?:клиента|контакт)|клиентті тап|клиент іздеу)\s+(.+)$/i);
  if (find) return { action: "FIND_CLIENT", query: find[1].trim() };
  const kazFind = text.match(/^(.+?)\s+клиентін тап$/i);
  if (kazFind) return { action: "FIND_CLIENT", query: kazFind[1].trim() };
  // Task requests always use the structured parser, including text after a colon:
  // it can contain a deadline, customer or assignee, not just a literal title.
  return null;
}
