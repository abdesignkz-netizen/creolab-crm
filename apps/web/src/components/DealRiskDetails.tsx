import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { dealRiskAction, dealRiskLabel, type DealRisk } from "@creolab/contracts";
import { useLocale } from "../lib/session";
import { toDateTimeLocalValue } from "../lib/period";
import { api } from "../lib/api";
import { InlineFeedback } from "./InlineFeedback";
import "./deal-risk.css";

export function DealRiskDetails({ dealId, risk, timeZone, members, onSaved }: {
  dealId: string; risk: DealRisk; timeZone: string; members: { id: string; name: string }[]; onSaved: () => Promise<void>;
}) {
  const lang = useLocale(), kk = lang === "kk", t = (ru: string, kz: string) => kk ? kz : ru;
  const rec = risk.recommendation, heading = useId(), dialog = useRef<HTMLDivElement>(null), busyRef = useRef(false);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [title, setTitle] = useState(""), [due, setDue] = useState(""), [owner, setOwner] = useState("");
  const [saved, setSaved] = useState<{ id: string; reused: boolean } | null>(null);
  const date = (value: string) => new Date(value).toLocaleString(kk ? "kk-KZ" : "ru-RU", { timeZone, dateStyle: "short", timeStyle: "short" });
  const actionTitle = rec ? rec.titleFromRecord ? rec.title : dealRiskAction(rec.reason, lang) : "";
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null, panel = dialog.current;
    const controls = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') || []);
    (controls()[0] || panel)?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) { e.preventDefault(); setOpen(false); }
      if (e.key === "Tab") {
        const items = controls(), first = items[0], last = items.at(-1);
        if (!first) { e.preventDefault(); panel?.focus(); }
        else if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  function prepare() {
    if (!rec?.canCreate || saved) return;
    setTitle(actionTitle); setDue(rec.dueAt ? toDateTimeLocalValue(new Date(rec.dueAt), timeZone) : "");
    setOwner(rec.ownerMembershipId || ""); setError(""); setOpen(true);
  }
  async function save() {
    if (busyRef.current || !rec?.canCreate) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const result = await api.request<{ id: string; reused: boolean }>(`/api/v1/sales/deals/${encodeURIComponent(dealId)}/risk-task`, {
        method: "POST", body: JSON.stringify({ confirmed: true, fingerprint: risk.fingerprint, title, dueAt: due, ownerMembershipId: owner }),
      });
      setSaved(result); setOpen(false); await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : t("Не удалось создать задачу", "Тапсырманы құру мүмкін болмады")); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const label = risk.priority === "urgent" ? t("Срочно", "Шұғыл") : risk.priority === "attention" ? t("Требует внимания", "Назар аудару қажет")
    : risk.priority === "on_hold" ? t("На паузе", "Кідіртілген") : t("По плану", "Жоспар бойынша");
  return <section className={`deal-risk is-${risk.priority}`} aria-labelledby={heading}>
    <div className="deal-risk-heading"><h4 id={heading}>{label}</h4><small>{t("Проверено", "Тексерілді")}: {date(risk.checkedAt)}</small></div>
    {risk.signals.length ? <ul>{risk.signals.map(s => <li key={s.code}>
      <strong>{dealRiskLabel(s.code, lang)}</strong>
      <small>{t("Основание", "Негізі")}: {s.source === "task" ? t("связанная задача", "байланысты тапсырма") : s.source === "conversation" ? t("переписка клиента", "клиентпен хат алмасу") : s.source === "invoice" ? t("выставленный счёт", "ұсынылған шот") : t("данные сделки", "мәміле деректері")}
        {s.at ? ` · ${date(s.at)}` : ""}
        {s.thresholdDays != null ? ` · ${t("Порог", "Шегі")}: ${s.thresholdDays} ${risk.timeBasis === "business" ? t("раб. дн.", "жұмыс күні") : t("кал. дн.", "күнтізбелік күн")}` : ""}</small>
    </li>)}</ul> : <p>{t("По проверенным правилам препятствий не найдено. Это не гарантия успешной продажи.", "Тексерілген ережелер бойынша кедергілер табылмады. Бұл сәтті сатылымға кепілдік емес.")}</p>}
    {rec && <div className="deal-risk-next">
      <b>{t("Рекомендуемый шаг", "Ұсынылатын қадам")}</b><p>{actionTitle}</p>
      <p className="muted">{t("Ответственный", "Жауапты")}: {rec.ownerName || t("Нужно назначить", "Тағайындау қажет")}
        {rec.dueAt ? ` · ${rec.deadlineBasis === "suggested" ? t("Предлагаемый срок", "Ұсынылатын мерзім") : t("Срок", "Мерзім")}: ${date(rec.dueAt)} (${timeZone})` : ""}</p>
      {rec.deadlineBasis === "suggested" && <small>{t("Срок предложен по настройкам сопровождения и календарю компании. Его можно изменить перед сохранением.", "Мерзім компанияның сүйемелдеу баптаулары мен күнтізбесі бойынша ұсынылды. Сақтау алдында оны өзгертуге болады.")}</small>}
      <div className="actions">{rec.kind === "create_task" && rec.canCreate && !saved ? <button type="button" className="btn" onClick={prepare}>{t("Проверить и создать задачу", "Тексеріп, тапсырма құру")}</button>
        : <Link className="btn secondary" to={rec.href}>{rec.kind === "task" ? t("Открыть существующую задачу", "Бар тапсырманы ашу") : rec.kind === "conversation" ? t("Открыть диалог", "Диалогты ашу") : t("Проверить сделку", "Мәмілені тексеру")}</Link>}</div>
      {rec.kind === "task" && <small>{t("Задача уже есть: проверьте её результат и срок.", "Тапсырма бар: оның нәтижесі мен мерзімін тексеріңіз.")}</small>}
    </div>}
    {saved && <p role="status"><Link to={`/tasks?open=${saved.id}`}>{saved.reused ? t("Эта задача уже сохранена — открыть", "Бұл тапсырма сақталған — ашу") : t("Задача создана — открыть", "Тапсырма құрылды — ашу")}</Link></p>}
    {open && rec && <div className="stats-modal-backdrop"><div className="stats-modal deal-risk-dialog" role="dialog" aria-modal="true" aria-labelledby={`${heading}-confirm`} tabIndex={-1} ref={dialog}>
      <h3 id={`${heading}-confirm`}>{t("Подтвердите следующий шаг", "Келесі қадамды растаңыз")}</h3>
      <p>{dealRiskLabel(rec.reason, lang)}</p>
      <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <label>{t("Что сделать", "Не істеу керек")}<input required minLength={3} maxLength={500} value={title} disabled={busy} onChange={e => setTitle(e.target.value)} /></label>
        <label>{t("Ответственный", "Жауапты")}<select required value={owner} disabled={busy} onChange={e => setOwner(e.target.value)}><option value="">{t("Выберите сотрудника", "Қызметкерді таңдаңыз")}</option>{members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label>{t("Срок", "Мерзім")} · {timeZone}<input type="datetime-local" required value={due} disabled={busy} onChange={e => setDue(e.target.value)} /></label>
        <p>{t("Создастся задача сотруднику и запись в истории сделки. Сообщение клиенту не отправляется.", "Қызметкерге тапсырма және мәміле тарихында жазба жасалады. Клиентке хабарлама жіберілмейді.")}</p>
        {error && <InlineFeedback kind="error">{error}<button type="button" className="btn secondary" disabled={busy} onClick={() => { setOpen(false); void onSaved(); }}>{t("Обновить проверку сделки", "Мәмілені қайта тексеру")}</button></InlineFeedback>}
        <div className="actions"><button className="btn" disabled={busy}>{busy ? t("Сохраняем…", "Сақталуда…") : t("Подтвердить и создать", "Растап, құру")}</button><button className="btn secondary" type="button" disabled={busy} onClick={() => setOpen(false)}>{t("Назад", "Артқа")}</button></div>
      </form>
    </div></div>}
  </section>;
}
