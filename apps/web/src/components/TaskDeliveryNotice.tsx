import { Link } from "react-router-dom";
import { useLocale } from "../lib/session";
import { useState } from "react";
import "./taskDeliveryNotice.css";

export type TaskDeliveryView = {
  success?: boolean; partial?: boolean; needsCheck?: boolean; sending?: boolean;
  textOk?: boolean; textState?: string; textError?: string | null; textReconciled?: boolean;
  files?: Array<{ id: string; fileName: string; ok: boolean; state?: string; error?: string; reconciled?: boolean }>;
};
export type TaskReconciliation = { partId: string; outcome: "sent" | "not_sent"; note: string };
const copy = {
  ru: { title: "Результат отправки", text: "Сообщение", accepted: "Отправлено", failed: "Не отправлено",
    pending: "Ещё не отправлено", unknown: "Нужно проверить", sending: "Отправляется", chat: "Открыть переписку",
    check: "WhatsApp не подтвердил отправку. Проверьте переписку с клиентом. Повтор заблокирован, чтобы не отправить дубликат.",
    busy: "Отправка выполняется. Дождитесь результата перед повтором.",
    partial: "Отправлена только часть материалов. Повторятся только неотправленные файлы.",
    receipt: "Статус показывает приём WhatsApp или результат ручной сверки. Это не подтверждает доставку или прочтение клиентом.",
    checked: "Сверено сотрудником", reconcile: "Записать результат сверки", select: "Результат проверки", found: "Есть в переписке WhatsApp", absent: "В WhatsApp не отправлено",
    note: "Где и что проверили", save: "Подтвердить результат", cancel: "Отмена",
    caution: "Проверьте именно WhatsApp: запись в истории BasQar сама по себе не доказывает отправку. После отметки «не отправлено» станет доступен отдельный повтор." },
  kk: { title: "Жіберу нәтижесі", text: "Хабарлама", accepted: "Жіберілді", failed: "Жіберілмеді",
    pending: "Әлі жіберілмеді", unknown: "Тексеру қажет", sending: "Жіберілуде", chat: "Хат алмасуды ашу",
    check: "WhatsApp жіберуді растамады. Клиентпен хат алмасуды тексеріңіз. Қайталама хабарлама жіберілмеуі үшін қайта жіберу бұғатталған.",
    busy: "Жіберу орындалып жатыр. Қайталамас бұрын нәтижені күтіңіз.",
    partial: "Материалдардың бір бөлігі ғана жіберілді. Тек жіберілмеген файлдар қайта жіберіледі.",
    receipt: "Күй WhatsApp қабылдауын немесе қолмен тексеру нәтижесін көрсетеді. Бұл клиентке жеткізілгенін немесе оқылғанын растамайды.",
    checked: "Қызметкер тексерді", reconcile: "Тексеру нәтижесін жазу", select: "Тексеру нәтижесі", found: "WhatsApp хат алмасуында бар", absent: "WhatsApp арқылы жіберілмеген",
    note: "Қайда және нені тексердіңіз", save: "Нәтижені растау", cancel: "Бас тарту",
    caution: "WhatsApp-ты тексеріңіз: BasQar тарихындағы жазба жіберілгенін дәлелдемейді. «Жіберілмеген» деп белгіленгеннен кейін бөлек қайта жіберу қолжетімді болады." },
};

export default function TaskDeliveryNotice({ result, conversationId, onReconcile }: { result: TaskDeliveryView; conversationId?: string | null; onReconcile?: (input: TaskReconciliation) => Promise<void> }) {
  const locale = useLocale(); const t = copy[locale === "kk" ? "kk" : "ru"];
  const [selected, setSelected] = useState<string | null>(null), [outcome, setOutcome] = useState<"sent" | "not_sent" | "">("");
  const [note, setNote] = useState(""), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const textState = result.textState || (result.textOk ? "accepted" : "pending");
  const rows = [{ id: "text", fileName: t.text, state: textState, ok: Boolean(result.textOk), reconciled: result.textReconciled }, ...(result.files || [])];
  const label = (state?: string) => state === "sending" && result.sending ? t.sending
    : state === "unknown" || state === "sending" ? t.unknown : state === "accepted" ? t.accepted : state === "failed" ? t.failed : t.pending;
  return <section className="task-delivery-notice" aria-label={t.title} role="status">
    <strong>{t.title}</strong>
    {result.sending ? <p>{t.busy}</p> : result.needsCheck ? <p>{t.check}</p> : result.partial ? <p>{t.partial}</p> : null}
    <ul>{rows.map(row => <li key={row.id}><span>{row.fileName}</span><div><b data-state={row.ok ? "accepted" : row.state}>{row.ok ? row.reconciled ? t.checked : t.accepted : label(row.state)}</b>
      {onReconcile && !result.sending && ["unknown", "sending"].includes(row.state || "") ? <button type="button" className="btn secondary" disabled={saving} onClick={() => { setSelected(row.id); setOutcome(""); setNote(""); setError(""); }}>{t.reconcile}</button> : null}
    </div></li>)}</ul>
    {!result.needsCheck && !result.sending && result.textError ? <p>{result.textError}</p> : null}
    {!result.needsCheck && !result.sending ? (result.files || []).filter(f => !f.ok && f.error).map(f => <p key={f.id}>{f.fileName}: {f.error}</p>) : null}
    <small>{t.receipt}</small>
    {conversationId ? <Link className="btn secondary" to={`/conversations/${encodeURIComponent(conversationId)}`}>{t.chat}</Link> : null}
    {selected && onReconcile ? <div className="task-delivery-reconcile">
      <strong>{rows.find(r => r.id === selected)?.fileName}</strong><p>{t.caution}</p>
      <label>{t.select}<select value={outcome} disabled={saving} onChange={event => setOutcome(event.target.value as typeof outcome)}><option value="">—</option><option value="sent">{t.found}</option><option value="not_sent">{t.absent}</option></select></label>
      <label>{t.note}<textarea value={note} maxLength={1000} minLength={8} rows={3} disabled={saving} onChange={event => setNote(event.target.value)} /></label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="actions"><button className="btn secondary" type="button" disabled={saving} onClick={() => setSelected(null)}>{t.cancel}</button>
        <button className="btn" type="button" disabled={saving || !outcome || note.trim().length < 8} onClick={async () => {
          if (!outcome) return; setSaving(true); setError("");
          try { await onReconcile({ partId: selected, outcome, note: note.trim() }); setSelected(null); }
          catch (err) { setError(err instanceof Error ? err.message : t.unknown); } finally { setSaving(false); }
        }}>{t.save}</button></div>
    </div> : null}
  </section>;
}
