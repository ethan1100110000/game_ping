const STORAGE_KEY = "gameping.web.v1";
const COLORS = ["#1aa978", "#e23d38", "#eda31d", "#6650b5", "#353a3e"];
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

const els = {
  statusText: document.querySelector("#statusText"),
  profileButton: document.querySelector("#profileButton"),
  addFriendButton: document.querySelector("#addFriendButton"),
  partyButton: document.querySelector("#partyButton"),
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
    return {
      profile: saved.profile,
      friends: Array.isArray(saved.friends) ? saved.friends : [],
      recent: Array.isArray(saved.recent) ? saved.recent : [],
      inbox: Array.isArray(saved.inbox) ? saved.inbox : [],
      apiToken: saved.apiToken ?? "",
      lastPingAt: saved.lastPingAt ?? {}
    };
  }

  return {
    profile: {
      userID: makeID(),
      userName: "나",
      inviteCode: makeInviteCode()
    },
    friends: [],
    recent: [],
    inbox: [],
    apiToken: "",
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
    els.statusText.textContent = health.authRequired && !state.apiToken ? "토큰 필요" : "서버 연결됨";
    return health.ok;
  } catch {
    els.statusText.textContent = "서버 연결 실패";
    return false;
  }
}

async function registerDevice() {
  await api("/devices", {
    method: "POST",
    body: JSON.stringify({
      userID: state.profile.userID,
      userName: state.profile.userName,
      inviteCode: state.profile.inviteCode,
      pushToken: `WEB-${state.profile.userID}`,
      platform: "web",
      appVersion: "web"
    })
  });
}

async function resolveFriend() {
  const code = els.friendCodeInput.value.trim();
  if (!code) {
    toast("초대 코드를 입력해줘.");
    return;
  }

  try {
    const payload = await api(`/invites/${encodeURIComponent(normalizeCode(code))}`);
    const friend = {
      id: payload.friend.userID,
      name: payload.friend.userName,
      handle: payload.friend.inviteCode,
      color: COLORS[state.friends.length % COLORS.length]
    };

    if (friend.id === state.profile.userID) {
      toast("내 코드는 추가할 수 없어.");
      return;
    }

    if (state.friends.some(item => item.id === friend.id || item.handle === friend.handle)) {
      toast("이미 추가된 친구야.");
      return;
    }

    state.friends.push(friend);
    saveState();
    render();
    els.friendCodeInput.value = "";
    els.friendDialog.close();
    toast(`${friend.name} 추가됨`);
  } catch {
    toast("코드를 찾지 못했어.");
  }
}

function normalizeCode(code) {
  const compact = code.replaceAll(" ", "").toUpperCase();
  return compact.startsWith("GP-") ? compact : `GP-${compact}`;
}

async function pingFriend(friend, shouldToast = true) {
  const secondsLeft = cooldownSeconds(friend.id);
  if (secondsLeft > 0) {
    if (shouldToast) toast(`${secondsLeft}초 후 다시 가능`);
    return false;
  }

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
    state.recent[0].state = receipt.status === "unresolved" ? "미등록" : "전송됨";
    if (shouldToast) toast(`${friend.name} 호출 완료`);
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
  if (state.friends.length === 0) {
    toast("친구를 먼저 추가해줘.");
    return;
  }

  let count = 0;
  for (const friend of state.friends) {
    if (await pingFriend(friend, false)) {
      count += 1;
    }
  }
  toast(count > 0 ? `${count}명 호출 완료` : "호출 가능한 친구가 없어.");
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
  els.profileButton.textContent = initials(state.profile.userName);
  renderFriends();
  renderInbox();
  renderRecent();
}

function renderFriends() {
  if (state.friends.length === 0) {
    els.friendList.innerHTML = `<div class="empty">오른쪽 위 + 버튼으로 친구 추가</div>`;
    return;
  }

  els.friendList.innerHTML = state.friends.map(friend => {
    const seconds = cooldownSeconds(friend.id);
    return `
      <article class="friend-row">
        <div class="avatar" style="background:${friend.color}">${initials(friend.name)}</div>
        <div>
          <div class="row-title">${escapeHTML(friend.name)}</div>
          <div class="row-subtitle">${escapeHTML(friend.handle)}</div>
        </div>
        <button class="call-button ${seconds > 0 ? "cooldown" : ""}" data-ping="${friend.id}" type="button">
          ${seconds > 0 ? `${seconds}s` : "호출"}
        </button>
      </article>
    `;
  }).join("");
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
  els.profileDialog.showModal();
}

async function saveProfile() {
  const name = els.profileNameInput.value.trim();
  state.profile.userName = name || "나";
  state.apiToken = els.apiTokenInput.value.trim();
  saveState();
  render();
  try {
    await registerDevice();
    await pollInbox({ notify: false });
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
els.partyButton.addEventListener("click", pingParty);
els.copyInviteButton.addEventListener("click", copyInvite);
els.saveProfileButton.addEventListener("click", saveProfile);
els.resolveFriendButton.addEventListener("click", resolveFriend);

els.friendList.addEventListener("click", event => {
  const button = event.target.closest("[data-ping]");
  if (!button) return;
  const friend = state.friends.find(item => item.id === button.dataset.ping);
  if (friend) pingFriend(friend);
});

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}

render();
checkHealth()
  .then(registerDevice)
  .then(() => pollInbox({ notify: false }))
  .catch(() => {
    els.statusText.textContent = "서버 연결 실패";
  });

setInterval(() => {
  renderFriends();
}, 1000);
setInterval(checkHealth, 10_000);
setInterval(() => pollInbox({ notify: true }), 3_000);
