const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,X-GamePing-Token"
};

const API_PREFIXES = [
  "/health",
  "/push/",
  "/devices",
  "/invites/",
  "/friends/",
  "/friend-requests",
  "/pings",
  "/inbox/"
];

const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return jsonResponse({}, 204);
  }

  if (!isAPIRoute(url.pathname) && request.method === "GET") {
    return env.ASSETS.fetch(request);
  }

  if (isProtectedRoute(request.method, url.pathname, env) && !hasValidAuth(request, env)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const response = await routeAPI(request, env, ctx, url);
    return response ?? jsonResponse({ ok: false, error: "Not found" }, 404);
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error?.message ?? "Server error"
    }, 500);
  }
}

async function routeAPI(request, env, ctx, url) {
  if (request.method === "GET" && url.pathname === "/health") {
    const [pings, devices] = await Promise.all([
      countRows(env, "pings"),
      countRows(env, "devices")
    ]);

    return jsonResponse({
      ok: true,
      service: "gameping-worker",
      pings,
      devices,
      apnsConfigured: false,
      webPushConfigured: hasWebPushConfig(env),
      authRequired: Boolean(env.GAMEPING_API_TOKEN),
      dataPath: "cloudflare-d1",
      urls: [url.origin]
    });
  }

  if (request.method === "GET" && url.pathname === "/push/public-key") {
    if (!hasWebPushConfig(env)) {
      return jsonResponse({
        ok: false,
        error: "Web Push is not configured"
      }, 503);
    }

    return jsonResponse({
      ok: true,
      publicKey: env.VAPID_PUBLIC_KEY
    });
  }

  if (request.method === "GET" && url.pathname === "/devices") {
    const { results } = await env.DB.prepare("SELECT * FROM devices ORDER BY updated_at DESC LIMIT 100").all();
    return jsonResponse({
      ok: true,
      devices: results.map(deviceFromRow).map(publicDevice)
    });
  }

  if (request.method === "GET" && url.pathname.startsWith("/invites/")) {
    const code = decodeURIComponent(url.pathname.replace("/invites/", ""));
    const device = await findDeviceByInviteCode(env, code);

    if (!device) {
      return jsonResponse({
        ok: false,
        error: "Invite code not found"
      }, 404);
    }

    return jsonResponse({
      ok: true,
      friend: {
        userID: device.userID,
        userName: device.userName,
        inviteCode: device.inviteCode,
        hasPushToken: Boolean(device.pushToken)
      }
    });
  }

  if (request.method === "POST" && url.pathname === "/devices") {
    const payload = await readJSON(request);
    const inviteCode = normalizeInviteCode(payload.inviteCode);

    if (!payload.userID || !payload.userName || !inviteCode) {
      return jsonResponse({
        ok: false,
        error: "userID, userName and inviteCode are required"
      }, 422);
    }

    const previous = await getDevice(env, payload.userID);
    const device = {
      userID: String(payload.userID),
      userName: String(payload.userName),
      inviteCode,
      pushToken: payload.pushToken ? String(payload.pushToken) : null,
      webPushSubscription: payload.webPushSubscription ?? previous?.webPushSubscription ?? null,
      platform: payload.platform ?? "ios",
      appVersion: payload.appVersion ?? "dev",
      updatedAt: new Date().toISOString()
    };

    await upsertDevice(env, device);
    const restoredFriends = await restoreKnownFriends(env, device, payload.knownFriends);
    const deliveredQueuedPings = await deliverQueuedPingsForDevice(env, device);

    return jsonResponse({
      ok: true,
      status: "registered",
      restoredFriends,
      deliveredQueuedPings,
      device: publicDevice(await getDevice(env, device.userID))
    }, 202);
  }

  if (request.method === "GET" && url.pathname.startsWith("/friends/")) {
    const userID = decodeURIComponent(url.pathname.replace("/friends/", ""));
    return jsonResponse({
      ok: true,
      friends: await friendsForUser(env, userID)
    });
  }

  if (request.method === "GET" && url.pathname.startsWith("/friend-requests/")) {
    const userID = decodeURIComponent(url.pathname.replace("/friend-requests/", ""));
    const incomingRows = await env.DB.prepare(`
      SELECT * FROM friend_requests
      WHERE target_user_id = ? AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 50
    `).bind(userID).all();
    const outgoingRows = await env.DB.prepare(`
      SELECT * FROM friend_requests
      WHERE sender_id = ? AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 50
    `).bind(userID).all();

    return jsonResponse({
      ok: true,
      incoming: incomingRows.results.map(friendRequestFromRow).map(publicFriendRequest),
      outgoing: outgoingRows.results.map(friendRequestFromRow).map(publicFriendRequest)
    });
  }

  if (request.method === "POST" && url.pathname === "/friend-requests") {
    return createFriendRequest(request, env);
  }

  if (request.method === "POST" && url.pathname.startsWith("/friend-requests/") && url.pathname.endsWith("/respond")) {
    return respondFriendRequest(request, env, url);
  }

  if (request.method === "GET" && url.pathname === "/pings") {
    const rows = await env.DB.prepare("SELECT * FROM pings ORDER BY received_at DESC LIMIT 50").all();
    return jsonResponse({
      ok: true,
      pings: rows.results.map(pingFromRow)
    });
  }

  if (request.method === "GET" && url.pathname.startsWith("/inbox/")) {
    const userID = decodeURIComponent(url.pathname.replace("/inbox/", ""));
    const since = Date.parse(url.searchParams.get("since") ?? "");
    const rows = Number.isNaN(since)
      ? await env.DB.prepare(`
          SELECT * FROM pings
          WHERE target_user_id = ?
          ORDER BY received_at DESC
          LIMIT 20
        `).bind(userID).all()
      : await env.DB.prepare(`
          SELECT * FROM pings
          WHERE target_user_id = ? AND received_at > ?
          ORDER BY received_at DESC
          LIMIT 20
        `).bind(userID, new Date(since).toISOString()).all();

    return jsonResponse({
      ok: true,
      pings: rows.results.map(pingFromRow).map(publicInboxPing)
    });
  }

  if (request.method === "POST" && url.pathname === "/pings") {
    return createPing(request, env);
  }

  return null;
}

async function createFriendRequest(request, env) {
  const payload = await readJSON(request);
  const senderID = String(payload.senderID ?? "").trim();
  const senderName = String(payload.senderName ?? "").trim() || "플레이어";
  const senderInviteCode = normalizeInviteCode(payload.senderInviteCode);
  const target = await findDeviceByInviteCode(env, payload.targetInviteCode ?? payload.friendCode ?? payload.friendHandle);

  if (!senderID || !senderInviteCode) {
    return jsonResponse({
      ok: false,
      error: "senderID and senderInviteCode are required"
    }, 422);
  }

  if (!target) {
    return jsonResponse({
      ok: false,
      error: "Invite code not found"
    }, 404);
  }

  if (target.userID === senderID || target.inviteCode === senderInviteCode) {
    return jsonResponse({
      ok: false,
      error: "Cannot add yourself"
    }, 422);
  }

  if (await findFriendship(env, senderID, target.userID)) {
    return jsonResponse({
      ok: true,
      status: "friends",
      friend: publicFriend(target)
    });
  }

  const reverseRequest = await pendingFriendRequest(env, target.userID, senderID);
  if (reverseRequest) {
    reverseRequest.status = "accepted";
    reverseRequest.respondedAt = new Date().toISOString();
    await updateFriendRequestStatus(env, reverseRequest);
    const friendship = await ensureFriendship(env, senderID, target.userID);

    return jsonResponse({
      ok: true,
      status: "accepted",
      request: publicFriendRequest(reverseRequest),
      friendship,
      friend: publicFriend(target)
    });
  }

  const existingRequest = await pendingFriendRequest(env, senderID, target.userID);
  if (existingRequest) {
    return jsonResponse({
      ok: true,
      status: "pending",
      request: publicFriendRequest(existingRequest)
    });
  }

  const sender = await getDevice(env, senderID) ?? {
    userID: senderID,
    userName: senderName,
    inviteCode: senderInviteCode
  };
  const record = {
    id: `friend_request_${crypto.randomUUID()}`,
    senderID,
    senderName: sender.userName ?? senderName,
    senderInviteCode: sender.inviteCode ?? senderInviteCode,
    targetUserID: target.userID,
    targetInviteCode: target.inviteCode,
    status: "pending",
    createdAt: new Date().toISOString(),
    respondedAt: null,
    push: null
  };

  await insertFriendRequest(env, record);
  record.push = await notifyFriendRequest(env, target, record);
  if (record.push) {
    await updateFriendRequestPush(env, record.id, record.push);
  }
  await trimTable(env, "friend_requests", "created_at", 100);

  return jsonResponse({
    ok: true,
    status: "pending",
    request: publicFriendRequest(record)
  }, 202);
}

async function respondFriendRequest(request, env, url) {
  const requestID = decodeURIComponent(url.pathname.slice("/friend-requests/".length, -"/respond".length));
  const payload = await readJSON(request);
  const userID = String(payload.userID ?? "").trim();
  const action = String(payload.action ?? "").trim().toLowerCase();
  const record = await getFriendRequest(env, requestID);

  if (!record || record.status !== "pending") {
    return jsonResponse({
      ok: false,
      error: "Friend request not found"
    }, 404);
  }

  if (record.targetUserID !== userID) {
    return jsonResponse({
      ok: false,
      error: "Only the target user can respond"
    }, 403);
  }

  if (action !== "accept" && action !== "reject") {
    return jsonResponse({
      ok: false,
      error: "action must be accept or reject"
    }, 422);
  }

  record.status = action === "accept" ? "accepted" : "rejected";
  record.respondedAt = new Date().toISOString();
  await updateFriendRequestStatus(env, record);

  const sender = await getDevice(env, record.senderID) ?? {
    userID: record.senderID,
    userName: record.senderName,
    inviteCode: record.senderInviteCode
  };

  let friendship = null;
  let friend = null;
  if (action === "accept") {
    friendship = await ensureFriendship(env, record.senderID, record.targetUserID);
    friend = publicFriend(sender);
  }

  return jsonResponse({
    ok: true,
    status: record.status,
    request: publicFriendRequest(record),
    friendship,
    friend
  });
}

async function createPing(request, env) {
  const payload = await readJSON(request);

  if (!payload.friendName || !payload.message) {
    return jsonResponse({
      ok: false,
      error: "friendName and message are required"
    }, 422);
  }

  const clientPingID = payload.clientPingID ? String(payload.clientPingID) : null;
  if (clientPingID) {
    const existing = await env.DB.prepare("SELECT * FROM pings WHERE client_ping_id = ? LIMIT 1")
      .bind(clientPingID)
      .first();
    if (existing) {
      const ping = pingFromRow(existing);
      return jsonResponse({
        ok: true,
        id: ping.id,
        status: ping.status,
        receivedAt: ping.receivedAt,
        duplicate: true
      }, 202);
    }
  }

  const target = await findPingTarget(env, payload);
  const fallbackTargetUserID = payload.friendID ? String(payload.friendID) : null;
  const record = {
    id: `ping_${crypto.randomUUID()}`,
    clientPingID,
    status: target || fallbackTargetUserID ? "queued" : "unresolved",
    receivedAt: new Date().toISOString(),
    targetUserID: target?.userID ?? fallbackTargetUserID,
    payload,
    webPush: null,
    push: null
  };

  if (target?.webPushSubscription) {
    try {
      record.webPush = await sendWebPushNotification(env, target.webPushSubscription, {
        title: `${payload.senderName ?? "GamePing"} 호출`,
        body: payload.notificationBody ?? payload.message,
        pingID: record.id,
        senderName: payload.senderName,
        message: payload.message,
        url: "/"
      });
      if (!record.webPush.skipped) {
        record.status = "sent";
      }
    } catch (error) {
      record.status = "queued";
      record.webPush = {
        skipped: false,
        statusCode: error.statusCode,
        error: error.body || error.message
      };

      if (error.statusCode === 404 || error.statusCode === 410) {
        await clearWebPushSubscription(env, target.userID);
      }
    }
  }

  await insertPing(env, record);
  await trimTable(env, "pings", "received_at", 50);

  return jsonResponse({
    ok: true,
    id: record.id,
    status: record.status,
    receivedAt: record.receivedAt
  }, 202);
}

function isAPIRoute(pathname) {
  return API_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix));
}

function isProtectedRoute(method, pathname, env) {
  if (!env.GAMEPING_API_TOKEN) {
    return false;
  }

  if (pathname === "/health" || pathname.startsWith("/invites/")) {
    return false;
  }

  return method !== "OPTIONS";
}

function hasValidAuth(request, env) {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  return bearer === env.GAMEPING_API_TOKEN || request.headers.get("x-gameping-token") === env.GAMEPING_API_TOKEN;
}

async function countRows(env, tableName) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).first();
  return Number(row?.count ?? 0);
}

async function readJSON(request) {
  const text = await request.text();
  if (text.length > 64 * 1024) {
    throw new Error("Payload too large");
  }
  return text ? JSON.parse(text) : {};
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS
  });
}

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

function publicDevice(device) {
  return {
    userID: device.userID,
    userName: device.userName,
    inviteCode: device.inviteCode,
    platform: device.platform,
    hasPushToken: Boolean(device.pushToken),
    hasWebPush: Boolean(device.webPushSubscription),
    updatedAt: device.updatedAt
  };
}

function publicFriend(device) {
  return {
    id: device.userID,
    userID: device.userID,
    name: device.userName,
    userName: device.userName,
    handle: device.inviteCode,
    inviteCode: device.inviteCode,
    hasPushToken: Boolean(device.pushToken),
    hasWebPush: Boolean(device.webPushSubscription)
  };
}

function publicFriendRequest(record) {
  return {
    id: record.id,
    senderID: record.senderID,
    senderName: record.senderName,
    senderInviteCode: record.senderInviteCode,
    targetUserID: record.targetUserID,
    targetInviteCode: record.targetInviteCode,
    status: record.status,
    createdAt: record.createdAt,
    respondedAt: record.respondedAt ?? null
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

function publicKnownFriend(friend) {
  const userID = String(friend.userID ?? friend.id ?? "").trim();
  const inviteCode = normalizeInviteCode(friend.inviteCode ?? friend.handle);

  if (!userID || !inviteCode) {
    return null;
  }

  return {
    userID,
    userName: String(friend.userName ?? friend.name ?? "친구").trim() || "친구",
    inviteCode
  };
}

function deviceFromRow(row) {
  if (!row) return null;
  return {
    userID: row.user_id,
    userName: row.user_name,
    inviteCode: row.invite_code,
    pushToken: row.push_token,
    webPushSubscription: parseJSON(row.web_push_subscription),
    platform: row.platform,
    appVersion: row.app_version,
    updatedAt: row.updated_at
  };
}

function friendRequestFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    senderID: row.sender_id,
    senderName: row.sender_name,
    senderInviteCode: row.sender_invite_code,
    targetUserID: row.target_user_id,
    targetInviteCode: row.target_invite_code,
    status: row.status,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
    push: parseJSON(row.push)
  };
}

function friendshipFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.friendship_key,
    userIDs: [row.user_a, row.user_b],
    createdAt: row.created_at
  };
}

function pingFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientPingID: row.client_ping_id,
    status: row.status,
    receivedAt: row.received_at,
    targetUserID: row.target_user_id,
    payload: parseJSON(row.payload) ?? {},
    webPush: parseJSON(row.web_push),
    push: parseJSON(row.push)
  };
}

function parseJSON(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringifyJSON(value) {
  return value == null ? null : JSON.stringify(value);
}

async function getDevice(env, userID) {
  const row = await env.DB.prepare("SELECT * FROM devices WHERE user_id = ? LIMIT 1")
    .bind(String(userID))
    .first();
  return deviceFromRow(row);
}

async function findDeviceByInviteCode(env, code) {
  const normalized = normalizeInviteCode(code);
  const row = await env.DB.prepare("SELECT * FROM devices WHERE invite_code = ? LIMIT 1")
    .bind(normalized)
    .first();
  return deviceFromRow(row);
}

async function findPingTarget(env, payload) {
  if (payload.friendID) {
    const byID = await getDevice(env, payload.friendID);
    if (byID) return byID;
  }
  return findDeviceByInviteCode(env, payload.friendHandle);
}

async function upsertDevice(env, device) {
  await env.DB.prepare(`
    INSERT INTO devices (
      user_id, user_name, invite_code, push_token, web_push_subscription, platform, app_version, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      user_name = excluded.user_name,
      invite_code = excluded.invite_code,
      push_token = excluded.push_token,
      web_push_subscription = excluded.web_push_subscription,
      platform = excluded.platform,
      app_version = excluded.app_version,
      updated_at = excluded.updated_at
  `).bind(
    device.userID,
    device.userName,
    device.inviteCode,
    device.pushToken,
    stringifyJSON(device.webPushSubscription),
    device.platform,
    device.appVersion,
    device.updatedAt
  ).run();
}

async function restoreKnownFriends(env, device, knownFriends) {
  if (!Array.isArray(knownFriends)) {
    return 0;
  }

  let restored = 0;
  for (const item of knownFriends.slice(0, 100)) {
    const friend = publicKnownFriend(item);
    if (!friend || friend.userID === device.userID || friend.inviteCode === device.inviteCode) {
      continue;
    }

    await ensureFriendship(env, device.userID, friend.userID);

    const previous = await getDevice(env, friend.userID);
    if (!previous) {
      await upsertDevice(env, {
        ...friend,
        pushToken: null,
        webPushSubscription: null,
        platform: "known-contact",
        appVersion: "known-contact",
        updatedAt: new Date().toISOString()
      });
    } else if (!previous.inviteCode || !previous.userName) {
      await upsertDevice(env, {
        ...previous,
        userName: previous.userName || friend.userName,
        inviteCode: previous.inviteCode || friend.inviteCode,
        updatedAt: previous.updatedAt ?? new Date().toISOString()
      });
    }

    restored += 1;
  }

  return restored;
}

function friendshipKey(firstUserID, secondUserID) {
  return [String(firstUserID), String(secondUserID)].sort().join(":");
}

async function findFriendship(env, firstUserID, secondUserID) {
  const key = friendshipKey(firstUserID, secondUserID);
  const row = await env.DB.prepare("SELECT * FROM friendships WHERE friendship_key = ? LIMIT 1")
    .bind(key)
    .first();
  return friendshipFromRow(row);
}

async function ensureFriendship(env, firstUserID, secondUserID) {
  const key = friendshipKey(firstUserID, secondUserID);
  const existing = await findFriendship(env, firstUserID, secondUserID);
  if (existing) {
    return existing;
  }

  const [userA, userB] = [String(firstUserID), String(secondUserID)].sort();
  const friendship = {
    id: `friendship_${crypto.randomUUID()}`,
    key,
    userIDs: [userA, userB],
    createdAt: new Date().toISOString()
  };

  await env.DB.prepare(`
    INSERT INTO friendships (id, friendship_key, user_a, user_b, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(friendship.id, friendship.key, userA, userB, friendship.createdAt).run();

  return friendship;
}

async function friendsForUser(env, userID) {
  const id = String(userID);
  const rows = await env.DB.prepare(`
    SELECT * FROM friendships
    WHERE user_a = ? OR user_b = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).bind(id, id).all();

  const friends = [];
  for (const row of rows.results) {
    const otherID = row.user_a === id ? row.user_b : row.user_a;
    const device = await getDevice(env, otherID);
    if (device) {
      friends.push(publicFriend(device));
    }
  }

  return friends;
}

async function pendingFriendRequest(env, senderID, targetUserID) {
  const row = await env.DB.prepare(`
    SELECT * FROM friend_requests
    WHERE sender_id = ? AND target_user_id = ? AND status = 'pending'
    LIMIT 1
  `).bind(String(senderID), String(targetUserID)).first();
  return friendRequestFromRow(row);
}

async function getFriendRequest(env, id) {
  const row = await env.DB.prepare("SELECT * FROM friend_requests WHERE id = ? LIMIT 1")
    .bind(id)
    .first();
  return friendRequestFromRow(row);
}

async function insertFriendRequest(env, record) {
  await env.DB.prepare(`
    INSERT INTO friend_requests (
      id, sender_id, sender_name, sender_invite_code, target_user_id, target_invite_code,
      status, created_at, responded_at, push
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    record.id,
    record.senderID,
    record.senderName,
    record.senderInviteCode,
    record.targetUserID,
    record.targetInviteCode,
    record.status,
    record.createdAt,
    record.respondedAt,
    stringifyJSON(record.push)
  ).run();
}

async function updateFriendRequestStatus(env, record) {
  await env.DB.prepare(`
    UPDATE friend_requests
    SET status = ?, responded_at = ?
    WHERE id = ?
  `).bind(record.status, record.respondedAt, record.id).run();
}

async function updateFriendRequestPush(env, id, push) {
  await env.DB.prepare("UPDATE friend_requests SET push = ? WHERE id = ?")
    .bind(stringifyJSON(push), id)
    .run();
}

async function insertPing(env, record) {
  await env.DB.prepare(`
    INSERT INTO pings (
      id, client_ping_id, status, received_at, target_user_id, payload, web_push, push
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    record.id,
    record.clientPingID,
    record.status,
    record.receivedAt,
    record.targetUserID,
    stringifyJSON(record.payload),
    stringifyJSON(record.webPush),
    stringifyJSON(record.push)
  ).run();
}

async function updatePingDelivery(env, record) {
  await env.DB.prepare(`
    UPDATE pings
    SET status = ?, web_push = ?, push = ?
    WHERE id = ?
  `).bind(record.status, stringifyJSON(record.webPush), stringifyJSON(record.push), record.id).run();
}

async function clearWebPushSubscription(env, userID) {
  await env.DB.prepare("UPDATE devices SET web_push_subscription = NULL WHERE user_id = ?")
    .bind(userID)
    .run();
}

async function trimTable(env, tableName, sortColumn, keep) {
  await env.DB.prepare(`
    DELETE FROM ${tableName}
    WHERE id NOT IN (
      SELECT id FROM ${tableName}
      ORDER BY ${sortColumn} DESC
      LIMIT ?
    )
  `).bind(keep).run();
}

function hasWebPushConfig(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

async function notifyFriendRequest(env, target, record) {
  if (!target?.webPushSubscription || !hasWebPushConfig(env)) {
    return null;
  }

  try {
    return await sendWebPushNotification(env, target.webPushSubscription, {
      title: "GamePing 친구 요청",
      body: `${record.senderName}님이 친구 요청을 보냈어.`,
      requestID: record.id,
      senderName: record.senderName,
      url: "/"
    });
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      await clearWebPushSubscription(env, target.userID);
    }

    return {
      skipped: false,
      statusCode: error.statusCode,
      error: error.body || error.message
    };
  }
}

async function deliverQueuedPingsForDevice(env, device) {
  if (!device?.webPushSubscription || !hasWebPushConfig(env)) {
    return 0;
  }

  const rows = await env.DB.prepare(`
    SELECT * FROM pings
    WHERE target_user_id = ? AND status = 'queued' AND web_push IS NULL AND push IS NULL
    ORDER BY received_at DESC
    LIMIT 10
  `).bind(device.userID).all();

  let delivered = 0;
  for (const row of rows.results) {
    const record = pingFromRow(row);
    try {
      record.webPush = await sendWebPushNotification(env, device.webPushSubscription, {
        title: `${record.payload.senderName ?? "GamePing"} 호출`,
        body: record.payload.notificationBody ?? record.payload.message,
        pingID: record.id,
        senderName: record.payload.senderName,
        message: record.payload.message,
        url: "/"
      });
      if (!record.webPush.skipped) {
        record.status = "sent";
        delivered += 1;
      }
    } catch (error) {
      record.webPush = {
        skipped: false,
        statusCode: error.statusCode,
        error: error.body || error.message
      };

      if (error.statusCode === 404 || error.statusCode === 410) {
        await clearWebPushSubscription(env, device.userID);
        await updatePingDelivery(env, record);
        break;
      }
    }

    await updatePingDelivery(env, record);
  }

  return delivered;
}

async function sendWebPushNotification(env, subscription, payload) {
  if (!hasWebPushConfig(env)) {
    return {
      skipped: true,
      reason: "Web Push VAPID environment variables are not configured"
    };
  }

  if (!subscription?.endpoint) {
    return {
      skipped: true,
      reason: "No Web Push subscription is registered"
    };
  }

  const body = await encryptWebPushPayload(subscription, JSON.stringify(payload));
  const jwt = await makeVAPIDJWT(env, subscription.endpoint);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "TTL": "60",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
    },
    body
  });

  if (!response.ok && response.status !== 201) {
    const error = new Error(`Web Push failed with ${response.status}`);
    error.statusCode = response.status;
    error.body = await response.text().catch(() => "");
    throw error;
  }

  return {
    skipped: false,
    statusCode: response.status
  };
}

async function makeVAPIDJWT(env, endpoint) {
  const publicKey = base64UrlToBytes(env.VAPID_PUBLIC_KEY);
  const privateKey = base64UrlToBytes(env.VAPID_PRIVATE_KEY);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(publicKey.slice(1, 33)),
    y: bytesToBase64Url(publicKey.slice(33, 65)),
    d: bytesToBase64Url(privateKey),
    ext: true
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToBase64Url(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || "mailto:gameping@example.com"
  })));
  const data = encoder.encode(`${header}.${claims}`);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  return `${header}.${claims}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function encryptWebPushPayload(subscription, payload) {
  const receiverPublicKeyBytes = base64UrlToBytes(subscription.keys.p256dh);
  const authSecret = base64UrlToBytes(subscription.keys.auth);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const senderKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const receiverPublicKey = await crypto.subtle.importKey(
    "raw",
    receiverPublicKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const senderPublicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", senderKeys.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: receiverPublicKey },
    senderKeys.privateKey,
    256
  ));

  const info = concatBytes(
    encoder.encode("WebPush: info"),
    new Uint8Array([0]),
    receiverPublicKeyBytes,
    senderPublicKeyBytes
  );
  const ikm = await hkdf(authSecret, sharedSecret, info, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const plaintext = concatBytes(encoder.encode(payload), new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    tagLength: 128
  }, key, plaintext));
  const header = new Uint8Array(16 + 4 + 1 + senderPublicKeyBytes.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = senderPublicKeyBytes.length;
  header.set(senderPublicKeyBytes, 21);
  return concatBytes(header, ciphertext);
}

async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  let previous = new Uint8Array(0);
  let output = new Uint8Array(0);
  let counter = 1;

  while (output.length < length) {
    previous = await hmac(prk, concatBytes(previous, info, new Uint8Array([counter])));
    output = concatBytes(output, previous);
    counter += 1;
  }

  return output.slice(0, length);
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

function base64UrlToBytes(value) {
  const normalized = String(value)
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(String(value).length / 4) * 4, "=");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function concatBytes(...arrays) {
  const length = arrays.reduce((sum, array) => sum + array.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}
