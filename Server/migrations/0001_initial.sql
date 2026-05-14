CREATE TABLE IF NOT EXISTS devices (
  user_id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  push_token TEXT,
  web_push_subscription TEXT,
  platform TEXT NOT NULL DEFAULT 'web',
  app_version TEXT NOT NULL DEFAULT 'dev',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_invite_code ON devices(invite_code);

CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY,
  friendship_key TEXT NOT NULL UNIQUE,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friendships_user_a ON friendships(user_a);
CREATE INDEX IF NOT EXISTS idx_friendships_user_b ON friendships(user_b);

CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  sender_invite_code TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  target_invite_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  responded_at TEXT,
  push TEXT
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_target ON friend_requests(target_user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_friend_requests_sender ON friend_requests(sender_id, status, created_at);

CREATE TABLE IF NOT EXISTS pings (
  id TEXT PRIMARY KEY,
  client_ping_id TEXT UNIQUE,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  target_user_id TEXT,
  payload TEXT NOT NULL,
  web_push TEXT,
  push TEXT
);

CREATE INDEX IF NOT EXISTS idx_pings_target ON pings(target_user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_pings_client_ping_id ON pings(client_ping_id);
