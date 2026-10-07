import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../lib/session";
import { getPublicLocale, t } from "../i18n";
import {
  dismissFeedback,
  feedbackSnapshot,
  showFeedback,
  subscribeFeedback,
  type Feedback,
} from "./feedbackStore";

let serial = 0;
/** Call only after the write request succeeds, before refreshing or navigating. */
export function notifySaved(message = t(getPublicLocale(), "common.saved")) {
  showFeedback({ id: `saved-${++serial}`, message, kind: "success" });
}
function FeedbackCard({ item }: { item: Feedback }) {
  const locale = useLocale();
  const [hovered, setHovered] = useState(false),
    [focused, setFocused] = useState(false);
  useEffect(() => {
    if (item.kind === "error" || hovered || focused) return;
    const timer = window.setTimeout(() => dismissFeedback(item.id), 9000);
    return () => window.clearTimeout(timer);
  }, [item, hovered, focused]);
  return (
    <div
      className={`feedback-card feedback-card--${item.kind}`}
      role={item.kind === "error" ? "alert" : "status"}
      aria-atomic="true"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <span className="feedback-icon" aria-hidden="true">
        {item.kind === "error" ? "!" : item.kind === "success" ? "✓" : "i"}
      </span>
      <span className="feedback-message">{item.message}</span>
      <button
        type="button"
        aria-label={t(locale, "common.closeNotice")}
        onClick={() => dismissFeedback(item.id)}
      >
        ×
      </button>
    </div>
  );
}
export function SaveNotice() {
  const items = useSyncExternalStore(
    subscribeFeedback,
    feedbackSnapshot,
    feedbackSnapshot,
  );
  return createPortal(
    <div className="feedback-region">
      {items.map((item) => (
        <FeedbackCard key={item.id} item={item} />
      ))}
    </div>,
    document.body,
  );
}
