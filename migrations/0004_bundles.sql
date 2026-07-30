-- Curated, hand-seeded groups of skills known to work well together for a
-- given situation (mode tags today; stack tags once onboard.mjs's
-- --detect-stack starts producing them and stack-specific skills exist to
-- match). No user-submitted bundles — same trust posture as guardrails.
CREATE TABLE IF NOT EXISTS bundles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  skill_names TEXT NOT NULL, -- JSON array of skill names
  match_tags  TEXT NOT NULL DEFAULT '[]' -- JSON array, intersected against recommend's mode/focus tags
);

INSERT INTO bundles (id, name, description, skill_names, match_tags)
VALUES (
  'existing-project-core',
  'Existing project core loop',
  'Read the current context before proposing anything, then find the real cause instead of guessing when something breaks.',
  '["acknowledge-project","systematic-debugging"]',
  '["context","root-cause"]'
)
ON CONFLICT(id) DO NOTHING;
