const STORAGE_KEY = "gameping.web.v1";
const COLORS = ["#1aa978", "#e23d38", "#eda31d", "#6650b5", "#353a3e"];
const DEVICE_REFRESH_INTERVAL_MS = 45_000;
const MESSAGE_BODIES = {
  "게임 시작": "게임 시작했어. 들어와!",
  "로비 와": "로비에서 기다리는 중.",
  "디코 와": "디스코드로 와줘.",
  "한 판 더": "한 판 더 가자."
};

const state = loadState();
applySharedToken();
let selectedMessage = "게임 시작";
let toastTimer = null;
let audioContext = null;
let serviceWorkerRegistration = null;
let serverAuthRequired = false;
let lastDeviceRegistrationAt = 0;
let isPartyEditing = false;
let draftPartyIDs = new Set(state.partyFriendIDs);

const els = {
  statusText: document.querySelector("#statusText"),
  pushStatus: document.querySelector("#pushStatus"),
  pushButton: document.querySelector("#pushButton"),
  profileButton: document.querySelector("#profileButton"),
  addFriendButton: document.querySelector("#addFriendButton"),
  partyCreateButton: document.querySelector("#partyCreateButton"),
  partyCancelButton: document.querySelector("#partyCancelButton"),
  partyDoneButton: document.querySelector("#partyDoneButton"),
  partyPanel: document.querySelector("#partyPanel"),
  partyButton: document.querySelector("#partyButton"),
  partyList: document.querySelector("#partyList"),
  friendRequestPanel: document.querySelector("#friendRequestPanel"),
  friendRequestList: document.querySelector("#friendRequestList"),
  friendList: document.querySelector("#friendList"),
  inboxList: document.querySelector("#inboxList"),
  recentList: document.querySelector("#recentList"),
  toast: document.querySelector("#toast"),
  profileDialog: document.querySelector("#profileDialog"),
  friendDialog: document.querySelector("#friendDialog"),
  profileNameInput: document.querySelector("#profileNameInput"),
  inviteCodeInput: document.querySelector("#inviteCodeInput"),
  apiTokenInput: document.querySelector("#apiTokenInput"),
  copyInviteButton: document.querySelector("#copyInviteButton"),
  saveProfileButton: document.querySelector("#saveProfileButton"),
  friendCodeInput: document.querySelector("#friendCodeInput"),
  resolveFriendButton: document.querySelector("#resolveFriendButton")
};

function loadState() {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  if (saved?.profile?.userID && saved?.profile?.inviteCode) {
    const userName = saved.profile.userName === "나" ? "플레이어" : saved.profile.userName;
    return {
      profile: {
        ...saved.profile,
        userName
      },
      friends: Array.isArray(saved.friends) ? saved.friends : [],
      friendRequests: [],
      recent: Array.isArray(saved.recent) ? saved.recent : [],
      inbox: Array.isArray(saved.inbox) ? saved.inbox : [],
      apiToken: saved.apiToken ?? "",
      partyFriendIDs: Array.isArray(saved.partyFriendIDs) ? saved.partyFriendIDs : [],
      lastPingAt: saved.lastPingAt ?? {}
    };
  }

  return {
    profile: {
      userID: makeID(),
      userName: "플레이어",
      inviteCode: makeInviteCode()
    },
    friends: [],
    friendRequests: [],
    recent: [],
    inbox: [],
    apiToken: "",
    partyFriendIDs: [],
    lastPingAt: {}
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function applySharedToken() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token") ?? url.searchParams.get("code");

  if (!token) {
    return;
  }

  state.apiToken = token.trim();
  saveState();

  url.searchParams.delete("token");
  url.searchParams.delete("code");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function makeInviteCode() {
  return `GP-${makeID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
}

function makeID() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join("")
  ].join("-");
}

function authHeaders() {
  return state.apiToken ? { Authorization: `Bearer ${state.apiToken}` } : {};
}

async function api(path, options = {}) {
  const headers = {
    ...authHeaders(),
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers ?? {})
  };
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

async function checkHealth() {
  try {
    const health = await api("/health");
    serverAuthRequired = Boolean(health.authRequired);
    els.statusText.textContent = health.authRequired && !state.apiToken ? "토큰 필요" : "서버 연결됨";
    updatePushUI();
    return health.ok;
  } catch {
    els.statusText.textContent = "서버 연결 실패";
    return false;
  }
}

async function registerDevice(webPushSubscription = null) {
  await api("/devices", {
    method: "POST",
    body: JSON.stringify({
      userID: state.profile.userID,
      userName: state.profile.userName,
      inviteCode: state.profile.inviteCode,
      pushToken: `WEB-${state.profile.userID}`,
      webPushSubscription: webPushSubscription?.toJSON?.() ?? webPushSubscription ?? undefined,
      knownFriends: state.friends.map(friend => ({
        userID: friend.id,
        userName: friend.name,
        inviteCode: friend.handle
      })),
      platform: "web",
      appVersion: "web"
    })
  });
}

async function refreshDeviceRegistration({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastDeviceRegistrationAt < DEVICE_REFRESH_INTERVAL_MS) {
    return false;
  }

  await registerDevice(await getExistingPushSubscription());
  lastDeviceRegistrationAt = Date.now();
  return true;
}

function pushSupported() {
  return Boolean("Notification" in window && "serviceWorker" in navigator && "PushManager" in window);
}

function updatePushUI(message = null) {
  if (!pushSupported()) {
    els.pushStatus.textContent = "알림 미지원";
    els.pushButton.disabled = true;
    return;
  }

  if (serverAuthRequired && !state.apiToken) {
    els.pushStatus.textContent = "토큰 필요";
    els.pushButton.disabled = false;
    els.pushButton.textContent = "토큰 입력";
    els.pushButton.classList.remove("enabled");
    return;
  }

  if (Notification.permission === "granted") {
    els.pushStatus.textContent = message ?? "알림 켜짐";
    els.pushButton.disabled = false;
    els.pushButton.textContent = "알림 켜짐";
    els.pushButton.classList.add("enabled");
    return;
  }

  if (Notification.permission === "denied") {
    els.pushStatus.textContent = "알림 차단됨";
    els.pushButton.disabled = true;
    els.pushButton.textContent = "차단됨";
    els.pushButton.classList.remove("enabled");
    return;
  }

  els.pushStatus.textContent = message ?? "알림 꺼짐";
  els.pushButton.disabled = false;
  els.pushButton.textContent = "알림 켜기";
  els.pushButton.classList.remove("enabled");
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = `${value}${padding}`.replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(character => character.charCodeAt(0)));
}

async function getExistingPushSubscription() {
  if (!pushSupported() || Notification.permission !== "granted") return null;
  const registration = serviceWorkerRegistration ?? await navigator.serviceWorker.ready;
  return await registration.pushManager.getSubscription();
}

async function enablePushNotifications() {
  if (!pushSupported()) {
    toast("이 브라우저는 알림 미지원");
    updatePushUI();
    return;
  }

  if (serverAuthRequired && !state.apiToken) {
    toast("토큰 먼저 입력");
    openProfile();
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      updatePushUI();
      toast("알림 권한 필요");
      return;
    }

    const registration = serviceWorkerRegistration ?? await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      const payload = await api("/push/public-key");
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(payload.publicKey)
      });
    }

    await registerDevice(subscription);
    lastDeviceRegistrationAt = Date.now();
    updatePushUI("알림 등록됨");
    toast("알림 켜짐");
  } catch {
    updatePushUI("알림 등록 실패");
    toast("알림 등록 실패");
  }
}

async function resolveFriend() {
  const code = els.friendCodeInput.value.trim();
  if (!code) {
    toast("초대 코드를 입력해줘.");
    return;
  }

  try {
    const targetInviteCode = normalizeCode(code);
    if (targetInviteCode === state.profile.inviteCode) {
      toast("내 코드는 추가할 수 없어.");
      return;
    }

    if (state.friends.some(item => item.handle === targetInviteCode)) {
      toast("이미 추가된 친구야.");
      return;
    }

    const payload = await api("/friend-requests", {
      method: "POST",
      body: JSON.stringify({
        senderID: state.profile.userID,
        senderName: state.profile.userName,
        senderInviteCode: state.profile.inviteCode,
        targetInviteCode
      })
    });

    els.friendCodeInput.value = "";
    els.friendDialog.close();

    if ((payload.status === "friends" || payload.status === "accepted") && payload.friend) {
      const friend = addOrUpdateFriend(payload.friend);
      saveState();
      render();
      toast(friend ? `${friend.name} 추가됨` : "친구 추가됨");
      return;
    }

    toast("친구 요청 보냄");
  } catch (error) {
    if (error.message === "Cannot add yourself") {
      toast("내 코드는 추가할 수 없어.");
      return;
    }

    if (error.message === "Invite code not found") {
      toast("코드를 찾지 못했어.");
      return;
    }

    toast("친구 요청 실패");
  }
}

function normalizeCode(code) {
  const compact = code.replaceAll(" ", "").toUpperCase();
  return compact.startsWith("GP-") ? compact : `GP-${compact}`;
}

function receiptLabel(status) {
  switch (status) {
  case "sent":
    return "알림 전송됨";
  case "queued":
    return "앱 열면 표시";
  case "unresolved":
    return "미등록";
  default:
    return "전송됨";
  }
}

function receiptToast(friend, status) {
  switch (status) {
  case "sent":
    return `${friend.name} 호출 완료`;
  case "queued":
    return "상대 앱 열면 표시됨";
  case "unresolved":
    return "상대 등록 필요";
  default:
    return "호출 저장됨";
  }
}

function normalizeFriendPayload(payload) {
  const id = String(payload.userID ?? payload.id ?? "").trim();
  if (!id) return null;

  const handle = String(payload.inviteCode ?? payload.handle ?? "").trim();
  const existing = state.friends.find(friend =>
    friend.id === id || (handle && friend.handle === handle)
  );

  return {
    id,
    name: String(payload.userName ?? payload.name ?? existing?.name ?? "친구"),
    handle,
    color: existing?.color ?? COLORS[state.friends.length % COLORS.length]
  };
}

function addOrUpdateFriend(payload) {
  const friend = normalizeFriendPayload(payload);
  if (!friend || friend.id === state.profile.userID) return null;

  const index = state.friends.findIndex(item =>
    item.id === friend.id || (friend.handle && item.handle === friend.handle)
  );

  if (index >= 0) {
    state.friends[index] = {
      ...state.friends[index],
      ...friend,
      color: state.friends[index].color
    };
    return state.friends[index];
  }

  state.friends.push(friend);
  return friend;
}

async function syncFriends() {
  try {
    const payload = await api(`/friends/${encodeURIComponent(state.profile.userID)}`);
    const before = state.friends.map(friend => `${friend.id}:${friend.name}:${friend.handle}`).join("|");

    for (const friend of payload.friends ?? []) {
      addOrUpdateFriend(friend);
    }

    const after = state.friends.map(friend => `${friend.id}:${friend.name}:${friend.handle}`).join("|");
    if (before !== after) {
      saveState();
      render();
    }
  } catch {
    // The app can still call locally saved friends if sync temporarily fails.
  }
}

async function pollFriendRequests({ notify = false } = {}) {
  try {
    const payload = await api(`/friend-requests/${encodeURIComponent(state.profile.userID)}`);
    const previousIDs = new Set(state.friendRequests.map(request => request.id));
    const incoming = payload.incoming ?? [];
    const hasNewRequest = incoming.some(request => !previousIDs.has(request.id));

    state.friendRequests = incoming;
    saveState();
    renderFriendRequests();

    if (notify && hasNewRequest && incoming[0]) {
      toast(`${incoming[0].senderName} 친구 요청`);
    }
  } catch {
    // Friend requests are non-blocking; keep the current UI if polling fails.
  }
}

async function respondFriendRequest(requestID, action) {
  const request = state.friendRequests.find(item => item.id === requestID);

  try {
    const payload = await api(`/friend-requests/${encodeURIComponent(requestID)}/respond`, {
      method: "POST",
      body: JSON.stringify({
        userID: state.profile.userID,
        action
      })
    });

    state.friendRequests = state.friendRequests.filter(item => item.id !== requestID);

    if (action === "accept" && payload.friend) {
      addOrUpdateFriend(payload.friend);
      toast(`${payload.friend.name ?? payload.friend.userName ?? request?.senderName ?? "친구"} 수락됨`);
    } else {
      toast("친구 요청 거절됨");
    }

    saveState();
    render();
    await syncFriends();
  } catch {
    toast("요청 처리 실패");
  }
}

async function pingFriend(friend, shouldToast = true) {
  const secondsLeft = cooldownSeconds(friend.id);
  if (secondsLeft > 0) {
    if (shouldToast) toast(`${secondsLeft}초 후 다시 가능`);
    return false;
  }

  refreshDeviceRegistration().catch(() => {});

  state.lastPingAt[friend.id] = Date.now();
  state.recent.unshift({
    id: makeID(),
    friendName: friend.name,
    message: selectedMessage,
    sentAt: new Date().toISOString(),
    state: "sending"
  });
  state.recent = state.recent.slice(0, 10);
  saveState();
  render();

  try {
    const receipt = await api("/pings", {
      method: "POST",
      body: JSON.stringify({
        senderName: state.profile.userName,
        friendID: friend.id,
        friendName: friend.name,
        friendHandle: friend.handle,
        message: selectedMessage,
        notificationBody: MESSAGE_BODIES[selectedMessage],
        sentAt: new Date().toISOString()
      })
    });
    state.recent[0].state = receiptLabel(receipt.status);
    if (shouldToast) toast(receiptToast(friend, receipt.status));
    return receipt.status !== "unresolved";
  } catch {
    state.recent[0].state = "실패";
    if (shouldToast) toast("전송 실패");
    return false;
  } finally {
    saveState();
    render();
  }
}

async function pingParty() {
  const friends = partyFriends();
  if (friends.length === 0) {
    toast("파티를 먼저 만들어줘.");
    return;
  }

  let count = 0;
  for (const friend of friends) {
    if (await pingFriend(friend, false)) {
      count += 1;
    }
  }
  toast(count > 0 ? `${count}명 호출 완료` : "호출 가능한 친구가 없어.");
}

function startPartyEdit() {
  if (state.friends.length === 0) {
    toast("친구를 먼저 추가해줘.");
    return;
  }

  draftPartyIDs = new Set(state.partyFriendIDs);
  isPartyEditing = true;
  render();
}

function cancelPartyEdit() {
  draftPartyIDs = new Set(state.partyFriendIDs);
  isPartyEditing = false;
  render();
}

function savePartyEdit() {
  state.partyFriendIDs = [...draftPartyIDs];
  isPartyEditing = false;
  saveState();
  render();
  toast(state.partyFriendIDs.length > 0 ? `${state.partyFriendIDs.length}명 파티 생성` : "파티 비움");
}

async function pollInbox({ notify = true } = {}) {
  try {
    const payload = await api(`/inbox/${encodeURIComponent(state.profile.userID)}`);
    const knownIDs = new Set(state.inbox.map(ping => ping.id));
    const incoming = payload.pings.filter(ping => !knownIDs.has(ping.id));

    if (incoming.length > 0) {
      state.inbox = [...incoming, ...state.inbox]
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
        .slice(0, 20);
      saveState();
      render();

      if (notify) {
        playPingSound();
        navigator.vibrate?.([120, 60, 120]);
        toast(`${incoming[0].senderName} 호출`);
      }
    }
  } catch {
    if (state.apiToken) {
      els.statusText.textContent = "토큰 확인 필요";
    }
  }
}

function cooldownSeconds(friendID) {
  const last = state.lastPingAt[friendID];
  if (!last) return 0;
  return Math.max(0, Math.ceil((30_000 - (Date.now() - last)) / 1000));
}

function initials(name) {
  return [...String(name || "?")][0] ?? "?";
}

function timeLabel(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function render() {
  els.profileButton.setAttribute("aria-label", `${state.profile.userName} 정보`);
  syncPartyWithFriends();
  renderFriends();
  renderFriendRequests();
  renderParty();
  renderInbox();
  renderRecent();
}

function syncPartyWithFriends() {
  const friendIDs = new Set(state.friends.map(friend => friend.id));
  const nextPartyIDs = state.partyFriendIDs.filter(id => friendIDs.has(id));
  if (nextPartyIDs.length !== state.partyFriendIDs.length) {
    state.partyFriendIDs = nextPartyIDs;
    saveState();
  }
  draftPartyIDs = new Set([...draftPartyIDs].filter(id => friendIDs.has(id)));
}

function partyFriends() {
  const partyIDs = new Set(state.partyFriendIDs);
  return state.friends.filter(friend => partyIDs.has(friend.id));
}

function renderFriends() {
  if (state.friends.length === 0) {
    isPartyEditing = false;
    els.partyCreateButton.textContent = "파티 만들기";
    els.partyCreateButton.disabled = true;
    els.partyCancelButton.classList.add("hidden");
    els.partyDoneButton.classList.add("hidden");
    els.friendList.innerHTML = `<div class="empty">오른쪽 위 + 버튼으로 친구 추가</div>`;
    return;
  }

  els.partyCreateButton.disabled = false;
  els.partyCreateButton.textContent = isPartyEditing
    ? `${draftPartyIDs.size}명 선택`
    : state.partyFriendIDs.length > 0 ? "파티 편집" : "파티 만들기";
  els.partyCreateButton.classList.toggle("editing", isPartyEditing);
  els.partyCancelButton.classList.toggle("hidden", !isPartyEditing);
  els.partyDoneButton.classList.toggle("hidden", !isPartyEditing);

  els.friendList.innerHTML = state.friends.map(friend => {
    const seconds = cooldownSeconds(friend.id);
    return `
      <article class="friend-row ${isPartyEditing ? "party-edit" : ""}">
        <div class="avatar" style="background:${friend.color}">${initials(friend.name)}</div>
        <div>
          <div class="row-title">${escapeHTML(friend.name)}</div>
          <div class="row-subtitle">${escapeHTML(friend.handle)}</div>
        </div>
        ${isPartyEditing ? `
          <label class="party-check" aria-label="${escapeHTML(friend.name)} 파티 선택">
            <input data-party-check="${friend.id}" type="checkbox" ${draftPartyIDs.has(friend.id) ? "checked" : ""}>
            <span></span>
          </label>
        ` : `
          <button class="call-button ${seconds > 0 ? "cooldown" : ""}" data-ping="${friend.id}" type="button">
            ${seconds > 0 ? `${seconds}s` : "호출"}
          </button>
        `}
      </article>
    `;
  }).join("");
}

function renderFriendRequests() {
  if (state.friendRequests.length === 0) {
    els.friendRequestPanel.classList.add("hidden");
    els.friendRequestList.innerHTML = "";
    return;
  }

  els.friendRequestPanel.classList.remove("hidden");
  els.friendRequestList.innerHTML = state.friendRequests.map(request => `
    <article class="request-row">
      <div class="avatar request-avatar">${initials(request.senderName)}</div>
      <div>
        <div class="row-title">${escapeHTML(request.senderName)}</div>
        <div class="row-subtitle">${escapeHTML(request.senderInviteCode)}</div>
      </div>
      <div class="request-actions">
        <button class="accept-button" data-request-action="accept" data-request-id="${escapeHTML(request.id)}" type="button">수락</button>
        <button class="reject-button" data-request-action="reject" data-request-id="${escapeHTML(request.id)}" type="button">거절</button>
      </div>
    </article>
  `).join("");
}

function renderParty() {
  const friends = partyFriends();
  const shouldShow = !isPartyEditing && friends.length > 0;
  els.partyPanel.classList.toggle("hidden", !shouldShow);

  if (!shouldShow) {
    els.partyList.innerHTML = "";
    return;
  }

  els.partyList.innerHTML = friends.map(friend => `
    <div class="party-member">
      <div class="party-avatar" style="background:${friend.color}">${initials(friend.name)}</div>
      <span>${escapeHTML(friend.name)}</span>
    </div>
  `).join("");
}

function renderInbox() {
  if (state.inbox.length === 0) {
    els.inboxList.innerHTML = `<div class="empty">새 호출 없음</div>`;
    return;
  }

  els.inboxList.innerHTML = state.inbox.slice(0, 4).map(ping => `
    <article class="inbox-row">
      <div class="mini-mark">알림</div>
      <div>
        <div class="row-title">${escapeHTML(ping.senderName)} <span class="row-subtitle">${escapeHTML(ping.message)}</span></div>
        <div class="row-subtitle">${escapeHTML(ping.body)}</div>
      </div>
      <div class="time-text">${timeLabel(ping.receivedAt)}</div>
    </article>
  `).join("");
}

function renderRecent() {
  if (state.recent.length === 0) {
    els.recentList.innerHTML = `<div class="empty">대기 중</div>`;
    return;
  }

  els.recentList.innerHTML = state.recent.slice(0, 4).map(ping => `
    <article class="recent-row">
      <div class="mini-mark">전송</div>
      <div>
        <div class="row-title">${escapeHTML(ping.friendName)}</div>
        <div class="row-subtitle">${escapeHTML(ping.message)} · ${escapeHTML(ping.state)}</div>
      </div>
      <div class="time-text">${timeLabel(ping.sentAt)}</div>
    </article>
  `).join("");
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  toastTimer = setTimeout(() => {
    els.toast.classList.remove("visible");
  }, 1900);
}

function openProfile() {
  els.profileNameInput.value = state.profile.userName;
  els.inviteCodeInput.value = state.profile.inviteCode;
  els.apiTokenInput.value = state.apiToken;
  updatePushUI();
  els.profileDialog.showModal();
}

async function saveProfile() {
  const name = els.profileNameInput.value.trim();
  state.profile.userName = name || "플레이어";
  state.apiToken = els.apiTokenInput.value.trim();
  saveState();
  render();
  try {
    await refreshDeviceRegistration({ force: true });
    await syncFriends();
    await pollFriendRequests({ notify: false });
    await pollInbox({ notify: false });
    updatePushUI();
    toast("저장 완료");
    els.profileDialog.close();
  } catch {
    toast("서버 저장 실패");
  }
}

async function copyInvite() {
  await navigator.clipboard?.writeText(state.profile.inviteCode);
  toast("초대 코드 복사됨");
}

function activateAudio() {
  audioContext ??= new AudioContext();
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
}

function playPingSound() {
  if (!audioContext || audioContext.state !== "running") return;

  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.frequency.setValueAtTime(740, audioContext.currentTime);
  oscillator.frequency.setValueAtTime(980, audioContext.currentTime + 0.08);
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.2, audioContext.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.22);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.24);
}

document.addEventListener("pointerdown", activateAudio, { once: true });

document.querySelectorAll("[data-message]").forEach(button => {
  button.addEventListener("click", () => {
    selectedMessage = button.dataset.message;
    document.querySelectorAll("[data-message]").forEach(item => item.classList.toggle("selected", item === button));
  });
});

els.profileButton.addEventListener("click", openProfile);
els.addFriendButton.addEventListener("click", () => els.friendDialog.showModal());
els.partyCreateButton.addEventListener("click", () => {
  if (isPartyEditing) return;
  startPartyEdit();
});
els.partyCancelButton.addEventListener("click", cancelPartyEdit);
els.partyDoneButton.addEventListener("click", savePartyEdit);
els.partyButton.addEventListener("click", pingParty);
els.copyInviteButton.addEventListener("click", copyInvite);
els.saveProfileButton.addEventListener("click", saveProfile);
els.resolveFriendButton.addEventListener("click", resolveFriend);
els.pushButton.addEventListener("click", enablePushNotifications);

els.friendList.addEventListener("click", event => {
  const button = event.target.closest("[data-ping]");
  if (!button) return;
  const friend = state.friends.find(item => item.id === button.dataset.ping);
  if (friend) pingFriend(friend);
});

els.friendList.addEventListener("change", event => {
  const checkbox = event.target.closest("[data-party-check]");
  if (!checkbox) return;

  if (checkbox.checked) {
    draftPartyIDs.add(checkbox.dataset.partyCheck);
  } else {
    draftPartyIDs.delete(checkbox.dataset.partyCheck);
  }
  renderFriends();
});

els.friendRequestList.addEventListener("click", event => {
  const button = event.target.closest("[data-request-action]");
  if (!button) return;
  respondFriendRequest(button.dataset.requestId, button.dataset.requestAction);
});

render();
updatePushUI();

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/service-worker.js")
    .then(registration => {
      serviceWorkerRegistration = registration;
      updatePushUI();
      return registration;
    })
    .catch(() => {
      updatePushUI("알림 준비 실패");
    });
}

checkHealth()
  .then(() => refreshDeviceRegistration({ force: true }))
  .then(syncFriends)
  .then(() => pollFriendRequests({ notify: false }))
  .then(() => pollInbox({ notify: false }))
  .then(updatePushUI)
  .catch(() => {
    els.statusText.textContent = "서버 연결 실패";
  });

setInterval(() => {
  renderFriends();
}, 1000);
setInterval(checkHealth, 10_000);
setInterval(() => refreshDeviceRegistration().catch(() => {}), DEVICE_REFRESH_INTERVAL_MS);
setInterval(syncFriends, 10_000);
setInterval(() => pollFriendRequests({ notify: true }), 4_000);
setInterval(() => pollInbox({ notify: true }), 3_000);

function resumeApp() {
  refreshDeviceRegistration({ force: true })
    .then(syncFriends)
    .then(() => pollFriendRequests({ notify: false }))
    .then(() => pollInbox({ notify: false }))
    .catch(() => {});
}

window.addEventListener("pageshow", resumeApp);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    resumeApp();
  }
});
