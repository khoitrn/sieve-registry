-- pinned_sha: for curated sources only, the commit SHA the owner has
-- actually reviewed. When set, syncGenericSource fetches at this exact
-- commit instead of the mutable default branch HEAD, so a later compromise
-- of the upstream repo can't reach the registry until a human deliberately
-- reviews the diff and advances the pin (POST /api/admin/sources/:id/pin).
-- NULL for 'user' sources — those are self-service and already surfaced as
-- unverified, so pinning them would just be friction with no trust payoff.
ALTER TABLE sources ADD COLUMN pinned_sha TEXT;

-- flagged/flag_reason: heuristic security-scan result, set at sync time by
-- src/security-scan.ts. A pattern-match gate (shell-exec pipelines,
-- prompt-injection phrasing, credential-exfiltration shape, obfuscated
-- blobs) — a first-pass filter, not a substitute for the curated-source
-- review itself. Surfaced, never silently blocking a sync.
ALTER TABLE skills ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN flag_reason TEXT;

-- No baseline backfill here: pinned_sha is a repo-level commit SHA, which
-- isn't derivable from the per-file blob_sha rows already in the table.
-- Existing curated sources stay unpinned (falls back to default-branch HEAD,
-- today's behavior, unchanged) until POST /api/admin/sources/:id/pin sets a
-- real baseline by asking GitHub for the current commit SHA.
