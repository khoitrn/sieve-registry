export interface SkillRow {
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

export async function listSkills(db: D1Database): Promise<Skill[]> {
  const res = await db.prepare("SELECT * FROM skills ORDER BY category, name").all<SkillRow>();
  return (res.results ?? []).map(toSkill);
}

export async function upsertSkill(db: D1Database, skill: Omit<SkillRow, "tags" | "updated_at"> & { tags: string[] }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO skills (name, category, tier, description, tags, version, last_reviewed, body, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))
       ON CONFLICT(name) DO UPDATE SET
         category = excluded.category,
         tier = excluded.tier,
         description = excluded.description,
         tags = excluded.tags,
         version = excluded.version,
         last_reviewed = excluded.last_reviewed,
         body = excluded.body,
         updated_at = datetime('now')`,
    )
    .bind(skill.name, skill.category, skill.tier, skill.description, JSON.stringify(skill.tags), skill.version, skill.last_reviewed, skill.body)
    .run();
}

export async function createProject(db: D1Database, id: string, repo: string | null): Promise<void> {
  await db
    .prepare(`INSERT INTO projects (id, repo) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET repo = excluded.repo`)
    .bind(id, repo)
    .run();
}

export async function assignSkill(db: D1Database, projectId: string, skillName: string, version: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO assignments (project_id, skill_name, version)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(project_id, skill_name) DO UPDATE SET version = excluded.version, assigned_at = datetime('now')`,
    )
    .bind(projectId, skillName, version)
    .run();
}

export interface AssignmentRow {
  skill_name: string;
  version: string;
  assigned_at: string;
}

export async function listAssignments(db: D1Database, projectId: string): Promise<AssignmentRow[]> {
  const res = await db
    .prepare(`SELECT skill_name, version, assigned_at FROM assignments WHERE project_id = ?1 ORDER BY skill_name`)
    .bind(projectId)
    .all<AssignmentRow>();
  return res.results ?? [];
}
