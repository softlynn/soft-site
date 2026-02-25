CREATE TABLE IF NOT EXISTS vod_reactions (
  vod_id TEXT PRIMARY KEY,
  likes INTEGER NOT NULL DEFAULT 0,
  dislikes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vod_reactions_updated_at ON vod_reactions(updated_at DESC);

CREATE TABLE IF NOT EXISTS vod_upload_sessions (
  session_id TEXT PRIMARY KEY,
  twitch_vod_id TEXT,
  part_number INTEGER,
  title TEXT,
  recording_name TEXT,
  stream_date TEXT,
  state TEXT NOT NULL,
  message TEXT,
  percent REAL,
  uploaded_bytes INTEGER,
  total_bytes INTEGER,
  youtube_video_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vod_upload_sessions_state_updated ON vod_upload_sessions(state, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_vod_upload_sessions_expires ON vod_upload_sessions(expires_at_ms);
