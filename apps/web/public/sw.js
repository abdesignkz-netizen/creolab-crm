/* CREOLAB CRM — browser notifications (tab may be minimized) */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "SHOW_NOTIFICATION") return;
  const title = String(data.title || "CREOLAB CRM");
  const options = {
    body: String(data.body || ""),
    tag: String(data.tag || "creolab"),
    renotify: true,
    requireInteraction: Boolean(data.requireInteraction),
    data: { url: data.url || "/today" },
    icon: data.icon || "/favicon.svg",
    badge: data.badge || "/favicon.svg",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/today";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({ type: "NOTIFICATION_CLICK", url: target });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    }),
  );
});
