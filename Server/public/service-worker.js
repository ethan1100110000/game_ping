const CACHE_NAME = "gameping-web-v9";
const APP_SHELL = [
  "/",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then(response => response ?? caches.match("/")))
  );
});

self.addEventListener("push", event => {
  const data = event.data?.json() ?? {};
  const title = data.title || "GamePing 호출";
  const options = {
    body: data.body || "게임 시작했어. 들어와!",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.pingID || data.requestID || "gameping-ping",
    data: {
      url: data.url || "/"
    },
    vibrate: [120, 60, 120]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetURL = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          client.navigate(targetURL);
          return client.focus();
        }
      }

      return clients.openWindow(targetURL);
    })
  );
});
