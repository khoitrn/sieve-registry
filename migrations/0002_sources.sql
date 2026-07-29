CREATE TABLE IF NOT EXISTS sources (
  id             TEXT PRIMARY KEY,             -- e.g. "github:khoitrn/sieve"
  repo_url       TEXT NOT NULL,
  kind           TEXT NOT NULL,                -- 'curated' | 'user'
  added_by       TEXT,                         -- GitHub login; NULL for curated
  status         TEXT NOT NULL DEFAULT 'active',
  last_synced_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sources (id, repo_url, kind, status)
VALUES ('github:khoitrn/sieve', 'https://github.com/khoitrn/sieve', 'curated', 'active')
ON CONFLICT(id) DO NOTHING;

-- SQLite can't add a column into a composite primary key in place; recreate.
CREATE TABLE skills_new (
  source_id     TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  category      TEXT    NOT NULL,
  tier          TEXT    NOT NULL,
  description   TEXT    NOT NULL,
  tags          TEXT    NOT NULL DEFAULT '[]',
  version       TEXT    NOT NULL,
  last_reviewed TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, name),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

INSERT INTO skills_new (source_id, name, category, tier, description, tags, version, last_reviewed, body, updated_at)
SELECT 'github:khoitrn/sieve', name, category, tier, description, tags, version, last_reviewed, body, updated_at
FROM skills;

DROP TABLE skills;
ALTER TABLE skills_new RENAME TO skills;

ALTER TABLE assignments ADD COLUMN source_id TEXT NOT NULL DEFAULT 'github:khoitrn/sieve';

CREATE INDEX IF NOT EXISTS idx_skills_source ON skills (source_id);
CREATE INDEX IF NOT EXISTS idx_sources_added_by ON sources (added_by);
