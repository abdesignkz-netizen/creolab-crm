const STORAGE_ENABLED = "creolab.browserNotifications.enabled";
const STORAGE_SEEN = "creolab.browserNotifications.seen";
const STORAGE_DISMISSED = "creolab.browserNotifications.bannerDismissed";

export type BrowserPermission = NotificationPermission | "unsupported";

export function isSecureNotificationContext() {
  if (typeof window === "undefined") return false;
  return window.isSecureContext || location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

export function hasNotificationApi() {
  return typeof window !== "undefined" && "Notification" in window;
}

export function browserNotificationsSupported() {
  return hasNotificationApi() && isSecureNotificationContext();
}

/** iOS Safari supports web notifications mainly for Home Screen / PWA apps. */
export function isLikelyIosSafari() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua);
  const notOther = !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/.test(ua);
  return iOS && webkit && notOther;
}

export function isStandaloneDisplayMode() {
  if (typeof window === "undefined") return false;
  const media = window.matchMedia?.("(display-mode: standalone)")?.matches;
  const iosStandalone = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return Boolean(media || iosStandalone);
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
    if (enabled) localStorage.removeItem(STORAGE_DISMISSED);
  } catch {
    /* ignore */
  }
}

export function isNotificationBannerDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_DISMISSED) === "1";
  } catch {
    return false;
  }
}

export function dismissNotificationBanner() {
  try {
    localStorage.setItem(STORAGE_DISMISSED, "1");
  } catch {
    /* ignore */
  }
}

export function currentBrowserPermission(): BrowserPermission {
  if (!browserNotificationsSupported()) return "unsupported";
  return Notification.permission;
}

export async function registerNotificationWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  if (!isSecureNotificationContext()) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

/**
 * Must be called directly from a user gesture (click).
 * Do not await anything before Notification.requestPermission — mobile browsers drop the prompt.
 */
export async function requestBrowserNotificationPermission(): Promise<BrowserPermission> {
  if (!browserNotificationsSupported()) return "unsupported";

  if (Notification.permission === "granted") {
    setBrowserNotificationPreference(true);
    void registerNotificationWorker();
    return "granted";
  }
  if (Notification.permission === "denied") return "denied";

  let result: NotificationPermission;
  try {
    // Keep this call first in the gesture chain (no awaits before it).
    // Support both Promise and legacy callback forms.
    result = await new Promise<NotificationPermission>((resolve, reject) => {
      try {
        const maybe = Notification.requestPermission((permission) => resolve(permission));
        if (maybe && typeof (maybe as PromiseLike<NotificationPermission>).then === "function") {
          void Promise.resolve(maybe).then(resolve, reject);
        }
      } catch (err) {
        reject(err);
      }
    });
  } catch {
    return currentBrowserPermission();
  }

  if (result === "granted") {
    setBrowserNotificationPreference(true);
    void registerNotificationWorker();
  }
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
  force?: boolean;
}) {
  if (!browserNotificationsSupported()) return false;
  if (Notification.permission !== "granted") return false;
  if (!input.force && !getBrowserNotificationPreference()) return false;

  // Tab is open and visible — skip OS toast unless forced (settings test).
  if (!input.force && document.visibilityState === "visible" && document.hasFocus()) return false;

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
    const reg = await navigator.serviceWorker?.ready;
    if (reg?.active) {
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
      // Still report unread for badge, but skip OS toasts.
      try {
        const items = await opts.load();
        opts.onUnreadCount?.(items.filter((item) => !item.readAt).length);
      } catch {
        opts.onUnreadCount?.(0);
      }
      return;
    }
    try {
      const items = await opts.load();
      const unread = items.filter((item) => !item.readAt);
      opts.onUnreadCount?.(unread.length);

      const fresh = unread.filter((item) => !seen.has(item.id));
      if (!primed) {
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
