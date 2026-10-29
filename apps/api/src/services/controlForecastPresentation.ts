import type { SalesForecast } from "@creolab/contracts";
import { cleanText, words, type ChatLanguage } from "./controlChatLanguage.ts";

/** Only formats a verified read result; the model never supplies these figures. */
export function presentControlForecast(f: SalesForecast | undefined, lang: ChatLanguage, link: string) {
  const w = (ru: string, kk: string) => words(lang, ru, kk);
  const lines = [w("Прогноз продаж на месяц", "Айлық сату болжамы")];
  if (!f || f.status === "unavailable") return [...lines,
    w("Расчёт временно недоступен. Повторите запрос позже — отсутствие данных не означает нулевые продажи.", "Есеп уақытша қолжетімсіз. Кейін қайталаңыз — деректердің болмауы сатылым нөлге тең дегенді білдірмейді."), link].join("\n");
  if (f.status === "unsupported_period") return [...lines,
    w("Прогноз доступен только на текущий месяц. Напишите «Прогноз продаж на этот месяц».", "Болжам тек осы айға қолжетімді. «Осы айдың сату болжамы» деп жазыңыз."), link].join("\n");
  const locale = lang === "kk" ? "kk-KZ" : "ru-RU";
  const date = (value: string, time = false) => new Date(value).toLocaleString(locale, {
    timeZone: f.timeZone, dateStyle: "short", ...(time ? { timeStyle: "short" as const } : {}),
  });
  lines.push(`${date(f.from)} — ${date(new Date(new Date(f.to).getTime() - 1).toISOString())}`,
    `${w("Рассчитано", "Есептелді")}: ${date(f.asOf, true)} (${cleanText(f.timeZone, 60)}).`,
    w(`Источник: успешные сделки по дате закрытия, ${f.currency}. Это продажи, не поступление денег.`, `Дереккөз: жабылған күні бойынша сәтті мәмілелер, ${f.currency}. Бұл сатылым, ақшаның түсуі емес.`));
  const e = f.evidence;
  if (f.status === "insufficient_history") {
    lines.push(w(`Истории недостаточно: полных месяцев ${e.months} из необходимых ${e.requiredMonths}, продаж ${e.sales} из необходимых ${e.requiredSales}. Оценка пока не рассчитывается.`,
      `Тарих жеткіліксіз: қажет ${e.requiredMonths} толық айдың ${e.months}-і, қажет ${e.requiredSales} сатылымның ${e.sales}-і бар. Баға әзірге есептелмейді.`));
  } else if (f.status === "incomplete_data") {
    lines.push(w("Прогноз не рассчитан: сначала исправьте неполные или ошибочные данные сделок.", "Болжам есептелмеді: алдымен мәмілелердің толық емес не қате деректерін түзетіңіз."));
    for (const [count, ru, kk] of [
      [e.missingAmounts, "Без суммы", "Сомасыз"], [e.missingClosedDates, "Без даты закрытия", "Жабылу күнісіз"],
      [e.negativeAmounts, "Отрицательная сумма", "Теріс сома"], [e.futureClosedDates, "Закрытие в будущем", "Болашақта жабылу"],
    ] as const) if (count) lines.push(`${w(ru, kk)}: ${count}.`);
  } else {
    const money = (value: { label: string | null }) => cleanText(value.label || "—", 120);
    lines.push(`${w("Продажи на сейчас", "Қазіргі сатылым")}: ${money(f.actual)}.`,
      `${w("Оценка к концу месяца", "Ай соңындағы баға")}: ${money(f.estimate)}.`,
      `${w("Нижний / верхний сценарий", "Төменгі / жоғарғы сценарий")}: ${money(f.range.low)} / ${money(f.range.high)}.`,
      w("Сценарии не задают вероятность результата и не гарантируют продажу.", "Сценарийлер нәтиженің ықтималдығын белгілемейді және сатылымға кепілдік бермейді."));
    const target = f.target;
    if (target.amount.exact !== null) lines.push(`${w("План на полный месяц", "Толық айдың жоспары")}: ${money(target.amount)}${target.estimatedPercent == null ? "" : ` · ${w("оценка выполнения", "болжалды орындалуы")}: ${target.estimatedPercent}%`}.`);
    const targetWords: Record<SalesForecast["target"]["status"], [string, string]> = {
      unavailable: ["", ""], filtered: ["Общий план не сравнивается с частью продаж.", "Жалпы жоспар сатылымның бөлігімен салыстырылмайды."],
      not_set: ["План на этот месяц не задан.", "Осы айдың жоспары берілмеген."],
      zero_target: ["План равен нулю; процент не рассчитывается.", "Жоспар нөлге тең; пайыз есептелмейді."],
      achieved: ["План уже достигнут по зарегистрированным продажам.", "Тіркелген сатылымдар бойынша жоспар орындалды."],
      below_range: ["Есть риск невыполнения плана: даже верхний сценарий ниже плана.", "Жоспарды орындамау қаупі бар: жоғарғы сценарий де жоспардан төмен."],
      at_risk: ["Есть риск невыполнения плана: базовая оценка ниже плана.", "Жоспарды орындамау қаупі бар: негізгі баға жоспардан төмен."],
      within_range: ["Базовая оценка достигает плана, нижний сценарий остаётся ниже него.", "Негізгі баға жоспарға жетеді, төменгі сценарий одан төмен."],
      range_above_plan: ["Оба сценария достигают плана; это не гарантия выполнения.", "Екі сценарий де жоспарға жетеді; бұл орындалу кепілдігі емес."],
    };
    lines.push(w(...targetWords[target.status]));
    if (target.status === "at_risk" || target.status === "below_range") {
      lines.push(`${w("Не хватает до плана по базовой оценке", "Негізгі баға бойынша жоспарға жетпейтін сома")}: ${money(target.estimatedGap)}.`,
        w("Проверьте открытые сделки и ближайшие действия. Запрос: «Продажи под контролем».", "Ашық мәмілелер мен келесі әрекеттерді тексеріңіз. Сұрау: «Бақылаудағы сатылымдар»."));
    }
    const d = f.deviation;
    if (d.status === "below" || d.status === "above") lines.push(d.status === "below"
      ? w(`Продажи ниже обычного темпа на ${Math.abs(d.percent!)}%.`, `Сатылым әдеттегі қарқыннан ${Math.abs(d.percent!)}% төмен.`)
      : w(`Продажи выше обычного темпа на ${Math.abs(d.percent!)}%.`, `Сатылым әдеттегі қарқыннан ${Math.abs(d.percent!)}% жоғары.`));
    lines.push(w(`Метод: факт + медианный дневной темп за ${e.months} полных месяцев × оставшиеся календарные дни (${f.remainingDays.toFixed(2)}). Продаж в истории: ${e.sales}.`,
      `Әдіс: нақты сома + ${e.months} толық айдың медианалық күндік қарқыны × қалған күнтізбелік күндер (${f.remainingDays.toFixed(2)}). Тарихтағы сатылым: ${e.sales}.`),
      w("Нижний и верхний сценарии используют минимальный и максимальный дневной темп этих месяцев.", "Төменгі және жоғарғы сценарийлер осы айлардың ең төмен және ең жоғары күндік қарқынын пайдаланады."));
    const validation = f.validation;
    lines.push(validation.periods.length
      ? w(`Проверка метода на начале прошлых месяцев: ${validation.periods.length}. Средняя абсолютная ошибка: ${money(validation.meanAbsoluteError)}. Это более длинный горизонт, чем оценка внутри месяца.`,
        `Әдіс өткен айлардың басында тексерілді: ${validation.periods.length}. Орташа абсолюттік қате: ${money(validation.meanAbsoluteError)}. Бұл ай ішіндегі бағадан ұзағырақ кезең.`)
      : w("Для проверки метода на прошлых месяцах пока мало истории.", "Әдісті өткен айларда тексеруге тарих әзірге жеткіліксіз."));
    lines.push(w("Открытые сделки, оплаты, сезонность и изменения рекламы не предсказываются. Неполная история снижает надёжность оценки.",
      "Ашық мәмілелер, төлемдер, маусымдылық және жарнама өзгерістері болжанбайды. Толық емес тарих бағаның сенімділігін төмендетеді."));
  }
  if (e.otherCurrencySales) lines.push(w(`В другой валюте: ${e.otherCurrencySales} продаж; в прогноз не включены.`, `Басқа валютада ${e.otherCurrencySales} сатылым бар; болжамға қосылмаған.`));
  return [...lines, link].filter(Boolean).join("\n");
}
