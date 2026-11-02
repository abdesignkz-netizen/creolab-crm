import { useEffect, useState, type FormEvent } from "react";
import { DECISION_KINDS, DECISION_LABELS, type DecisionContent } from "@creolab/contracts";
import { createBusinessMemoryApi } from "@creolab/api-client/business-memory";
import { api } from "../lib/api";
import { parseDateTimeLocalInput, toDateTimeLocalValue } from "../lib/period";
import { InlineFeedback } from "./InlineFeedback";

const memoryApi = createBusinessMemoryApi(api.request);
export function BusinessDecisionForm({ initial, timezone, busy, onSave, onCancel }: { initial?: DecisionContent; timezone: string; busy: boolean; onSave: (data: DecisionContent) => void; onCancel: () => void }) {
  const [c, setC] = useState<DecisionContent>(() => initial || { kind: "decision", topic: "", title: "", body: "", rationale: "", sourceKind: "manual", sourceId: null,
    validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 30 * 86400000).toISOString(), retentionUntil: new Date(Date.now() + 180 * 86400000).toISOString() });
  const [dates, setDates] = useState(() => ({ validFrom: toDateTimeLocalValue(new Date(c.validFrom), timezone), validUntil: toDateTimeLocalValue(new Date(c.validUntil), timezone), retentionUntil: toDateTimeLocalValue(new Date(c.retentionUntil), timezone) }));
  const [q, setQ] = useState(""), [sources, setSources] = useState<Array<{ id: string; title: string }>>([]), [loading, setLoading] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    if (c.sourceKind === "manual") { setSources([]); setLoading(false); return; }
    let active = true; setLoading(true);
    const timer = setTimeout(() => memoryApi.options(c.sourceKind, q).then(r => { if (active) { setSources(r.sources); setError(""); } }).catch(e => { if (active) { setSources([]); setError(e.message); } }).finally(() => { if (active) setLoading(false); }), 200);
    return () => { active = false; clearTimeout(timer); };
  }, [c.sourceKind, q]);
  function submit(e: FormEvent) {
    e.preventDefault(); const parsed = Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, parseDateTimeLocalInput(v, timezone)]));
    if (Object.values(parsed).some(d => !Number.isFinite(d.getTime()))) { setError("Проверьте даты и время."); return; }
    onSave({ ...c, validFrom: parsed.validFrom.toISOString(), validUntil: parsed.validUntil.toISOString(), retentionUntil: parsed.retentionUntil.toISOString() });
  }
  return <form className="panel decision-form" onSubmit={submit} aria-label="Черновик решения"><h3>Что нужно запомнить компании?</h3>
    {error && <InlineFeedback kind="error">{error}</InlineFeedback>}
    <fieldset disabled={busy}>
      <label>Тип записи<select value={c.kind} onChange={e => setC({ ...c, kind: e.target.value as DecisionContent["kind"] })}>{DECISION_KINDS.map(k => <option key={k} value={k}>{DECISION_LABELS[k]}</option>)}</select></label>
      <label>Тема — один конкретный вопрос<input required maxLength={80} value={c.topic} onChange={e => setC({ ...c, topic: e.target.value })} placeholder="Например, срок первого ответа новому клиенту" /></label>
      <label>Короткое название<input required maxLength={160} value={c.title} onChange={e => setC({ ...c, title: e.target.value })} placeholder="Отвечать на новые обращения в течение 15 минут" /></label>
      <label>{c.kind === "hypothesis" ? "Что предполагаем и хотим проверить?" : "Что именно решили?"}<textarea required maxLength={1200} rows={4} value={c.body} onChange={e => setC({ ...c, body: e.target.value })} /></label>
      <label>Почему — факты и причина решения<textarea required maxLength={800} rows={3} value={c.rationale} onChange={e => setC({ ...c, rationale: e.target.value })} /></label>
      <label>Основание<select value={c.sourceKind} onChange={e => { setC({ ...c, sourceKind: e.target.value as DecisionContent["sourceKind"], sourceId: null }); setQ(""); }}><option value="manual">Решение руководителя</option><option value="goal">Цель компании</option><option value="insight">Бизнес-вывод</option><option value="action_run">Мой выполненный план</option></select></label>
      {c.sourceKind !== "manual" && <>{c.sourceKind !== "insight" && <label>Найти основание<input maxLength={80} value={q} onChange={e => setQ(e.target.value)} placeholder="Название цели или плана" /></label>}
        <label>Связанная запись<select required disabled={loading} value={c.sourceId || ""} onChange={e => setC({ ...c, sourceId: e.target.value || null })}><option value="">{loading ? "Загружаем…" : "Выберите основание"}</option>
          {c.sourceId && !sources.some(s => s.id === c.sourceId) && <option value={c.sourceId}>Ранее выбранное основание — будет проверено при сохранении</option>}{sources.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
        <small className="muted">До 20 записей. Выводы должны быть обновлены. Решение на основе личного плана видно только его автору.</small></>}
      <div className="decision-dates">{([['validFrom', 'Начало действия'], ['validUntil', 'Когда пересмотреть'], ['retentionUntil', 'Когда удалить содержимое']] as const).map(([key, label]) => <label key={key}>{label} · {timezone}<input required type="datetime-local" value={dates[key]} onChange={e => setDates({ ...dates, [key]: e.target.value })} /></label>)}</div>
      <p className="muted">Сначала сохранится черновик. Утверждение — отдельным действием. Гипотезы не участвуют в планах. Не добавляйте пароли, ключи и лишние персональные данные.</p>
      <div className="actions"><button className="btn" disabled={loading}>{busy ? "Сохраняем…" : "Сохранить черновик"}</button><button className="btn secondary" type="button" onClick={onCancel}>Отмена</button></div>
    </fieldset>
  </form>;
}
