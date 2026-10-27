import { useEffect, useState, type FormEvent } from "react";
import { processCalendarSchema, type ProcessCalendar } from "@creolab/contracts";
import { api } from "../lib/api";
import { useUiText } from "../lib/uiText";
import { InlineFeedback } from "../components/InlineFeedback";
import { notifySaved } from "../components/SaveNotice";
import { t, type Locale } from "../i18n";
import "./opsSection.css";
import { opsKk } from "./opsLocale";

type Ops = {
  stalledDealDays: number | string; proposalFollowUpThresholdDays: number | string; silenceReturnDays: number | string;
  salesPlanMinor: number | null; lostReasons: string[]; timeZone: string;
  processCalendar: ProcessCalendar;
  stages: Array<{ systemKey: string; name: string; slaDays: number | null }>;
};
const weekdays = [[1, "Понедельник"], [2, "Вторник"], [3, "Среда"], [4, "Четверг"], [5, "Пятница"], [6, "Суббота"], [0, "Воскресенье"]] as const;

export default function OpsSection({ locale, onDirtyChange }: { locale: Locale; onDirtyChange?: (dirty: boolean) => void }) {
  const ui = useUiText();
  const text = (value: string) => locale === "kk" && opsKk[value] ? opsKk[value] : ui(value);
  const [ops, setOps] = useState<Ops | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lostText, setLostText] = useState("");
  const [excluded, setExcluded] = useState("");
  const [plan, setPlan] = useState("");
  const [dirty, setDirty] = useState(false);

  function accept(data: Ops) {
    setOps(data); setLostText((data.lostReasons || []).join("\n"));
    setExcluded(data.processCalendar.excludedDates.join("\n"));
    setPlan(data.salesPlanMinor != null ? String(data.salesPlanMinor) : ""); setDirty(false);
  }
  async function load() {
    setError("");
    try { accept(await api.workspaceOps() as Ops); }
    catch (err) { setError(err instanceof Error ? err.message : text("Не удалось загрузить настройки")); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  const change = (patch: Partial<Ops>) => { setOps(value => value ? { ...value, ...patch } : value); setDirty(true); };
  const calendar = (patch: Partial<ProcessCalendar>) => ops && change({ processCalendar: { ...ops.processCalendar, ...patch } });

  async function save(event: FormEvent) {
    event.preventDefault(); if (!ops || busy) return;
    const planNumber = plan.trim() ? Number(plan.replace(/\s+/g, "").replace(",", ".")) : null;
    if (planNumber !== null && (!Number.isFinite(planNumber) || planNumber < 0)) { setError(text("Укажите положительную сумму или оставьте поле пустым")); return; }
    if (!ops.processCalendar.days.length) { setError(text("Выберите хотя бы один рабочий день")); return; }
    const schedule = processCalendarSchema.safeParse({ ...ops.processCalendar, excludedDates: [...new Set(excluded.split(/[\n,]+/).map(line => line.trim()).filter(Boolean))] });
    if (!schedule.success) { setError(text("Проверьте рабочее время и даты дополнительных выходных.")); return; }
    setBusy(true); setError("");
    try {
      const data = await api.updateWorkspaceOps({
        stalledDealDays: Number(ops.stalledDealDays),
        proposalFollowUpThresholdDays: Number(ops.proposalFollowUpThresholdDays),
        silenceReturnDays: Number(ops.silenceReturnDays),
        salesPlanMinor: planNumber === null ? null : Math.round(planNumber),
        lostReasons: lostText.split("\n").map(line => line.trim()).filter(Boolean),
        stageSlaDays: Object.fromEntries(ops.stages.map(stage => [stage.systemKey, stage.slaDays])),
        processCalendar: schedule.data,
      });
      accept(data as Ops); notifySaved(text("Правила работы со сделками сохранены"));
    } catch (err) { setError(err instanceof Error ? text(err.message) : text("Не сохранено")); }
    finally { setBusy(false); }
  }

  if (!ops) return <div className="panel">{error ? <><InlineFeedback kind="error">{error}</InlineFeedback><button className="btn secondary" onClick={() => void load()}>{text("Повторить")}</button></> : <p className="muted">{t(locale, "common.loading")}</p>}</div>;
  const business = ops.processCalendar.mode === "business";
  return <form className="panel ops-section" onSubmit={event => void save(event)}>
    <div><h2>{text("Правила работы со сделками")}</h2>
      <p className="muted">{text("Общие сроки для сделок, главной страницы, статистики и BasQar Control.")}</p></div>
    {error ? <InlineFeedback kind="error">{error}</InlineFeedback> : null}
    <fieldset disabled={busy}>
      <section className="ops-block">
        <h3>{text("Как считать дни")}</h3>
        <label>{text("Календарь контроля")}<select value={ops.processCalendar.mode} onChange={event => calendar({ mode: event.target.value as ProcessCalendar["mode"] })}>
          <option value="calendar">{text("Календарные дни — круглосуточно")}</option>
          <option value="business">{text("Рабочие дни — по расписанию")}</option>
        </select></label>
        <p className="muted">{text("Часовой пояс компании")}: {ops.timeZone}</p>
        {business ? <>
          <p className="muted">{text("Один день — одна полная рабочая смена. Нерабочие часы и исключённые даты не увеличивают задержку.")}</p>
          <fieldset className="ops-weekdays"><legend>{text("Рабочие дни")}</legend>{weekdays.map(([value, label]) => <label key={value}>
            <input type="checkbox" checked={ops.processCalendar.days.includes(value)} onChange={event => calendar({ days: event.target.checked ? [...ops.processCalendar.days, value].sort() : ops.processCalendar.days.filter(day => day !== value) })} />{text(label)}
          </label>)}</fieldset>
          <div className="ops-grid"><label>{text("Начало рабочего дня")}<input type="time" required value={ops.processCalendar.start} onChange={event => calendar({ start: event.target.value })} /></label>
            <label>{text("Конец рабочего дня")}<input type="time" required value={ops.processCalendar.end} onChange={event => calendar({ end: event.target.value })} /></label></div>
          {ops.processCalendar.end < ops.processCalendar.start ? <p className="muted">{text("Смена заканчивается на следующий день. Выходные относятся к дате начала смены.")}</p> : null}
          <label>{text("Дополнительные выходные")}<textarea rows={3} value={excluded} placeholder="2026-12-16" onChange={event => { setExcluded(event.target.value); setDirty(true); }} /></label>
          <p className="muted">{text("По одной дате ГГГГ-ММ-ДД на строку, до 100 дат. Праздники добавляйте самостоятельно.")}</p>
        </> : null}
        <p className="ops-note">{text("Назначенные даты задач и встреч сохраняются. Расписание ответов ИИ настраивается отдельно.")}</p>
      </section>
      <section className="ops-block">
        <h3>{text("Когда обратить внимание")}</h3>
        <p className="muted">{business ? text("Все сроки ниже — в рабочих днях.") : text("Все сроки ниже — в календарных днях.")}</p>
        <div className="ops-grid">{([
          ["stalledDealDays", "Без продвижения по сделке", 90],
          ["proposalFollowUpThresholdDays", "Предложение осталось без ответа", 90],
          ["silenceReturnDays", "Без контакта с клиентом", 180],
        ] as const).map(([key, label, max]) => <label key={key}>{text(label)}<input type="number" min={1} max={max} required value={ops[key]} onChange={event => change({ [key]: event.target.value })} /></label>)}</div>
        <p className="ops-note">{text("Следующий шаг — действие со сроком или связанная задача со сроком. Ожидание клиента не отменяет просрочку.")}</p>
      </section>
      <section className="ops-block">
        <h3>{text("Сроки этапов")}</h3><p className="muted">{text("Пустое поле отключает контроль длительности этого этапа.")}</p>
        <div className="ops-grid">{ops.stages.map((stage, index) => <label key={stage.systemKey}>{stage.name}<input type="number" min={1} max={90} step="any" value={stage.slaDays ?? ""}
          onChange={event => change({ stages: ops.stages.map((item, i) => i === index ? { ...item, slaDays: event.target.value === "" ? null : Number(event.target.value) } : item) })} /></label>)}</div>
      </section>
      <details className="ops-block"><summary>{text("План продаж и причины потери")}</summary>
        <label>{text("План продаж за период, ₸")}<input inputMode="decimal" value={plan} onChange={event => { setPlan(event.target.value); setDirty(true); }} /></label>
        <label>{text("Причины потери — по одной на строку")}<textarea rows={6} value={lostText} onChange={event => { setLostText(event.target.value); setDirty(true); }} /></label>
      </details>
      <div className="ops-save"><span className="muted" role="status">{dirty ? text("Есть несохранённые изменения") : text("Настройки сохранены")}</span>
        <button className="btn" disabled={!dirty || busy}>{busy ? text("Сохраняем…") : t(locale, "settings.save")}</button></div>
    </fieldset>
  </form>;
}
