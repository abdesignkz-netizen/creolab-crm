import type { ControlProfile } from "@creolab/contracts";
import { controlPeriodPhrase, quickControlCommand } from "./controlChatLanguage.ts";

export type ControlPlanRequest = {
  profile: ControlProfile; mode: "analyze" | "plan"; causal: boolean;
  period: NonNullable<ReturnType<typeof controlPeriodPhrase>>; dueAt?: string;
};
export type ControlPlanIntent = ControlPlanRequest | { clarification: string };
const clarify = (clarification: string): ControlPlanIntent => ({ clarification });
const topicHelp = "Уточните направление: бизнес, продажи, оплаты, команда или обращения. Например: «Разбери продажи за неделю» или «Подготовь план действий по обращениям».";
const topics: Array<[ControlProfile, RegExp]> = [
  ["business", /^(?:бизнес[ау]?|компании|бизнесті|бизнес)$/u],
  ["sales", /^(?:продаж(?:а|и|у|ы|ам)?|сатылымдар(?:ды)?|сату)$/u],
  ["finance", /^(?:оплат(?:а|ы|у|ам)?|финанс(?:ы|ов)?|поступлени[яй]|төлемдер(?:ді)?)$/u],
  ["team", /^(?:команд[аыуе]|задач(?:а|и|ам)?|команданы|тапсырмалар(?:ды)?)$/u],
  ["service", /^(?:обращени(?:я|й|ям)|заяв(?:ки|ок|кам)|клиентского сервиса|өтінімдер(?:ді)?)$/u],
];

/** Match whole requests. Unknown modifiers must not silently broaden scope. */
export function controlPlanIntent(raw: string, timezone: string, now = new Date()): ControlPlanIntent | null {
  const text = raw.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").replace(/[?!.,]+$/g, "").trim()
    .replace(/^(?:пожалуйста,? |можешь |можно )/, "");
  if (/^план продаж(?: |$)/u.test(text)) return clarify("Вы хотите посмотреть выполнение плана продаж или подготовить действия? Напишите «Прогноз продаж на месяц» либо «Подготовь план действий по продажам».");
  if (/^(?:организуй|спланируй)(?: |$)/u.test(text) || /^(?:ертеңгі күнді жоспарла|жоспар құр)$/u.test(text)) return clarify(topicHelp);
  let mode: "analyze" | "plan" = "analyze", body: string | undefined, causal = false;
  const plan = text.match(/^(?:(?:составь|подготовь|предложи) )?план(?: действий| работы)?(?: по| для)?(?: (.+))?$/u);
  const analysis = text.match(/^(?:анализ|обзор|разбор|разбери|проанализируй|оцени|как улучшить)(?: (.+))?$/u);
  const why = text.match(/^почему (?:упали|падают|снизились|снижаются) (продажи.*)$/u);
  const kk = text.match(/^(.+?) (талда|талдау|бойынша жоспар құр)$/u);
  if (plan) { mode = "plan"; body = plan[1]; }
  else if (analysis) body = analysis[1];
  else if (why) { body = why[1]; causal = true; }
  else if (kk) { body = kk[1]; mode = kk[2] === "бойынша жоспар құр" ? "plan" : "analyze"; }
  else return null;
  if (!body) return clarify(topicHelp);
  let period: ControlPlanRequest["period"] = { period: "last_7" }, dueAt: string | undefined;
  const date = body.match(/\s+(за .+|с \d{4}-\d{2}-\d{2} по \d{4}-\d{2}-\d{2})$/u);
  if (date) {
    const parsed = controlPeriodPhrase(date[1].replace(/^за /, ""));
    if (!parsed) return clarify("Уточните период анализа: сегодня, вчера, эта неделя, прошлый месяц или «с 2026-11-01 по 2026-11-02».");
    period = parsed; body = body.slice(0, date.index).trim();
  }
  const kkPeriod = body.match(/^(бүгін|кеше|осы апта|өткен апта|осы ай|өткен ай) (.+)$/u);
  if (kkPeriod) { period = controlPeriodPhrase(kkPeriod[1])!; body = kkPeriod[2]; }
  if (mode === "plan") {
    // Explicit time only; never silently substitute a deadline for an ambiguous day.
    const due = body.match(/\s+(?:на )?((?:сегодня|завтра|послезавтра|бүгін|ертең|бүрсігүні|\d{1,2}\.\d{1,2}(?:\.\d{4})?) (?:в|к|сағат) \d{1,2}:\d{2})$/u);
    if (due) {
      const phrase = due[1].replace("бүрсігүні", "послезавтра").replace("ертең", "завтра").replace("бүгін", "сегодня").replace("сағат", "в");
      try { dueAt = quickControlCommand(`Создай задачу Проверка ${phrase}`, timezone, now)?.dueAt; } catch { /* invalid day or time */ }
      if (!dueAt || new Date(dueAt) <= now) return clarify("Укажите существующую будущую дату и время срока задачи в часовом поясе компании.");
      body = body.slice(0, due.index).trim();
    } else if (/(?:завтра|сегодня|послезавтра|ертең|бүгін|бүрсігүні|\d{1,2}[.:]\d{2})/u.test(body)) return clarify("Укажите направление и точное время. Например: «Подготовь план действий по команде завтра в 15:00». Срок будет в часовом поясе компании.");
  }
  const profile = topics.find(([, pattern]) => pattern.test(body!))?.[0];
  if (!profile) return clarify(`${topicHelp} Для конкретного клиента сначала используйте «Найди клиента»; имя или часть команды не будут выбраны автоматически.`);
  return { profile, mode, causal, period, ...(dueAt ? { dueAt } : {}) };
}

/** Preserve the reviewed period when the reader asks to prepare the suggested plan. */
export function controlPlanFollowup(request: ControlPlanRequest) {
  const topic = { business: "бизнесу", sales: "продажам", finance: "оплатам", team: "команде", service: "обращениям" }[request.profile];
  const periods = { today: "сегодня", yesterday: "вчера", this_week: "эту неделю", last_week: "прошлую неделю", last_7: "последние 7 дней", last_30: "последние 30 дней", this_month: "этот месяц", last_month: "прошлый месяц", this_year: "этот год", all: "всё время" };
  const period = request.period.period === "custom" ? `с ${request.period.dateFrom} по ${request.period.dateTo}` : `за ${periods[request.period.period || "last_7"]}`;
  return `Подготовь план действий по ${topic} ${period}`;
}
