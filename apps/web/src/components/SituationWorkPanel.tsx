import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useLocale } from "../lib/session";
import { api } from "../lib/api";
import { InlineFeedback } from "./InlineFeedback";
import { notifySaved } from "./SaveNotice";
import "./situationWork.css";

type Episode = { itemId: string; state: string; occurrence: number; version: number; assignedMembershipId: string | null;
  active: boolean; title: string; updatedAt: string; resolvedAt: string | null; canManage: boolean; canSnoozeCompany: boolean;
  source: { contactId?: string; conversationId?: string; dealId?: string; taskId?: string };
  task: { id: string; title: string; status: string } | null;
  members: Array<{ id: string; name: string }>;
  availableTasks: Array<{ id: string; title: string }>;
  notices: Array<{ id: string; mode: string; createdAt: string; suppressionReason: string | null;
    batch: { state: string; error: string | null; finishedAt: string | null } | null }>;
  events: Array<{ id: string; kind: string; actorName: string; createdAt: string; detailsJson: { until?: string; scope?: string; reason?: string; taskId?: string; membershipId?: string } }> };
const labels: Record<string, [string, string]> = {
  detected: ["Ситуация обнаружена", "Жағдай анықталды"], assigned: ["Назначен ответственный за разбор", "Жауапты қызметкер тағайындалды"],
  task_created: ["Создана задача", "Тапсырма құрылды"], task_linked: ["Связана задача", "Тапсырма байланыстырылды"],
  snoozed: ["Напоминание отложено", "Еске салу кейінге қалдырылды"], resolved: ["Причина устранена — проверено по данным", "Себеп жойылды — деректермен тексерілді"],
  reopened: ["Ситуация возникла снова", "Жағдай қайта туындады"], facts_changed: ["Появились новые данные", "Жаңа деректер пайда болды"],
};
const noticeLabels: Record<string, [string, string]> = {
  covered_by_dialogue: ["Объединено с ситуацией в диалоге клиента", "Клиент диалогындағы жағдаймен біріктірілді"],
  situation_resolved: ["Не отправлено: причина устранена", "Жіберілмеді: себеп жойылды"],
  situation_snoozed: ["Не отправлено: напоминание отложено", "Жіберілмеді: еске салу кейінге қалдырылды"],
  situation_reopened: ["Заменено уведомлением о повторной ситуации", "Қайталанған жағдай туралы хабарландырумен ауыстырылды"],
  source_unavailable: ["Не отправлено: источник недоступен", "Жіберілмеді: дереккөз қолжетімсіз"],
  accepted: ["WhatsApp принял сводку к отправке", "WhatsApp жинақты жіберуге қабылдады"],
  uncertain: ["Результат отправки не подтверждён — проверьте WhatsApp", "Жіберу нәтижесі расталмады — WhatsApp-ты тексеріңіз"],
  failed: ["Не удалось отправить сводку", "Жинақты жіберу мүмкін болмады"], skipped: ["Отправка отменена", "Жіберу тоқтатылды"],
  sending: ["Отправляется в сводке", "Жинақта жіберілуде"], queued: ["Ожидает отправки в сводке", "Жинақта жіберуді күтуде"],
};
const sourceLink = (itemId: string, source: Episode["source"]) => {
  const [kind, id] = itemId.split(":");
  if (kind.startsWith("agreement")) return source.taskId ? `/tasks?open=${source.taskId}` : source.conversationId ? `/conversations/${source.conversationId}`
    : source.contactId ? `/contacts/${source.contactId}` : "/today";
  return kind.startsWith("task_") ? `/tasks?open=${id}` : kind.startsWith("conversation_") ? `/conversations/${id}`
    : kind.startsWith("deal-") ? `/deals/${id}` : kind === "contact_needs_reply" ? `/contacts/${id}`
    : kind.startsWith("inquiry_") || kind === "missing_next_action" ? `/requests/${id}` : "/today";
};

export function SituationWorkPanel({ itemId, title, state, onChanged }: {
  itemId: string; title?: string; state?: string; onChanged: () => Promise<void>;
}) {
  const locale = useLocale();
  const t = (ru: string, kk: string) => locale === "kk" ? kk : ru;
  const [data, setData] = useState<Episode | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [member, setMember] = useState(""), [task, setTask] = useState("");
  const [mode, setMode] = useState<"" | "task" | "snooze">("");
  const version = useRef(0);
  async function load() {
    const request = ++version.current;
    setBusy(true); setError("");
    try {
      const value = await api.situationEpisode(itemId) as Episode;
      if (request !== version.current) return;
      setData(value); setMember(value.assignedMembershipId || "");
    } catch (e) { if (request === version.current) setError(e instanceof Error ? e.message : t("Не удалось открыть ситуацию", "Жағдай ашылмады")); }
    finally { if (request === version.current) setBusy(false); }
  }
  async function action(body: Record<string, unknown>) {
    if (!data || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const value = await api.situationEpisodeAction({ itemId, version: data.version, ...body }) as Episode & { stillActive?: boolean };
      setData(value); setMode("");
      setMessage(value.stillActive ? t("Причина ещё сохраняется. Выполните нужное действие в карточке, затем проверьте снова.", "Себеп әлі бар. Карточкада қажетті әрекетті орындап, қайта тексеріңіз.")
        : value.state === "resolved" ? t("Причина устранена. Запись сохранена в истории.", "Себеп жойылды. Жазба тарихта сақталды.") : t("Сохранено в истории ситуации", "Жағдай тарихында сақталды"));
      if (!value.stillActive) notifySaved(t("История ситуации обновлена", "Жағдай тарихы жаңартылды"));
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : t("Не удалось сохранить", "Сақталмады")); }
    finally { setBusy(false); }
  }
  const date = (value: string) => new Date(value).toLocaleString(locale === "kk" ? "kk-KZ" : "ru-RU", { dateStyle: "short", timeStyle: "short" });
  return <details className="situation-work" onToggle={e => { if (e.target === e.currentTarget && e.currentTarget.open && !data && !busy) void load(); }}>
    <summary>{state === "in_progress" ? t("В работе · действия и история", "Орындалуда · әрекеттер мен тарих") : t("Разобрать ситуацию", "Жағдайды қарастыру")}</summary>
    <div className="situation-work-body" aria-busy={busy}>
      {error ? <><InlineFeedback kind="error">{error}</InlineFeedback><button className="btn secondary" disabled={busy} onClick={() => void load()}>{t("Обновить ситуацию", "Жағдайды жаңарту")}</button></> : null}
      {message ? <p role="status" className="situation-work-notice">{message}</p> : null}
      {!data ? <p>{busy ? t("Проверяем данные…", "Деректер тексерілуде…") : <button className="btn secondary" onClick={() => void load()}>{t("Повторить", "Қайталау")}</button>}</p> : <>
        <div className="situation-work-heading"><strong>{data.state === "resolved" ? t("Причина устранена", "Себеп жойылды") : data.state === "in_progress" ? t("В работе", "Орындалуда") : t("Нужно действие", "Әрекет қажет")}</strong>
          {data.occurrence > 1 ? <span className="muted">{t("Повторное возникновение", "Қайта туындау")} · {data.occurrence}</span> : null}
          <Link to={sourceLink(itemId, data.source)}>{t("Открыть карточку", "Карточканы ашу")} ↗</Link></div>
        {data.active ? <>
          <label>{t("Ответственный за разбор", "Қарастыруға жауапты")}
            <select value={member} disabled={busy} onChange={e => setMember(e.target.value)}><option value="">{t("Выберите сотрудника", "Қызметкерді таңдаңыз")}</option>
              {data.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <p className="muted situation-work-hint">{t("Здесь доступны сотрудники, у которых уже есть доступ к карточке.", "Мұнда карточкаға қолжетімділігі бар қызметкерлер көрсетілген.")}</p>
          <div className="situation-work-buttons">
            <button className="btn secondary" disabled={busy || !member || member === data.assignedMembershipId} onClick={() => void action({ action: "assign", membershipId: member })}>{t("Назначить", "Тағайындау")}</button>
            {data.canManage ? <button className="btn secondary" disabled={busy} onClick={() => setMode(mode === "task" ? "" : "task")}>{data.task ? t("Связать другую задачу", "Басқа тапсырманы байланыстыру") : t("Задача для решения", "Шешуге арналған тапсырма")}</button> : null}
            <button className="btn secondary" disabled={busy} onClick={() => setMode(mode === "snooze" ? "" : "snooze")}>{t("Отложить", "Кейінге қалдыру")}</button>
            <button className="btn secondary" disabled={busy} onClick={() => void action({ action: "check" })}>{t("Проверить решение", "Шешімді тексеру")}</button>
          </div>
          {mode === "task" ? <div className="situation-work-form">
            {data.availableTasks.length ? <div><label>{t("Уже есть задача?", "Тапсырма бар ма?")}<select value={task} onChange={e => setTask(e.target.value)} disabled={busy}>
              <option value="">{t("Выберите связанную задачу", "Байланысты тапсырманы таңдаңыз")}</option>{data.availableTasks.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
              <button className="btn secondary" disabled={!task || busy} onClick={() => void action({ action: "link_task", taskId: task })}>{t("Связать задачу", "Тапсырманы байланыстыру")}</button></div> : null}
            {!data.task ? <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void action({ action: "create_task", title: f.get("title"), dueAt: new Date(String(f.get("dueAt"))).toISOString(), membershipId: member }); }}>
              <label>{t("Что нужно сделать?", "Не істеу керек?")}<input name="title" defaultValue={title || data.title} minLength={3} maxLength={240} required disabled={busy} /></label>
              <label>{t("Срок", "Мерзім")}<input type="datetime-local" name="dueAt" required disabled={busy} /></label>
              <button className="btn" disabled={busy || !member}>{t("Создать задачу", "Тапсырма құру")}</button>
            </form> : <p>{t("Уже связанная задача сохранена в истории. Можно выбрать другую задачу того же клиента или обращения.", "Байланысты тапсырма тарихта сақталған. Осы клиенттің немесе өтініштің басқа тапсырмасын таңдауға болады.")}</p>}</div> : null}
          {mode === "snooze" ? <form className="situation-work-form" onSubmit={async e => {
            e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError("");
            try { await api.snoozeSituation({ itemId, version: data.version, until: new Date(String(f.get("until"))).toISOString(), reason: String(f.get("reason") || ""), scope: f.get("scope") === "company" ? "company" : "personal" });
              setMode(""); notifySaved(t("Напоминание отложено. Ситуация осталась в истории.", "Еске салу кейінге қалдырылды. Жағдай тарихта қалды.")); await load(); await onChanged();
            } catch (e) { setError(e instanceof Error ? e.message : t("Не удалось отложить", "Кейінге қалдырылмады")); } finally { setBusy(false); }
          }}>
            <p>{t("Отложение только убирает напоминание до выбранного срока. Новые данные вернут ситуацию раньше.", "Кейінге қалдыру еске салуды белгіленген мерзімге дейін жасырады. Жаңа деректер болса, жағдай ертерек қайтады.")}</p>
            <label>{t("Напомнить", "Еске салу")}<input name="until" type="datetime-local" required disabled={busy} /></label>
            <label>{t("Причина", "Себеп")}<input name="reason" maxLength={400} disabled={busy} /></label>
            {data.canSnoozeCompany ? <label>{t("Для кого отложить", "Кім үшін кейінге қалдыру")}<select name="scope" disabled={busy}><option value="personal">{t("Только для меня", "Тек өзім үшін")}</option><option value="company">{t("Для всей компании", "Бүкіл компания үшін")}</option></select></label> : null}
            <button className="btn" disabled={busy}>{t("Отложить напоминание", "Еске салуды кейінге қалдыру")}</button>
          </form> : null}
        </> : null}
        {data.task ? <p className="situation-work-task"><Link to={`/tasks?open=${data.task.id}`}>{t("Связанная задача", "Байланысты тапсырма")}: {data.task.title} ↗</Link></p> : null}
        {data.notices?.length ? <details><summary>{t("Мои WhatsApp-уведомления по ситуации", "Жағдай бойынша WhatsApp хабарландыруларым")}</summary>
          <ol className="situation-work-timeline">{data.notices.map(notice => <li key={notice.id}>
            <strong>{(noticeLabels[notice.suppressionReason || notice.batch?.state || "queued"] || noticeLabels.queued)[locale === "kk" ? 1 : 0]}</strong>
            <span className="muted">{date(notice.batch?.finishedAt || notice.createdAt)}</span>
          </li>)}</ol></details> : null}
        <h4>{t("История", "Тарих")}</h4>
        <ol className="situation-work-timeline">{data.events.map(e => <li key={e.id}>
          <strong>{labels[e.kind]?.[locale === "kk" ? 1 : 0] || e.kind}</strong>
          <span className="muted">{date(e.createdAt)} · {e.actorName}</span>
          {e.detailsJson.until ? <span>{t("До", "Дейін")} {date(e.detailsJson.until)} · {e.detailsJson.scope === "company" ? t("для компании", "компания үшін") : t("личное напоминание", "жеке еске салу")}</span> : null}
          {e.detailsJson.reason ? <span>{e.detailsJson.reason}</span> : null}
        </li>)}</ol>
      </>}
    </div>
  </details>;
}

export function SituationHistory({ onChanged }: { onChanged: () => Promise<void> }) {
  const locale = useLocale();
  const [items, setItems] = useState<Episode[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function load() { setBusy(true); setError(""); try { const value = await api.situationHistory() as { items: Episode[] }; setItems(value.items); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось загрузить историю"); } finally { setBusy(false); } }
  return <details className="situation-history" onToggle={e => { if (e.target === e.currentTarget && e.currentTarget.open) void load(); }}>
    <summary>{locale === "kk" ? "Жағдайлар тарихы және кейінге қалдырылғандар" : "История ситуаций и отложенные"}</summary>
    {error ? <InlineFeedback kind="error">{error}</InlineFeedback> : null}
    {busy ? <p role="status">{locale === "kk" ? "Жүктелуде…" : "Загрузка…"}</p> : null}
      <p className="muted">{locale === "kk" ? "Соңғы 100 жазба. Тексеру үшін жағдайды ашыңыз." : "Последние 100 записей. Откройте ситуацию для проверки текущего состояния."}</p>
      {!items.length ? <p>{locale === "kk" ? "Жазбалар әлі жоқ" : "Записей пока нет"}</p> : null}
      {items.map(row => <article key={row.itemId} className="situation-history-item"><strong>{row.title}</strong>
        <SituationWorkPanel itemId={row.itemId} title={row.title} state={row.state} onChanged={async () => { await load(); await onChanged(); }} /></article>)}
  </details>;
}
