const STORAGE_ENABLED = "creolab.browserNotifications.enabled";
const STORAGE_SEEN = "creolab.browserNotifications.seen";

export type BrowserPermission = NotificationPermission | "unsupported";

export function browserNotificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator;
}

export function getBrowserNotificationPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_ENABLED) !== "0";
  } catch {
    return true;
  }
}

export function setBrowserNotificationPreference(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_ENABLED, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function currentBrowserPermission(): BrowserPermission {
  if (!browserNotificationsSupported()) return "unsupported";
  return Notification.permission;
}

export async function registerNotificationWorker() {
  if (!browserNotificationsSupported()) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

export async function requestBrowserNotificationPermission(): Promise<BrowserPermission> {
  if (!browserNotificationsSupported()) return "unsupported";
  await registerNotificationWorker();
  if (Notification.permission === "granted") {
    setBrowserNotificationPreference(true);
    return "granted";
  }
  if (Notification.permission === "denied") return "denied";
  const result = await Notification.requestPermission();
  if (result === "granted") setBrowserNotificationPreference(true);
  return result;
}

function seenKey(tenantId: string) {
  return `${STORAGE_SEEN}:${tenantId}`;
}

export function loadSeenNotificationIds(tenantId: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(seenKey(tenantId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function saveSeenNotificationIds(tenantId: string, ids: Set<string>) {
  try {
    const list = [...ids].slice(-200);
    sessionStorage.setItem(seenKey(tenantId), JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export async function showBrowserNotification(input: {
  title: string;
  body: string;
  tag: string;
  url?: string;
  requireInteraction?: boolean;
}) {
  if (!browserNotificationsSupported()) return false;
  if (Notification.permission !== "granted") return false;
  if (!getBrowserNotificationPreference()) return false;

  // Tab is open and visible — skip OS toast; in-app UI is enough.
  if (document.visibilityState === "visible" && document.hasFocus()) return false;

  const payload = {
    type: "SHOW_NOTIFICATION",
    title: input.title,
    body: input.body,
    tag: input.tag,
    url: input.url || "/today",
    requireInteraction: input.requireInteraction,
    icon: "/favicon.svg",
    badge: "/favicon.svg",
  };

  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) {
      reg.active.postMessage(payload);
      return true;
    }
  } catch {
    /* fallback below */
  }

  try {
    const n = new Notification(input.title, {
      body: input.body,
      tag: input.tag,
      icon: "/favicon.svg",
      data: { url: input.url || "/today" },
    });
    n.onclick = () => {
      window.focus();
      if (input.url) window.location.assign(input.url);
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

export type CrmNotice = {
  id: string;
  title: string;
  body: string;
  type?: string;
  priority?: string;
  href?: string;
  readAt?: string | null;
  createdAt?: string;
};

export function startNotificationPolling(opts: {
  tenantId: string;
  intervalMs?: number;
  load: () => Promise<CrmNotice[]>;
  onUnreadCount?: (count: number) => void;
  onNavigate?: (url: string) => void;
}) {
  const intervalMs = opts.intervalMs ?? 20_000;
  let cancelled = false;
  let seen = loadSeenNotificationIds(opts.tenantId);
  let primed = seen.size > 0;

  async function tick() {
    if (cancelled) return;
    if (!getBrowserNotificationPreference()) {
      opts.onUnreadCount?.(0);
      return;
    }
    try {
      const items = await opts.load();
      const unread = items.filter((item) => !item.readAt);
      opts.onUnreadCount?.(unread.length);

      const fresh = unread.filter((item) => !seen.has(item.id));
      if (!primed) {
        // First poll: remember current unread, don't spam historical toasts.
        for (const item of unread) seen.add(item.id);
        primed = true;
        saveSeenNotificationIds(opts.tenantId, seen);
        return;
      }

      for (const item of fresh.slice(0, 5)) {
        seen.add(item.id);
        await showBrowserNotification({
          title: item.title || "CREOLAB CRM",
          body: item.body || "",
          tag: item.id,
          url: item.href || "/today",
          requireInteraction: item.priority === "high",
        });
      }
      if (fresh.length) saveSeenNotificationIds(opts.tenantId, seen);
    } catch {
      /* ignore transient errors */
    }
  }

  void registerNotificationWorker();
  void tick();
  const timer = window.setInterval(() => void tick(), intervalMs);

  const onMessage = (event: MessageEvent) => {
    const data = event.data || {};
    if (data.type === "NOTIFICATION_CLICK" && typeof data.url === "string") {
      opts.onNavigate?.(data.url);
    }
  };
  navigator.serviceWorker?.addEventListener("message", onMessage);

  const onVisibility = () => {
    if (document.visibilityState === "visible") void tick();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    cancelled = true;
    window.clearInterval(timer);
    navigator.serviceWorker?.removeEventListener("message", onMessage);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
