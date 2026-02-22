CREATE TABLE IF NOT EXISTS vod_reactions (
  vod_id TEXT PRIMARY KEY,
  likes INTEGER NOT NULL DEFAULT 0,
  dislikes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vod_reactions_updated_at ON vod_reactions(updated_at DESC);
