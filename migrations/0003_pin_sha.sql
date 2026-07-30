-- blob_sha: the git blob SHA of the source SKILL.md (generic sources) or a
-- content identity for sieve's own catalog path — gives every skill row a
-- real pinnable identity instead of relying on an author-supplied `version`
-- field that most external SKILL.md files never set.
--
-- validated: whether this row came through sieve's own validate-skill.mjs
-- gate (curated, via sync.ts) or a generic unreviewed scan (connected
-- Sources, via scan.ts). Surfaced in sieve-dashboard as a trust signal.
ALTER TABLE skills ADD COLUMN blob_sha TEXT;
ALTER TABLE skills ADD COLUMN validated INTEGER NOT NULL DEFAULT 0;
