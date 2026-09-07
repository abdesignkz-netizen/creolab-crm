type Props = { total: number; offset: number; limit: number; loading?: boolean; onChange: (offset: number) => void };

export function Pagination({ total, offset, limit, loading, onChange }: Props) {
  return <nav className="list-pagination" aria-label="Страницы списка">
    <span className="muted" aria-live="polite">{loading ? "Обновление…" : total ? `${Math.min(offset + 1, total)}–${Math.min(offset + limit, total)} из ${total}` : "Ничего не найдено"}</span>
    {offset > 0 || total > limit ? <div className="actions">
      <button type="button" className="btn secondary" disabled={loading || offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Назад</button>
      <button type="button" className="btn secondary" disabled={loading || offset + limit >= total} onClick={() => onChange(offset + limit)}>Далее</button>
    </div> : null}
  </nav>;
}
