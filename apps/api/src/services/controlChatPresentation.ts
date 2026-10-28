import type { ControlAction } from "@creolab/contracts";
import { CONTROL_ACTION_META, validateClientPhone } from "@creolab/contracts";
import { config } from "../config.ts";
import { formatPhoneDisplay } from "./contactLabels.ts";
import { cleanText, words, DEAL_READ_ACTIONS, type ChatLanguage } from "./controlChatLanguage.ts";
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
  const task = (item: any, i: number) => `${i + 1}. ${cleanText(item.title, 160)}\n${controlTaskClientLabel(item, lang)}\n${data.taskStatus === "completed" ? `${w("Завершено", "Аяқталды")}: ${item.completedAt ? time(item.completedAt) : w("дата не указана", "күні көрсетілмеген")}` : time(item.dueAt)}${item.overdue ? w(" · просрочено", " · мерзімі өткен") : ""}${item.ownerName ? ` · ${cleanText(item.ownerName, 50)}` : ""}`;
  const items: any[] = Array.isArray(data.items) ? data.items : [];
  const heading = lang === "ru" ? CONTROL_ACTION_META[action].label : ({GET_BUSINESS_SUMMARY:"Бизнес қорытындысы", GET_SITUATION:"Назар аудару керек", GET_TODAY_TASKS:"Бүгінгі тапсырмалар",GET_TASKS:"Тапсырмалар",GET_OVERDUE_TASKS:"Мерзімі өткен тапсырмалар",GET_CLIENT_DETAILS:"Клиент",GET_DEALS_STATS:"Сатылымдар",GET_LEADS_STATS:"Өтінімдер",GET_REVENUE_STATS:"Сатылымдар мен төлемдер",GET_TEAM_STATUS:"Команда"} as Record<string,string>)[action] || "BasQar Control";
  const lines: string[] = [heading];
  const meta = record(record(result).meta);
  const periodNames: Record<string, [string, string]> = { today: ["Сегодня", "Бүгін"], yesterday: ["Вчера", "Кеше"], this_week: ["Эта неделя · пн–вс", "Осы апта · дс–жс"], last_week: ["Прошлая неделя · пн–вс", "Өткен апта · дс–жс"], last_7: ["Последние 7 дней", "Соңғы 7 күн"], last_30: ["Последние 30 дней", "Соңғы 30 күн"], this_month: ["Текущий месяц", "Осы ай"], last_month: ["Прошлый месяц", "Өткен ай"], this_year: ["Этот год", "Осы жыл"], all: ["Без ограничения периода", "Кезең шектеусіз"], custom: ["Период", "Кезең"] };
  const periodText = () => {
    const key = String(meta.period || "today");
    const name = periodNames[key] ? w(...periodNames[key]) : w("Период не указан", "Кезең көрсетілмеген");
    const dates = meta.dateFrom && meta.dateTo ? ` · ${cleanText(meta.dateFrom, 10)} — ${cleanText(meta.dateTo, 10)}` : "";
    return `${name}${dates}${meta.timeZone ? ` (${cleanText(meta.timeZone, 60)})` : ""}`;
  };
  const totalLine = (shown: number) => typeof data.total === "number" ? w(`Найдено: ${data.total}. Показано: ${shown}.`, `Табылды: ${data.total}. Көрсетілді: ${shown}.`) : "";
  if (DEAL_READ_ACTIONS.some(value => value === action)) {
    const labels: Record<string, string> = {
      GET_UNCHANGED_DEALS: "Өзгеріссіз мәмілелер", GET_PROPOSALS_WITHOUT_FOLLOWUP: "Ұсыныстан кейінгі байланыс жоспарланбаған",
      GET_LOST_REASONS: "Мәмілелерді жоғалту себептері", GET_EXPECTED_PAYMENTS: "Күтілетін төлемдер",
    };
    if (lang === "kk") lines[0] = labels[action];
    if (action !== "GET_UNCHANGED_DEALS") lines.push(periodText());
    lines.push(data.ownerName ? `${w("Ответственный", "Жауапты")}: ${cleanText(data.ownerName, 80)}` : data.scope === "team" ? w("Вся команда компании", "Компанияның бүкіл командасы") : w("В пределах вашего доступа", "Сіздің рұқсатыңыз шегінде"));
    if (action === "GET_UNCHANGED_DEALS") {
      lines.push(w(`Без изменений ${data.inactiveDays} дней и более.`, `${data.inactiveDays} күн және одан көп өзгеріссіз.`));
      lines.push(data.changeBasis === "stage" ? w("Проверяется только смена этапа.", "Тек кезең ауысуы тексеріледі.") : w("Учитываются изменения карточки и связанные сообщения, задачи, документы и договорённости.", "Карточка өзгерістері және байланысты хабарламалар, тапсырмалар, құжаттар мен келісімдер ескеріледі."));
      lines.push(`${w("С", "Бастап")}: ${time(data.cutoff)}. ${w("Проверено", "Тексерілді")}: ${time(data.checkedAt)} (${cleanText(timeZone, 50)}).`);
    } else if (action === "GET_PROPOSALS_WITHOUT_FOLLOWUP") {
      lines.push(w("КП отправлено за указанный период. Следующий контакт со сроком не запланирован или просрочен.", "Ұсыныс көрсетілген кезеңде жіберілген. Келесі байланыс мерзімі жоспарланбаған немесе өтіп кеткен."));
      lines.push(`${w("Клиентов", "Клиенттер")}: ${data.clientCount ?? 0}. ${w("Сделок", "Мәмілелер")}: ${data.total ?? 0}.`);
      if (data.uncertainCount) {
        lines.push(w(`Отдельно требуют проверки: ${data.uncertainCount}. Есть будущий шаг, но из описания неясно, запланирован ли контакт. В итог выше не включены.`, `Бөлек тексеру қажет: ${data.uncertainCount}. Болашақ қадам бар, бірақ сипаттамадан байланыс жоспарланғаны анық емес. Жоғарыдағы санға кірмейді.`));
        for (const row of (data.uncertainItems || []).slice(0, 2)) lines.push(`${cleanText(row.title, 70)} · ${cleanText(row.nextAction, 100)} · ${time(row.nextActionAt)}\n${controlLink(`/deals/${encodeURIComponent(String(row.id))}`)}`);
      }
    } else if (action === "GET_LOST_REASONS") {
      lines.push(w(`Закрыто с проигрышем: ${data.total ?? 0}. Без причины: ${data.missingReasonCount ?? 0}.`, `Жоғалтумен жабылды: ${data.total ?? 0}. Себепсіз: ${data.missingReasonCount ?? 0}.`));
      lines.push(w("Период относится к дате закрытия сделки.", "Кезең мәміленің жабылған күніне қатысты."));
    } else {
      lines.push(w("По срокам выставленных счетов и подтверждённым обещаниям оплаты. Суммы не складываются: один платёж может относиться к обоим основаниям.", "Ұсынылған шоттардың мерзімдері және расталған төлем уәделері бойынша. Бір төлем екі негізге де қатысты болуы мүмкін, сондықтан сомалар қосылмайды."));
      if (data.reconciliationCount) lines.push(w(`В ${data.reconciliationCount} сделках нужно сверить уже внесённые платежи.`, `${data.reconciliationCount} мәміледе енгізілген төлемдерді салыстыру керек.`));
    }
    const rowText = (r: any, i: number) => {
      if (action === "GET_LOST_REASONS") return `${i + 1}. ${cleanText(r.reason || w("Причина не указана", "Себеп көрсетілмеген"), 180)}: ${r.count} (${r.share}%)`;
      const result = [`${i + 1}. ${cleanText(r.title, 120)}`, controlTaskClientLabel(r, lang)];
      if (action === "GET_UNCHANGED_DEALS") result.push(`${w("Этап", "Кезең")}: ${cleanText(r.stage, 80)} · ${w("с", "бастап")} ${time(r.stageEnteredAt)}`);
      if (action === "GET_PROPOSALS_WITHOUT_FOLLOWUP") result.push(`${w("КП отправлено", "Ұсыныс жіберілді")}: ${time(r.sentAt)}`);
      if (action === "GET_EXPECTED_PAYMENTS") {
        for (const source of r.sources || []) result.push(`${source.type === "invoice" ? w("Счёт", "Шот") : w("Обещание оплаты", "Төлем уәдесі")}: ${cleanText(source.title, 70)} · ${time(source.dueAt)}`);
        if (r.sourceCount > (r.sources || []).length) result.push(w(`Ещё оснований: ${r.sourceCount - r.sources.length}.`, `Тағы негіздер: ${r.sourceCount - r.sources.length}.`));
        if (r.needsReconciliation) result.push(w("Остаток требует сверки платежей.", "Қалдық төлемдерді салыстыруды қажет етеді."));
      }
      if (r.ownerName) result.push(`${w("Ответственный", "Жауапты")}: ${cleanText(r.ownerName, 50)}`);
      result.push(controlLink(`/deals/${encodeURIComponent(String(r.id))}`));
      return result.join("\n");
    };
    const footer = controlLink("/deals"), displayed: string[] = [];
    // Keep counts and navigation intact even when names or evidence descriptions are long.
    for (const [i, row] of items.slice(0, action === "GET_LOST_REASONS" ? 8 : 6).entries()) {
      const text = rowText(row, i);
      if ([...lines, ...displayed, text, footer].join("\n\n").length > 3250) break;
      displayed.push(text);
    }
    const count = action === "GET_LOST_REASONS" ? w(`Причин: ${data.reasonCount ?? 0}. Показано: ${displayed.length}.`, `Себептер: ${data.reasonCount ?? 0}. Көрсетілді: ${displayed.length}.`)
      : w(`Сделок: ${data.total ?? 0}. Показано: ${displayed.length}.`, `Мәмілелер: ${data.total ?? 0}. Көрсетілді: ${displayed.length}.`);
    return [...lines, count, ...displayed, ...(!items.length ? [w("Подходящих записей нет.", "Сәйкес жазбалар жоқ.")] : []), footer].filter(Boolean).join("\n\n");
  }
  if (["GET_TASKS", "GET_OVERDUE_TASKS", "GET_TODAY_TASKS", "GET_RECENT_LEADS", "GET_RECENT_DEALS"].includes(action)) {
    lines.push(periodText());
    lines.push(data.ownerName ? `${w("Ответственный", "Жауапты")}: ${cleanText(data.ownerName)}` : data.scope === "team" ? w("Вся команда компании", "Компанияның бүкіл командасы") : w("В пределах вашего доступа", "Сіздің рұқсатыңыз шегінде"));
  }
  if (["GET_TASKS", "GET_OVERDUE_TASKS", "GET_TODAY_TASKS"].includes(action)) {
    if (action === "GET_TASKS") lines.push(data.taskStatus === "completed" ? w("Завершённые задачи", "Аяқталған тапсырмалар") : data.taskStatus === "all" ? w("Все статусы задач", "Барлық күйдегі тапсырмалар") : w("Незавершённые задачи", "Аяқталмаған тапсырмалар"));
    if (action === "GET_TODAY_TASKS") {
      lines.push(`${w("На сегодня осталось", "Бүгін қалғаны")}: ${data.remaining ?? 0}. ${w("Просрочено", "Мерзімі өткен")}: ${data.overdue ?? 0}.`);
      lines.push(w("Задачи со сроком на сегодня:", "Мерзімі бүгінгі тапсырмалар:"));
    }
    const rows = action === "GET_TODAY_TASKS" ? data.nearest || [] : items;
    lines.push(totalLine(Math.min(rows.length, 8)));
    lines.push(...rows.slice(0, 8).map(task));
    if (!rows.length) lines.push(w("Задач нет.", "Тапсырмалар жоқ."));
    if (action !== "GET_TODAY_TASKS") lines.push(data.taskStatus === "completed" ? w("Период относится к дате завершения задачи.", "Кезең тапсырманың аяқталған күніне қатысты.") : w("Период относится к сроку задачи.", "Кезең тапсырма мерзіміне қатысты."));
    lines.push(controlLink("/tasks"));
  } else if (action === "GET_SALES_CONTROL") {
    lines.push(`${w("Цель", "Мақсат")}: ${cleanText(data.goalLabel)}`);
    lines.push(`${w("Активных сделок", "Белсенді мәмілелер")}: ${data.summary?.active || 0}`);
    const filterLabels: Record<string, string> = { attention: w("Нужно участие", "Қатысу қажет"), ready: w("Близки к покупке", "Сатып алуға жақын"), goal: w("Цель достигнута", "Мақсат орындалды") };
    if (filterLabels[data.filter]) lines.push(`${filterLabels[data.filter]}: ${items.length}`);
    if (data.limited) lines.push(w("Подробности по первым 200 сделкам.", "Алғашқы 200 мәміленің деректері."));
    lines.push(...items.slice(0, 6).map((r: any, i: number) => `${i + 1}. ${cleanText(r.contactName)}${r.phone ? ` · ${cleanText(r.phone)}` : ""} — ${cleanText(r.title)}\n${cleanText(r.stage)}. ${r.goalReached ? w("Цель достигнута", "Мақсат орындалды") : r.closeToSale ? w("Заказ на завершающем этапе", "Тапсырыс аяқталуға жақын") : ""}\n${w("Следующий шаг", "Келесі қадам")}: ${cleanText(r.nextAction || "Не запланирован")}\n${(r.blockers || []).map((b: string) => cleanText(b)).join("; ")}`));
    if (data.proposals?.length) lines.push(`${w("Предложений создать сделку", "Мәміле құру ұсыныстары")}: ${data.proposals.length}`);
    if (!items.length) lines.push(data.filter && data.filter !== "all" ? w("Подходящих сделок нет.", "Сәйкес мәмілелер жоқ.") : w("Активных сделок нет.", "Белсенді мәмілелер жоқ."));
    lines.push(controlLink(`/control?view=sales&filter=${encodeURIComponent(data.filter || "all")}`));
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
    if (data.conversionBasis === "won_over_closed") lines.push(`${w("Успешность закрытых сделок", "Жабылған мәмілелердің сәттілік үлесі")}: ${data.conversion == null ? "—" : `${data.conversion}%`} (${data.won ?? 0} / ${data.closedDeals ?? 0})`);
    if (data.plan) {
      const plan = data.plan;
      if (plan.status === "ready") {
        lines.push(`${w("План продаж за выбранный период", "Таңдалған кезеңнің сату жоспары")}: ${cleanText(plan.label)}; ${w("факт", "нақты")}: ${cleanText(plan.actual?.label || "—")}; ${plan.percent == null ? "—" : `${plan.percent}%`}`);
        if (plan.prorated) lines.push(w("Для неполного месяца план рассчитан по доле календарных дней.", "Толық емес ай үшін жоспар күнтізбелік күндер үлесімен есептелген."));
        if (plan.missingAmounts) lines.push(w("Процент не рассчитан: есть продажи без суммы.", "Пайыз есептелмеді: сомасы жоқ сатылымдар бар."));
        else if (plan.exact === "0") lines.push(w("Процент не рассчитан: план равен нулю.", "Пайыз есептелмеді: жоспар нөлге тең."));
      } else if (plan.status === "filtered") lines.push(w("Общий план компании не сравнивается с отфильтрованной частью продаж.", "Компанияның жалпы жоспары сүзілген сатылымдар бөлігімен салыстырылмайды."));
      else if (plan.status === "unbounded") lines.push(w("Для плана выберите период с началом и концом.", "Жоспар үшін басы мен соңы бар кезеңді таңдаңыз."));
      else if (plan.status === "legacy") lines.push(w("Прежний план не привязан к месяцу. Задайте месячные планы в настройках.", "Бұрынғы жоспар айға байланыстырылмаған. Баптауларда айлық жоспарларды енгізіңіз."));
      else lines.push(w(`План не задан на месяцы: ${(plan.missingMonths || []).slice(0, 12).join(", ")} (${cleanText(plan.currency)}).`, `Мына айларға жоспар берілмеген: ${(plan.missingMonths || []).slice(0, 12).join(", ")} (${cleanText(plan.currency)}).`));
    }
    const sales = Array.isArray(data.salesByCurrency) ? data.salesByCurrency : [];
    const receipts = Array.isArray(data.receiptsByCurrency) ? data.receiptsByCurrency : [];
    if (sales.length) for (const row of sales) {
      lines.push(`${w("Сумма продаж", "Сатылым сомасы")}: ${cleanText(row.label || `— ${row.currency}`)}`);
      if (row.missing) lines.push(`${w("Сделок без суммы", "Сомасы жоқ мәмілелер")}: ${row.missing} (${cleanText(row.currency)})`);
    }
    else if (data.revenueLabel) lines.push(`${w("Сумма продаж", "Сатылым сомасы")}: ${cleanText(data.revenueLabel)}`);
    else if (typeof data.revenue === "number") {
      const currency = cleanText(data.currency || "KZT");
      lines.push(`${w("Сумма продаж", "Сатылым сомасы")}: ${data.revenue.toLocaleString("ru-RU")} ${currency === "KZT" ? "₸" : currency}`);
    }
    if (receipts.length) for (const row of receipts) lines.push(`${w("Подтверждённые оплаты", "Расталған төлемдер")}: ${cleanText(row.label)}`);
    else if (data.receiptsLabel) lines.push(`${w("Подтверждённые оплаты", "Расталған төлемдер")}: ${cleanText(data.receiptsLabel)}`);
    if (action === "GET_REVENUE_STATS" && !sales.length && data.revenue == null && !data.revenueLabel) lines.push(w("Продаж с указанной суммой за период нет.", "Кезеңде сомасы көрсетілген сатылымдар жоқ."));
    lines.splice(1, 0, periodText());
    if (data.receiptsLabel || data.revenueLabel || sales.length) lines.push(w("Продажи — по дате закрытия сделки. Оплаты — по дате подтверждения платежа. Валюты не суммируются.", "Сатылымдар мәміленің жабылған күнімен, төлемдер расталған күнімен есептеледі. Валюталар қосылмайды."));
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
  } else if (action === "GET_RECENT_LEADS" || action === "GET_RECENT_DEALS") {
    if (data.leadFilter === "needs_reply") lines.push(w("Получены за указанный период и сейчас ожидают ответа.", "Көрсетілген кезеңде түскен және қазір жауап күтіп отырған өтінімдер."));
    else lines.push(w("Период относится к дате поступления заявки или создания сделки.", "Кезең өтінім түскен немесе мәміле құрылған күнге қатысты."));
    lines.push(totalLine(Math.min(items.length, 8)));
    lines.push(...items.slice(0, 8).map((r: any, i: number) => `${i + 1}. ${cleanText(r.title || r.subject || w("Без темы", "Тақырыпсыз"), 120)}\n${controlTaskClientLabel({ contactName: r.contactName || r.name, phone: r.phone }, lang)}\n${time(r.receivedAt || r.createdAt)}`));
    if (!items.length) lines.push(w("Подходящих записей нет.", "Сәйкес жазбалар жоқ."));
    lines.push(controlLink(action === "GET_RECENT_LEADS" ? "/inquiries" : "/deals"));
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
