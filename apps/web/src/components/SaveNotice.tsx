import { useEffect, useState } from "react";

const SAVE_EVENT = "creolab:saved";

/** Call only after the write request succeeds, before refreshing or navigating. */
export function notifySaved(message = "Изменения сохранены") {
  window.dispatchEvent(new CustomEvent(SAVE_EVENT, { detail: message }));
}

export function SaveNotice() {
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  useEffect(() => {
    const onSaved = (event: Event) => setNotice({ message: (event as CustomEvent<string>).detail });
    window.addEventListener(SAVE_EVENT, onSaved);
    return () => window.removeEventListener(SAVE_EVENT, onSaved);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return (
    <div className="save-notice-region" role="status" aria-live="polite" aria-atomic="true">
      {notice ? <div className="save-notice">
        <span aria-hidden="true">✓</span>
        <span>{notice.message}</span>
        <button type="button" aria-label="Закрыть уведомление" onClick={() => setNotice(null)}>×</button>
      </div> : null}
    </div>
  );
}
