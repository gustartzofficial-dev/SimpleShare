-- SimpleShare P2P fallback storage.
--
-- Paste this whole file into the Cloudflare dashboard:
--   Storage & Databases -> D1 -> simpleshare -> Console
-- and run it once. Safe to run again; every statement is IF NOT EXISTS.
--
-- This exists only to keep signaling alive after the Durable Object daily
-- budget is exhausted. D1 has its own separate allowance, so this path
-- survives when RoomHub cannot answer.

CREATE TABLE IF NOT EXISTS p2p_participants (
  room      TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  name      TEXT    NOT NULL,
  token     TEXT    NOT NULL,
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (room, id)
);
CREATE INDEX IF NOT EXISTS p2p_participants_live ON p2p_participants (room, last_seen);

CREATE TABLE IF NOT EXISTS p2p_streams (
  room       TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  owner_id   TEXT    NOT NULL,
  owner_name TEXT    NOT NULL,
  profile    TEXT    NOT NULL,
  audio      INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (room, id)
);
CREATE INDEX IF NOT EXISTS p2p_streams_room ON p2p_streams (room);

-- One row per SDP offer/answer/ICE candidate in flight. Rows are read by
-- cursor (seq) and deleted on a TTL sweep, never per-read, so draining an
-- inbox costs reads rather than writes.
CREATE TABLE IF NOT EXISTS p2p_signals (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  room       TEXT    NOT NULL,
  target     TEXT    NOT NULL,
  sender     TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS p2p_signals_inbox ON p2p_signals (room, target, seq);
CREATE INDEX IF NOT EXISTS p2p_signals_age   ON p2p_signals (created_at);
