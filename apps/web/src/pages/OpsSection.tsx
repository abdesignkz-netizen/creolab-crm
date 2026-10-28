import { analyticsText } from "../lib/analyticsCopy";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { processCalendarSchema, type ProcessCalendar } from "@creolab/contracts";
import { api } from "../lib/api";
import { InlineFeedback } from "../components/InlineFeedback";
import { notifySaved } from "../components/SaveNotice";
import { t, type Locale } from "../i18n";
import "./opsSection.css";
import { opsKk } from "./opsLocale";
import OpsStageEditor, { type EditableStage } from "./OpsStageEditor";

type Ops = {
  stalledDealDays: number | string; proposalFollowUpThresholdDays: number | string; silenceReturnDays: number | string;
  salesPlanMinor: number | null; salesPlans: Array<{ month: string; amount: number | string; currency: string }>; currency: string; lostReasons: string[]; timeZone: string;
  processCalendar: ProcessCalendar;
  revision: string; stages: EditableStage[];
};
const weekdays = [[1, "Понедельник"], [2, "Вторник"], [3, "Среда"], [4, "Четверг"], [5, "Пятница"], [6, "Суббота"], [0, "Воскресенье"]] as const;

export default function OpsSection({ locale, onDirtyChange }: { locale: Locale; onDirtyChange?: (dirty: boolean) => void }) {
  const text = (value: string) => locale === "kk" && opsKk[value] ? opsKk[value] : analyticsText(value, {}, locale);
  const [ops, setOps] = useState<Ops | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lostText, setLostText] = useState("");
  const [excluded, setExcluded] = useState("");
  const [dirty, setDirty] = useState(false);
  const [reloadPrompt, setReloadPrompt] = useState(false);
  const { hash } = useLocation();
  const salesPlanRef = useRef<HTMLDetailsElement>(null);
  const ready = Boolean(ops);
  useEffect(() => {
    if (hash !== "#sales-plan" || !ready || !salesPlanRef.current) return;
    salesPlanRef.current.open = true;
    salesPlanRef.current.scrollIntoView({ block: "start" });
    salesPlanRef.current.focus({ preventScroll: true });
  }, [hash, ready]);

  function accept(data: Ops) {
    setOps({ ...data, salesPlans: data.salesPlans || [] }); setLostText((data.lostReasons || []).join("\n"));
    setExcluded(data.processCalendar.excludedDates.join("\n"));
    setDirty(false); setReloadPrompt(false);
  }
  async function load() {
    setError(""); setBusy(true);
    try { accept(await api.workspaceOps() as Ops); }
    catch (err) { setError(err instanceof Error ? err.message : text("Не удалось загрузить настройки")); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  const change = (patch: Partial<Ops>) => { setOps(value => value ? { ...value, ...patch } : value); setDirty(true); };
  const calendar = (patch: Partial<ProcessCalendar>) => ops && change({ processCalendar: { ...ops.processCalendar, ...patch } });

  async function save(event: FormEvent) {
    event.preventDefault(); if (!ops || busy) return;
    const plans = ops.salesPlans.map(row => ({ ...row, amount: Number(String(row.amount).replace(/\s+/g, "")) }));
    if (plans.some((row, i) => !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(row.month) || !/^[A-Z]{3}$/.test(row.currency)
      || String(ops.salesPlans[i].amount).trim() === "" || !Number.isSafeInteger(row.amount) || row.amount < 0)
      || new Set(plans.map(row => `${row.month}:${row.currency}`)).size !== plans.length) {
      setError(text("Укажите месяц, валюту и целую неотрицательную сумму. Месяц и валюта не должны повторяться.")); return;
    }
    if (!ops.processCalendar.days.length) { setError(text("Выберите хотя бы один рабочий день")); return; }
    const schedule = processCalendarSchema.safeParse({ ...ops.processCalendar, excludedDates: [...new Set(excluded.split(/[\n,]+/).map(line => line.trim()).filter(Boolean))] });
    if (!schedule.success) { setError(text("Проверьте рабочее время и даты дополнительных выходных.")); return; }
    setBusy(true); setError("");
    try {
      const data = await api.updateWorkspaceOps({
        stalledDealDays: Number(ops.stalledDealDays),
        proposalFollowUpThresholdDays: Number(ops.proposalFollowUpThresholdDays),
        silenceReturnDays: Number(ops.silenceReturnDays),
        salesPlans: plans,
        lostReasons: lostText.split("\n").map(line => line.trim()).filter(Boolean),
        revision: ops.revision,
        pipeline: ops.stages.map(({ id, systemKey, name, defaultProbability, isArchived, slaDays }) => ({ id, systemKey, name, defaultProbability: Number(defaultProbability), isArchived, slaDays })),
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
    {error ? <div><InlineFeedback kind="error">{error}</InlineFeedback>
      {reloadPrompt ? <div className="ops-note"><p>{text("Загрузить сохранённые правила? Несохранённые изменения этой формы будут потеряны.")}</p><button type="button" className="btn secondary" disabled={busy} onClick={() => void load()}>{text("Загрузить сохранённые")}</button> <button type="button" className="btn secondary" onClick={() => setReloadPrompt(false)}>{text("Продолжить редактирование")}</button></div>
        : <button type="button" className="btn secondary" disabled={busy} onClick={() => setReloadPrompt(true)}>{text("Загрузить актуальные настройки")}</button>}
    </div> : null}
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
      <OpsStageEditor stages={ops.stages} text={text} business={business} onChange={stages => change({ stages })} />
      <details className="ops-block" id="sales-plan" ref={salesPlanRef} tabIndex={-1}><summary>{text("План продаж и причины потери")}</summary>
        <h3>{text("План продаж по месяцам")}</h3>
        <p className="muted">{text("План задаётся для всей компании. За часть месяца используется доля календарных дней; разные валюты считаются отдельно.")}</p>
        {ops.salesPlanMinor != null && !ops.salesPlans.length ? <p className="ops-note">{analyticsText("Прежний план без периода: {amount}. Он сохранён, но не участвует в расчёте. Укажите месяц для нового плана.", { amount: String(ops.salesPlanMinor) }, locale)}</p> : null}
        <div className="ops-stages">{ops.salesPlans.map((row, index) => <div className="ops-stage" key={index}>
          <div className="ops-grid">
            <label>{text("Месяц плана")}<input type="month" required value={row.month} onChange={event => change({ salesPlans: ops.salesPlans.map((item, i) => i === index ? { ...item, month: event.target.value } : item) })} /></label>
            <label>{text("Сумма плана")}<input inputMode="numeric" required value={row.amount} onChange={event => change({ salesPlans: ops.salesPlans.map((item, i) => i === index ? { ...item, amount: event.target.value } : item) })} /></label>
            <label>{text("Валюта")}<input required maxLength={3} pattern="[A-Z]{3}" value={row.currency} onChange={event => change({ salesPlans: ops.salesPlans.map((item, i) => i === index ? { ...item, currency: event.target.value.toUpperCase() } : item) })} /></label>
          </div>
          <button className="btn secondary ops-add-stage" type="button" onClick={() => change({ salesPlans: ops.salesPlans.filter((_, i) => i !== index) })}>{text("Удалить месяц плана")}</button>
        </div>)}</div>
        <button className="btn secondary ops-add-stage" type="button" disabled={ops.salesPlans.length >= 120} onClick={() => change({ salesPlans: [...ops.salesPlans, { month: "", amount: "", currency: ops.currency || "KZT" }] })}>{text("Добавить месяц")}</button>
        <label>{text("Причины потери — по одной на строку")}<textarea rows={6} value={lostText} onChange={event => { setLostText(event.target.value); setDirty(true); }} /></label>
      </details>
      <div className="ops-save"><span className="muted" role="status">{dirty ? text("Есть несохранённые изменения") : text("Настройки сохранены")}</span>
        <button className="btn" disabled={!dirty || busy}>{busy ? text("Сохраняем…") : t(locale, "settings.save")}</button></div>
    </fieldset>
  </form>;
}
