export interface SkillRow {
  source_id: string;
  name: string;
  category: string;
  tier: string;
  description: string;
  tags: string; // JSON-encoded string[]
  version: string;
  last_reviewed: string;
  body: string;
  updated_at: string;
}

export interface Skill extends Omit<SkillRow, "tags"> {
  tags: string[];
}

function toSkill(row: SkillRow): Skill {
  return { ...row, tags: JSON.parse(row.tags) };
}

// sourceIds: undefined -> all skills (used by admin/sync tooling only).
// [] -> no skills (a caller with zero eligible sources). Otherwise scoped.
export async function listSkills(db: D1Database, sourceIds?: string[]): Promise<Skill[]> {
  if (sourceIds && sourceIds.length === 0) return [];
  if (!sourceIds) {
    const res = await db.prepare("SELECT * FROM skills ORDER BY category, name").all<SkillRow>();
    return (res.results ?? []).map(toSkill);
  }
  const placeholders = sourceIds.map((_, i) => `?${i + 1}`).join(", ");
  const res = await db
    .prepare(`SELECT * FROM skills WHERE source_id IN (${placeholders}) ORDER BY category, name`)
    .bind(...sourceIds)
    .all<SkillRow>();
  return (res.results ?? []).map(toSkill);
}

export async function upsertSkill(
  db: D1Database,
  skill: Omit<SkillRow, "tags" | "updated_at"> & { tags: string[] },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO skills (source_id, name, category, tier, description, tags, version, last_reviewed, body, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
       ON CONFLICT(source_id, name) DO UPDATE SET
         category = excluded.category,
         tier = excluded.tier,
         description = excluded.description,
         tags = excluded.tags,
         version = excluded.version,
         last_reviewed = excluded.last_reviewed,
         body = excluded.body,
         updated_at = datetime('now')`,
    )
    .bind(
      skill.source_id,
      skill.name,
      skill.category,
      skill.tier,
      skill.description,
      JSON.stringify(skill.tags),
      skill.version,
      skill.last_reviewed,
      skill.body,
    )
    .run();
}

// Removes any skill row for this source whose name is no longer present
// upstream (e.g. deleted from the source repo). Returns how many were removed.
export async function pruneSkillsNotIn(db: D1Database, sourceId: string, keepNames: string[]): Promise<number> {
  if (keepNames.length === 0) return 0; // never wipe a source's skills on an empty/failed scan
  const placeholders = keepNames.map((_, i) => `?${i + 2}`).join(", ");
  const res = await db
    .prepare(`DELETE FROM skills WHERE source_id = ?1 AND name NOT IN (${placeholders})`)
    .bind(sourceId, ...keepNames)
    .run();
  return res.meta.changes ?? 0;
}

export interface SourceRow {
  id: string;
  repo_url: string;
  kind: "curated" | "user";
  added_by: string | null;
  status: string;
  last_synced_at: string | null;
  created_at: string;
}

export async function listAllSources(db: D1Database): Promise<SourceRow[]> {
  const res = await db.prepare("SELECT * FROM sources ORDER BY created_at").all<SourceRow>();
  return res.results ?? [];
}

// Curated sources (visible to everyone) plus, if login is given, that
// user's own sources. Never another user's sources.
export async function listVisibleSources(db: D1Database, login: string | null): Promise<SourceRow[]> {
  if (!login) {
    const res = await db.prepare("SELECT * FROM sources WHERE kind = 'curated' ORDER BY created_at").all<SourceRow>();
    return res.results ?? [];
  }
  const res = await db
    .prepare("SELECT * FROM sources WHERE kind = 'curated' OR added_by = ?1 ORDER BY created_at")
    .bind(login)
    .all<SourceRow>();
  return res.results ?? [];
}

// Curated source ids (always eligible for recommend/skills) plus, if login
// is given, that user's own source ids. This is what scopes a query, as
// opposed to listVisibleSources which returns full rows for display.
export async function resolveSourceIds(db: D1Database, login: string | null): Promise<string[]> {
  const rows = await listVisibleSources(db, login);
  return rows.map((r) => r.id);
}

export async function createSource(db: D1Database, id: string, repoUrl: string, login: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sources (id, repo_url, kind, added_by, status)
       VALUES (?1, ?2, 'user', ?3, 'active')
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, repoUrl, login)
    .run();
}

export async function markSourceStatus(db: D1Database, id: string, status: string): Promise<void> {
  await db
    .prepare(`UPDATE sources SET status = ?2, last_synced_at = datetime('now') WHERE id = ?1`)
    .bind(id, status)
    .run();
}

// Returns true if the source (and its skills) were deleted; false if it
// didn't exist or the caller doesn't own it (curated sources, added_by IS
// NULL, are never deletable here). Ownership is checked with a read-only
// SELECT first — no mutation happens unless it passes — then skills are
// deleted before their parent sources row, satisfying the FK constraint.
export async function deleteSource(db: D1Database, id: string, login: string): Promise<boolean> {
  const owned = await db.prepare(`SELECT 1 FROM sources WHERE id = ?1 AND added_by = ?2`).bind(id, login).first();
  if (!owned) return false;
  await db.prepare(`DELETE FROM skills WHERE source_id = ?1`).bind(id).run();
  await db.prepare(`DELETE FROM sources WHERE id = ?1`).bind(id).run();
  return true;
}

// One per-user virtual source for hand-authored skills — no backing repo,
// never scanned/synced (see sync.ts's "custom:" skip), just directly
// written to. Scoped to the GitHub login, not any repo, per design.
export function authoredSourceId(login: string): string {
  return `custom:${login}`;
}

export async function ensureAuthoredSource(db: D1Database, login: string): Promise<string> {
  const id = authoredSourceId(login);
  await db
    .prepare(
      `INSERT INTO sources (id, repo_url, kind, added_by, status)
       VALUES (?1, ?1, 'user', ?2, 'active')
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, login)
    .run();
  return id;
}

export async function deleteOwnSkill(db: D1Database, sourceId: string, name: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM skills WHERE source_id = ?1 AND name = ?2`).bind(sourceId, name).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function createProject(db: D1Database, id: string, repo: string | null): Promise<void> {
  await db
    .prepare(`INSERT INTO projects (id, repo) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET repo = excluded.repo`)
    .bind(id, repo)
    .run();
}

export async function assignSkill(db: D1Database, projectId: string, sourceId: string, skillName: string, version: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO assignments (project_id, source_id, skill_name, version)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(project_id, skill_name) DO UPDATE SET source_id = excluded.source_id, version = excluded.version, assigned_at = datetime('now')`,
    )
    .bind(projectId, sourceId, skillName, version)
    .run();
}

export interface AssignmentRow {
  source_id: string;
  skill_name: string;
  version: string;
  assigned_at: string;
}

export async function listAssignments(db: D1Database, projectId: string): Promise<AssignmentRow[]> {
  const res = await db
    .prepare(`SELECT source_id, skill_name, version, assigned_at FROM assignments WHERE project_id = ?1 ORDER BY skill_name`)
    .bind(projectId)
    .all<AssignmentRow>();
  return res.results ?? [];
}
