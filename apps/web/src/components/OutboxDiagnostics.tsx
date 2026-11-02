import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { InlineFeedback } from "./InlineFeedback";

type FailedJob = { id: string; label: string; failedAt: string; attempts: number; explanation: string; canRetry: boolean };
type Report = { items: FailedJob[]; total: number; retrying: number; offset: number; limit: number };

export function OutboxDiagnostics() {
  const [data, setData] = useState<Report | null>(null), [offset, setOffset] = useState(0);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<{ row: FailedJob; requestId: string } | null>(null);
  const generation = useRef(0);
  async function load() {
    const version = ++generation.current;
    try { const report = await api.outboxFailures(offset) as Report; if (version === generation.current) { setData(report); setError(""); } }
    catch (e) { if (version === generation.current) setError(e instanceof Error ? e.message : "Не удалось проверить обработку"); }
  }
  useEffect(() => { setData(null); void load(); return () => { generation.current++; }; }, [offset]);
  async function retry() {
    if (!confirmation || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.retryOutboxFailure(confirmation.row.id, { requestId: confirmation.requestId, failedAt: confirmation.row.failedAt, confirmed: true });
      setConfirmation(null); setNotice("Задание поставлено на повторную обработку. Результат появится после выполнения."); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось запустить повтор"); }
    finally { setBusy(false); }
  }
  return <details className="panel">
    <summary>Фоновая обработка{data ? ` · Остановлено: ${data.total}` : ""}</summary>
    <p className="muted">Задания, которые не удалось завершить. Неопределённые внешние отправки требуют проверки доставки.</p>
    {error && <InlineFeedback kind="error">{error}</InlineFeedback>}{notice && <p role="status">{notice}</p>}
    <button type="button" className="btn secondary" disabled={busy} onClick={() => void load()}>Обновить состояние</button>
    {!data && !error && <p role="status">Проверяем…</p>}
    {data && <><p>Остановлено: {data.total}. Ожидают автоматического повтора: {data.retrying}.</p>
      {!data.total && <p>Остановленных заданий нет.</p>}
      {data.items.map(row => <article className="panel" key={row.id}><b>{row.label}</b><p>{row.explanation}</p><p className="muted">{new Date(row.failedAt).toLocaleString('ru-RU')} · Попыток: {row.attempts}</p>
        {row.canRetry && confirmation?.row.id !== row.id && <button type="button" className="btn secondary" disabled={busy} onClick={() => { setConfirmation({ row, requestId: crypto.randomUUID() }); setNotice(""); }}>Повторить обработку</button>}
        {confirmation?.row.id === row.id && <div role="group" aria-label="Подтверждение повтора"><p>Повторить «{row.label}» после устранения причины? Система заново проверит актуальные данные и сохранит повтор в истории.</p><div className="actions"><button type="button" className="btn" disabled={busy} onClick={() => void retry()}>{busy ? "Запускаем…" : "Подтвердить повтор"}</button><button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirmation(null)}>Отмена</button></div></div>}
      </article>)}
      {(offset > 0 || offset + data.limit < data.total) && <nav className="actions" aria-label="Страницы заданий"><button type="button" className="btn secondary" disabled={busy || offset === 0} onClick={() => { setConfirmation(null); setOffset(Math.max(0, offset - data.limit)); }}>Назад</button><button type="button" className="btn secondary" disabled={busy || offset + data.limit >= data.total} onClick={() => { setConfirmation(null); setOffset(offset + data.limit); }}>Далее</button></nav>}
    </>}
  </details>;
}
