import { useState, type ReactNode } from "react";
import { ChannelIcon } from "./ChannelIcon";
import { useUiText } from "../lib/uiText";

const icons: Record<string, string> = {
  form: "M5 3h14v18H5Zm4 5h6m-6 4h6m-6 4h3",
  webhook: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16",
  calendar: "M5 5h14v16H5ZM8 3v4m8-4v4M5 10h14m-10 4h2m2 0h2m-6 3h2",
  meta: "M3 15C3 3 8 3 12 12s9 9 9 1C21 3 16 3 12 12s-9 9-9 3Z",
  tiktok: "M14 3v12a4 4 0 1 1-4-4m4-8c1 4 3 5 7 5",
  esf: "M6 3h9l4 4v14H6Zm9 0v5h4M9 12h7m-7 4h4",
  notification: "M5 16h14l-2-3V9a5 5 0 0 0-10 0v4Zm5 4h4M12 2v2",
};

/** Native disclosure keeps keyboard behavior and preserves form state after collapsing. */
export function IntegrationDisclosure({ id, title, description, status, tone = "neutral", icon, children }: {
  id: string; title: string; description: string; status: string; tone?: "neutral" | "ok" | "warn";
  icon: string; children: ReactNode;
}) {
  const uiText = useUiText();
  const [visited, setVisited] = useState(false);
  return <details className="integration-tile" id={`integration-${id}`} onToggle={event => {
    if (event.currentTarget.open) setVisited(true);
  }}>
    <summary>
      <span className={`integration-tile-icon integration-icon-${icon}`}>
        {["whatsapp", "telegram", "instagram", "email"].includes(icon) ? <ChannelIcon channel={icon} /> : <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={icons[icon] || icons.form} /></svg>}
      </span>
      <span className="integration-tile-copy"><strong>{title}</strong><span>{description}</span></span>
      <span className={`integration-tile-status ${tone}`}><i aria-hidden="true" />{status}</span>
      <svg className="integration-tile-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
    </summary>
    {visited && <div className="integration-tile-body">{children}<button type="button" className="btn secondary integration-collapse" onClick={event => {
      const disclosure = event.currentTarget.closest("details");
      if (!disclosure) return;
      disclosure.open = false;
      disclosure.querySelector("summary")?.focus();
      disclosure.scrollIntoView({ block: "nearest" });
    }}>{uiText("Свернуть настройки")}</button></div>}
  </details>;
}
