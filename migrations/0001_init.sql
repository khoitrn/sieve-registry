CREATE TABLE IF NOT EXISTS skills (
  name          TEXT    PRIMARY KEY,
  category      TEXT    NOT NULL,
  tier          TEXT    NOT NULL,
  description   TEXT    NOT NULL,
  tags          TEXT    NOT NULL DEFAULT '[]',
  version       TEXT    NOT NULL,
  last_reviewed TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  repo       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assignments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT    NOT NULL,
  skill_name   TEXT    NOT NULL,
  version      TEXT    NOT NULL,
  assigned_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, skill_name),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_assignments_project ON assignments (project_id);
