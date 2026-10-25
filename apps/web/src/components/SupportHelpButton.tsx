import { useLocale } from "../lib/session";
import { t } from "../i18n";

export function SupportHelpButton({ unread, onClick }: { unread: number; onClick: () => void }) {
  const locale = useLocale();
  return (
    <button type="button" className="btn secondary support-help-btn" onClick={onClick}>
      {t(locale, "nav.help")}
      {unread > 0 ? <span className="nav-badge">{unread > 9 ? "9+" : unread}</span> : null}
    </button>
  );
}
