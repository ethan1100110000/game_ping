const CACHE_NAME = "gameping-web-v10";
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
  const actions = data.kind === "ping" && data.pingID && data.ackToken
    ? [{ action: "ack", title: "확인" }]
    : [];
  const options = {
    body: data.body || "게임 시작했어. 들어와!",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.pingID || data.requestID || "gameping-ping",
    actions,
    data: {
      url: data.url || "/",
      kind: data.kind || "ping",
      pingID: data.pingID,
      ackToken: data.ackToken,
      targetUserID: data.targetUserID,
      targetName: data.targetName
    },
    vibrate: [120, 60, 120]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

async function acknowledgePing(data) {
  if (!data?.pingID || !data?.ackToken) return null;

  const response = await fetch(`/pings/${encodeURIComponent(data.pingID)}/ack`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ackToken: data.ackToken,
      userID: data.targetUserID,
      userName: data.targetName
    })
  });

  if (!response.ok) {
    throw new Error(`Ack failed with ${response.status}`);
  }

  const payload = await response.json();
  const clientsList = await clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clientsList) {
    client.postMessage({
      type: "ping-acknowledged",
      pingID: data.pingID,
      acknowledgedAt: payload.acknowledgedAt,
      acknowledgedByName: payload.acknowledgedByName
    });
  }
  return payload;
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const notificationData = event.notification.data ?? {};

  if (event.action === "ack") {
    event.waitUntil(acknowledgePing(notificationData));
    return;
  }

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
