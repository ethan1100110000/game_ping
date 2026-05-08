import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { hasAPNsConfig, sendAPNsNotification } from "./apns.mjs";

const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const apiToken = process.env.GAMEPING_API_TOKEN ?? "";
const publicURL = process.env.PUBLIC_URL ?? "";
const serverDir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(serverDir, "public");
const dataDir = process.env.GAMEPING_DATA_DIR ?? join(serverDir, "data");
const dataPath = join(dataDir, "store.json");

const store = loadStore();
const devices = new Map(store.devices.map(device => [device.userID, device]));
const pings = store.pings;
const rateBuckets = new Map();

function normalizeInviteCode(code) {
  const compact = String(code ?? "")
    .trim()
    .replaceAll(" ", "")
    .toUpperCase();

  if (!compact) {
    return "";
  }

  return compact.startsWith("GP-") ? compact : `GP-${compact}`;
}

function loadStore() {
  try {
    const parsed = JSON.parse(readFileSync(dataPath, "utf8"));
    return {
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      pings: Array.isArray(parsed.pings) ? parsed.pings : []
    };
  } catch {
    return {
      devices: [],
      pings: []
    };
  }
}

function saveStore() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    dataPath,
    JSON.stringify(
      {
        devices: Array.from(devices.values()),
        pings
      },
      null,
      2
    )
  );
}

function getRequestIP(request) {
  return request.socket.remoteAddress ?? "unknown";
}

function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) ?? {
    count: 0,
    resetAt: now + windowMs
  };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);

  return {
    allowed: bucket.count <= limit,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  };
}

function isProtectedRoute(method, pathname) {
  if (!apiToken) {
    return false;
  }

  if (pathname === "/health" || pathname.startsWith("/invites/")) {
    return false;
  }

  return method !== "OPTIONS";
}

function hasValidAuth(request) {
  const authorization = request.headers.authorization ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  return bearer === apiToken || request.headers["x-gameping-token"] === apiToken;
}

function localURLs() {
  const urls = new Set([`http://${host}:${port}`]);

  if (publicURL) {
    urls.add(publicURL);
  }

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.add(`http://${entry.address}:${port}`);
      }
    }
  }

  return Array.from(urls);
}

function publicDevice(device) {
  return {
    userID: device.userID,
    userName: device.userName,
    inviteCode: device.inviteCode,
    platform: device.platform,
    hasPushToken: Boolean(device.pushToken),
    updatedAt: device.updatedAt
  };
}

function publicInboxPing(record) {
  return {
    id: record.id,
    status: record.status,
    receivedAt: record.receivedAt,
    senderName: record.payload.senderName ?? "GamePing",
    message: record.payload.message ?? "호출",
    body: record.payload.notificationBody ?? record.payload.message ?? "게임 시작했어. 들어와!"
  };
}

function sendJSON(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,X-GamePing-Token"
  });
  response.end(payload);
}

function sendText(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-cache"
  });
  response.end(body);
}

function contentTypeFor(pathname) {
  switch (extname(pathname)) {
  case ".css":
    return "text/css; charset=utf-8";
  case ".js":
    return "text/javascript; charset=utf-8";
  case ".json":
  case ".webmanifest":
    return "application/manifest+json; charset=utf-8";
  case ".svg":
    return "image/svg+xml";
  default:
    return "text/html; charset=utf-8";
  }
}

function sendStatic(response, pathname) {
  const routePath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(routePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    return false;
  }

  sendText(response, 200, readFileSync(filePath), contentTypeFor(filePath));
  return true;
}

function readJSON(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error("Payload too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function findDeviceByInviteCode(code) {
  const normalized = normalizeInviteCode(code);
  return Array.from(devices.values()).find(device => device.inviteCode === normalized);
}

function findPingTarget(payload) {
  return devices.get(payload.friendID) ?? findDeviceByInviteCode(payload.friendHandle);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const ip = getRequestIP(request);

  if (request.method === "OPTIONS") {
    sendJSON(response, 204, {});
    return;
  }

  if (request.method === "GET" && sendStatic(response, url.pathname)) {
    return;
  }

  const rate = checkRateLimit(`${ip}:${request.method}:${url.pathname}`, request.method === "POST" ? 60 : 180, 60_000);
  if (!rate.allowed) {
    response.setHeader("Retry-After", String(rate.retryAfter));
    sendJSON(response, 429, {
      ok: false,
      error: "Rate limit exceeded"
    });
    return;
  }

  if (isProtectedRoute(request.method, url.pathname) && !hasValidAuth(request)) {
    sendJSON(response, 401, {
      ok: false,
      error: "Unauthorized"
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJSON(response, 200, {
      ok: true,
      service: "gameping-mock",
      pings: pings.length,
      devices: devices.size,
      apnsConfigured: hasAPNsConfig(),
      authRequired: Boolean(apiToken),
      dataPath,
      urls: localURLs()
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/devices") {
    sendJSON(response, 200, {
      ok: true,
      devices: Array.from(devices.values()).map(publicDevice)
    });
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/invites/")) {
    const code = decodeURIComponent(url.pathname.replace("/invites/", ""));
    const device = findDeviceByInviteCode(code);

    if (!device) {
      sendJSON(response, 404, {
        ok: false,
        error: "Invite code not found"
      });
      return;
    }

    sendJSON(response, 200, {
      ok: true,
      friend: {
        userID: device.userID,
        userName: device.userName,
        inviteCode: device.inviteCode,
        hasPushToken: Boolean(device.pushToken)
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/devices") {
    try {
      const payload = await readJSON(request);
      const inviteCode = normalizeInviteCode(payload.inviteCode);

      if (!payload.userID || !payload.userName || !inviteCode) {
        sendJSON(response, 422, {
          ok: false,
          error: "userID, userName and inviteCode are required"
        });
        return;
      }

      devices.set(payload.userID, {
        userID: String(payload.userID),
        userName: String(payload.userName),
        inviteCode,
        pushToken: payload.pushToken ? String(payload.pushToken) : null,
        platform: payload.platform ?? "ios",
        appVersion: payload.appVersion ?? "dev",
        updatedAt: new Date().toISOString()
      });
      saveStore();

      sendJSON(response, 202, {
        ok: true,
        status: "registered",
        device: publicDevice(devices.get(payload.userID))
      });
    } catch (error) {
      sendJSON(response, 400, {
        ok: false,
        error: error.message
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/pings") {
    sendJSON(response, 200, {
      ok: true,
      pings
    });
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/inbox/")) {
    const userID = decodeURIComponent(url.pathname.replace("/inbox/", ""));
    const since = Date.parse(url.searchParams.get("since") ?? "");

    const inbox = pings
      .filter(record => record.targetUserID === userID)
      .filter(record => Number.isNaN(since) || Date.parse(record.receivedAt) > since)
      .slice(0, 20)
      .map(publicInboxPing);

    sendJSON(response, 200, {
      ok: true,
      pings: inbox
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/pings") {
    try {
      const payload = await readJSON(request);

      if (!payload.friendName || !payload.message) {
        sendJSON(response, 422, {
          ok: false,
          error: "friendName and message are required"
        });
        return;
      }

      const target = findPingTarget(payload);
      const record = {
        id: `ping_${randomUUID()}`,
        status: target ? "queued" : "unresolved",
        receivedAt: new Date().toISOString(),
        targetUserID: target?.userID ?? null,
        payload,
        push: null
      };

      if (target?.pushToken) {
        try {
          record.push = await sendAPNsNotification({
            token: target.pushToken,
            title: `${payload.senderName ?? "GamePing"} 호출`,
            body: payload.notificationBody ?? payload.message,
            payload: {
              pingID: record.id,
              senderName: payload.senderName,
              message: payload.message
            }
          });
          record.status = record.push.skipped ? "queued" : "sent";
        } catch (error) {
          record.status = "queued";
          record.push = {
            skipped: false,
            error: error.message
          };
        }
      }

      pings.unshift(record);
      pings.splice(50);
      saveStore();

      console.log(
        `[ping] ${payload.senderName ?? "unknown"} -> ${payload.friendName}: ${payload.message} (${record.status})`
      );

      sendJSON(response, 202, {
        ok: true,
        id: record.id,
        status: record.status,
        receivedAt: record.receivedAt
      });
    } catch (error) {
      sendJSON(response, 400, {
        ok: false,
        error: error.message
      });
    }
    return;
  }

  sendJSON(response, 404, {
    ok: false,
    error: "Not found"
  });
});

server.listen(port, host, () => {
  console.log(`GamePing mock server listening on http://${host}:${port}`);
  for (const url of localURLs()) {
    console.log(`Reachable URL: ${url}`);
  }
  console.log(`Data path: ${dataPath}`);
  if (apiToken) {
    console.log("API token protection is enabled.");
  }
});

function shutdown() {
  saveStore();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
