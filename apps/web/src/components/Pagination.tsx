import { useLocale } from "../lib/session";
import { t } from "../i18n";

type Props = { total: number; offset: number; limit: number; loading?: boolean; onChange: (offset: number) => void };

export function Pagination({ total, offset, limit, loading, onChange }: Props) {
  const locale = useLocale();
  return <nav className="list-pagination" aria-label={t(locale, "pagination.label")}>
    <span className="muted" aria-live="polite">{loading ? t(locale, "pagination.refreshing") : total ? t(locale, "pagination.range", { from: Math.min(offset + 1, total), to: Math.min(offset + limit, total), total }) : t(locale, "search.empty")}</span>
    {offset > 0 || total > limit ? <div className="actions">
      <button type="button" className="btn secondary" disabled={loading || offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>{t(locale, "common.previous")}</button>
      <button type="button" className="btn secondary" disabled={loading || offset + limit >= total} onClick={() => onChange(offset + limit)}>{t(locale, "common.next")}</button>
    </div> : null}
  </nav>;
}
