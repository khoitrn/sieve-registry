-- MIT licensed (verified via GitHub API before adding). Starts unpinned —
-- resolveRef() in scan.ts falls back to the default branch until an admin
-- explicitly pins a reviewed commit via POST /api/admin/sources/:id/pin,
-- the same human-review gate every other curated source goes through.
INSERT INTO sources (id, repo_url, kind, status)
VALUES ('github:mattpocock/skills', 'https://github.com/mattpocock/skills', 'curated', 'active')
ON CONFLICT(id) DO NOTHING;
