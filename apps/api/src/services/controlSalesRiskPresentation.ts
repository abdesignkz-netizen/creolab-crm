import { dealRiskAction, dealRiskLabel, type DealRisk } from "@creolab/contracts";
import { cleanText, words, type ChatLanguage } from "./controlChatLanguage.ts";

export function presentSalesControl(data: Record<string, any>, lang: ChatLanguage, timeZone: string, link: (path: string) => string) {
  const w = (ru: string, kk: string) => words(lang, ru, kk);
  const time = (value: string) => new Date(value).toLocaleString(lang === "kk" ? "kk-KZ" : "ru-RU", { timeZone, dateStyle: "short", timeStyle: "short" });
  const items = Array.isArray(data.items) ? data.items : [];
  const labels: Record<string, string> = { attention: w("Нужно участие", "Қатысу қажет"), ready: w("Близки к покупке", "Сатып алуға жақын"), goal: w("Цель достигнута", "Мақсат орындалды") };
  const lines = [w("Продажи под контролем", "Бақылаудағы сатылымдар"), `${w("Активных сделок", "Белсенді мәмілелер")}: ${data.summary?.active || 0}`];
  if (data.goalLabel) lines.push(`${w("Цель сопровождения", "Сүйемелдеу мақсаты")}: ${cleanText(data.goalLabel, 100)}`);
  if (data.checkedAt) lines.push(`${w("Проверено", "Тексерілді")}: ${time(data.checkedAt)} · ${timeZone}`);
  if (labels[data.filter]) lines.push(`${labels[data.filter]}: ${data.pagination?.total ?? items.length}`);
  if (data.coverage?.complete) lines.push(w(`Проверены все доступные активные сделки: ${data.coverage.checked}.`, `Барлық қолжетімді белсенді мәмілелер тексерілді: ${data.coverage.checked}.`));
  else if (data.limited) lines.push(w("Оценка относится только к показанной выборке.", "Баға тек көрсетілген іріктемеге қатысты."));
  let shown = 0;
  for (const row of items.slice(0, 6)) {
    const risk = row.risk as DealRisk | undefined, rec = risk?.recommendation;
    const priority = risk?.priority === "urgent" ? w("Срочно", "Шұғыл") : risk?.priority === "on_hold" ? w("На паузе", "Кідіртілген") : risk?.priority === "attention" ? w("Требует внимания", "Назар аудару қажет") : w("По плану", "Жоспар бойынша");
    const block = [`${shown + 1}. ${cleanText(row.contactName, 60)}${row.phone ? ` · ${cleanText(row.phone, 25)}` : ""} — ${cleanText(row.title, 80)}`,
      `${priority} · ${cleanText(row.stage, 50)}`];
    if (row.goalReached) block.push(w("Цель сопровождения достигнута.", "Сүйемелдеу мақсаты орындалды."));
    if (risk?.signals.length) block.push(`${w("Почему", "Неге")}: ${risk.signals.slice(0, 2).map(s => `${dealRiskLabel(s.code, lang)}${s.at ? ` (${time(s.at)})` : ""}`).join("; ")}`);
    if (rec) {
      block.push(`${w("Следующий шаг", "Келесі қадам")}: ${cleanText(rec.titleFromRecord ? rec.title : dealRiskAction(rec.reason, lang), 120)}`);
      block.push(`${w("Ответственный", "Жауапты")}: ${cleanText(rec.ownerName || w("нужно назначить", "тағайындау қажет"), 50)}`);
      if (rec.dueAt) block.push(`${rec.deadlineBasis === "suggested" ? w("Предлагаемый срок", "Ұсынылатын мерзім") : w("Срок", "Мерзім")}: ${time(rec.dueAt)}`);
      if (rec.kind === "task") block.push(w("Задача уже есть — проверьте её результат и срок.", "Тапсырма бар — нәтижесі мен мерзімін тексеріңіз."));
      if (rec.kind !== "create_task") block.push(link(rec.href));
    } else block.push(`${w("Следующий шаг", "Келесі қадам")}: ${cleanText(row.nextAction || w("не запланирован", "жоспарланбаған"), 100)}`);
    if (lines.join("\n").length + block.join("\n").length > 2800) break;
    lines.push(block.join("\n")); shown++;
  }
  if (!items.length) lines.push(w("Подходящих сделок нет.", "Сәйкес мәмілелер жоқ."));
  else lines.push(w(`Показано ${shown} из ${data.pagination?.total ?? items.length} подходящих сделок.`, `Сәйкес ${data.pagination?.total ?? items.length} мәміленің ${shown} көрсетілді.`));
  if (data.proposals?.length) lines.push(`${w("Предложений создать сделку", "Мәміле құру ұсыныстары")}: ${data.proposals.length}`);
  lines.push(w("Оценка по фактам CRM, не вероятность потери клиента. Создание нового шага требует подтверждения.", "Баға CRM деректеріне негізделген, клиентті жоғалту ықтималдығы емес. Жаңа қадамды құру растауды қажет етеді."));
  lines.push(link(`/control?view=sales&filter=${encodeURIComponent(data.filter || "all")}`));
  return lines.join("\n");
}
