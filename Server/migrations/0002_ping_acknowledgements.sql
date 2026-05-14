ALTER TABLE pings ADD COLUMN ack_token TEXT;
ALTER TABLE pings ADD COLUMN acknowledged_at TEXT;
ALTER TABLE pings ADD COLUMN acknowledged_by_id TEXT;
ALTER TABLE pings ADD COLUMN acknowledged_by_name TEXT;
ALTER TABLE pings ADD COLUMN ack_push TEXT;
