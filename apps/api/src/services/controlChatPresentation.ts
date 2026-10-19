import type { ControlAction } from "@creolab/contracts";
import { CONTROL_ACTION_META, validateClientPhone } from "@creolab/contracts";
import { config } from "../config.ts";
import { formatPhoneDisplay } from "./contactLabels.ts";
import { cleanText, words, type ChatLanguage } from "./controlChatLanguage.ts";
import { record } from "./controlChatSettings.ts";
export const controlLink = (path: string) => `${config.appBaseUrl.replace(/\/$/, "")}${path}`;
export function controlTaskClientLabel(item: Record<string, unknown>, lang: ChatLanguage) {
  const name = cleanText(item.contactName, 80).trim();
  const rawPhone = String(item.phone || "").trim();
  // WhatsApp LIDs and other channel identifiers are never telephone numbers.
  const parsed = /^[+\d\s().-]+$/.test(rawPhone) ? validateClientPhone(rawPhone) : null;
  const phone = parsed?.ok ? formatPhoneDisplay(parsed.e164) : null;
  if (!name && !phone) return words(lang, "Клиент не привязан или телефон не указан", "Клиент байланыстырылмаған немесе телефон көрсетілмеген");
  return `${words(lang, "Клиент", "Клиент")}: ${[name, phone || words(lang, "телефон не указан", "телефон көрсетілмеген")].filter(Boolean).join(" · ")}`;
}
export function presentControlReply(action: ControlAction, result: unknown, lang: ChatLanguage, timeZone: string) {
  const data = record(record(result).data), w = (ru: string, kk: string) => words(lang, ru, kk);
  const time = (v: unknown) => v && Number.isFinite(new Date(String(v)).getTime()) ? new Date(String(v)).toLocaleString(lang === "kk" ? "kk-KZ" : "ru-RU", { timeZone, dateStyle: "short", timeStyle: "short" }) : w("без срока", "мерзімсіз");
  const task = (item: any, i: number) => `${i + 1}. ${cleanText(item.title, 160)}\n${controlTaskClientLabel(item, lang)}\n${time(item.dueAt)}${item.overdue ? w(" · просрочено", " · мерзімі өткен") : ""}${item.ownerName ? ` · ${cleanText(item.ownerName, 50)}` : ""}`;
  const items: any[] = Array.isArray(data.items) ? data.items : [];
  const heading = lang === "ru" ? CONTROL_ACTION_META[action].label : ({GET_BUSINESS_SUMMARY:"Бизнес қорытындысы", GET_SITUATION:"Назар аудару керек", GET_TODAY_TASKS:"Бүгінгі тапсырмалар",GET_TASKS:"Тапсырмалар",GET_OVERDUE_TASKS:"Мерзімі өткен тапсырмалар",GET_CLIENT_DETAILS:"Клиент",GET_DEALS_STATS:"Сатылымдар",GET_LEADS_STATS:"Өтінімдер",GET_REVENUE_STATS:"Түсім",GET_TEAM_STATUS:"Команда"} as Record<string,string>)[action] || "BasQar Control";
  const lines: string[] = [heading];
  if (["GET_TASKS", "GET_OVERDUE_TASKS", "GET_TODAY_TASKS"].includes(action)) {
    if (action === "GET_TODAY_TASKS") {
      lines.push(`${w("На сегодня осталось", "Бүгін қалғаны")}: ${data.remaining ?? 0}. ${w("Просрочено", "Мерзімі өткен")}: ${data.overdue ?? 0}.`);
      lines.push(w("Ближайшие задачи:", "Жақын тапсырмалар:"));
    }
    const rows = action === "GET_TODAY_TASKS" ? data.nearest || [] : items;
    lines.push(...rows.slice(0, 8).map(task));
    if (!rows.length) lines.push(w("Задач нет.", "Тапсырмалар жоқ."));
    lines.push(controlLink("/tasks"));
  } else if (action === "GET_SITUATION") {
    const a = record(data.attention);
    for (const [key, ru, kk] of [["needsReply", "Ждут ответа", "Жауап күтіп отыр"], ["needsHuman", "Нужен сотрудник", "Қызметкер керек"], ["overdueTasks", "Просроченные задачи", "Мерзімі өткен тапсырмалар"], ["noNextAction", "Без следующего шага", "Келесі қадам жоқ"], ["stalledDeals", "Застрявшие сделки", "Тоқтап қалған мәмілелер"]]) lines.push(`${w(ru, kk)}: ${a[key] ?? 0}`);
    lines.push(controlLink("/today"));
  } else if (action === "GET_CLIENT_DETAILS") {
    const c = record(data.client);
    lines.push(cleanText(c.name), cleanText(c.phone || c.phoneNormalized || w("Телефон не указан", "Телефон көрсетілмеген")));
    if (c.companyName) lines.push(cleanText(c.companyName));
    if (c.lifecycleLabel) lines.push(cleanText(c.lifecycleLabel));
    lines.push(`${w("Задач", "Тапсырмалар")}: ${Array.isArray(data.tasks) ? data.tasks.length : 0}`, controlLink(`/contacts/${encodeURIComponent(String(c.id))}`));
  } else if (action === "GET_BUSINESS_SUMMARY" || action === "GET_DEALS_STATS" || action === "GET_LEADS_STATS" || action === "GET_REVENUE_STATS") {
    const labels: Array<[string, string, string]> = action === "GET_BUSINESS_SUMMARY" ? [["inquiries","Новые заявки","Жаңа өтінімдер"],["dealsCreated","Создано сделок","Құрылған мәмілелер"],["won","Успешных сделок","Сәтті мәмілелер"],["lost","Проигранных сделок","Жоғалған мәмілелер"]]
      : action === "GET_DEALS_STATS" ? [["created","Создано сделок","Құрылған мәмілелер"],["won","Успешных","Сәтті"],["lost","Проигранных","Жоғалған"]]
      : action === "GET_LEADS_STATS" ? [["total","Всего заявок","Барлық өтінімдер"],["new","Новые","Жаңа"],["inProgress","В работе","Жұмыста"],["needsReply","Ждут ответа","Жауап күтуде"]] : [];
    lines.push(...labels.map(([key, ru, kk]) => `${w(ru, kk)}: ${data[key] ?? 0}`));
    if (data.revenueLabel) lines.push(`${w("Выручка", "Түсім")}: ${cleanText(data.revenueLabel)}`);
    else if (data.revenue != null && typeof data.revenue === "number") lines.push(`${w("Выручка", "Түсім")}: ${data.revenue.toLocaleString("ru-RU")} ₸`);
    if (action === "GET_REVENUE_STATS" && data.revenue == null && !data.revenueLabel) lines.push(w("Данных о выручке пока нет.", "Түсім туралы деректер әзірге жоқ."));
    const period = String(record(result).meta?.period || "today");
    const periods: Record<string, [string,string]> = {today:["Сегодня","Бүгін"],yesterday:["Вчера","Кеше"],last_7:["Последние 7 дней","Соңғы 7 күн"],last_30:["Последние 30 дней","Соңғы 30 күн"],this_month:["Текущий месяц","Осы ай"],last_month:["Прошлый месяц","Өткен ай"]};
    lines.splice(1, 0, w(...(periods[period] || periods.today)));
    lines.push(controlLink("/stats"));
  } else if (CONTROL_ACTION_META[action].riskLevel !== "READ") {
    lines.push(w("Готово. Изменение сохранено.", "Дайын. Өзгеріс сақталды."));
    if (data.title) lines.push(cleanText(data.title));
    lines.push(controlLink(action.includes("TASK") || action.includes("FOLLOW_UP") ? "/tasks" : "/deals"));
  } else if (action === "GET_TEAM_STATUS") {
    const team = Array.isArray(data.team) ? data.team : [];
    lines.push(...team.slice(0, 8).map((r: any) => `${cleanText(r.name)}: ${w("в работе", "жұмыста")} ${r.inWork ?? 0}, ${w("требует внимания", "назар аудару керек")} ${r.attention ?? 0}, ${w("просрочено", "мерзімі өткен")} ${r.overdueTasks ?? 0}`));
    if (!team.length) lines.push(w("Нет доступных данных команды.", "Команданың қолжетімді деректері жоқ."));
    lines.push(controlLink("/today"));
  } else {
    const rows = items.length ? items : Array.isArray(data.stages) ? data.stages : Array.isArray(data.members) ? data.members : Array.isArray(data.team) ? data.team : [];
    const deal = record(data.deal);
    if (deal.id) lines.push(cleanText(deal.title), cleanText(record(deal.stage).name || deal.stage || ""), controlLink(`/deals/${encodeURIComponent(String(deal.id))}`));
    else {
      lines.push(...rows.slice(0,8).map((r: any, i: number) => `${i + 1}. ${cleanText(r.title || r.name || r.subject || w("Без названия", "Атаусыз"))}${r.phone ? ` · ${cleanText(r.phone)}` : ""}${r.count != null ? `: ${r.count}` : ""}`));
      if (!rows.length) lines.push(w("Записей не найдено.", "Жазбалар табылмады."));
      lines.push(controlLink(action.includes("CLIENT") ? "/contacts" : action.includes("LEAD") ? "/inquiries" : action.includes("TEAM") ? "/settings?section=team" : "/deals"));
    }
  }
  return lines.filter(Boolean).join("\n").slice(0, 3500);
}
