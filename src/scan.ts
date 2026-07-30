import { pruneSkillsNotIn, upsertSkill, type SourceRow } from "./db";
import { scanSkillBody } from "./security-scan";

// Generic tunnel for sources that don't publish sieve.index.json (i.e.
// everything except sieve itself) — walks the repo tree for any SKILL.md,
// parses YAML-ish frontmatter the same way sieve/scripts/validate-skill.mjs
// does (plain regex, never eval/exec), and upserts. External skills are
// always forced to tier "catalog" — guardrail tier means "always installed,
// no confirmation," and no external source gets to claim that.

const MAX_FILES_PER_SOURCE = 50;

export function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const m = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)$/) ?? trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

interface GhFrontmatter {
  name?: string;
  description?: string;
  tags?: string;
  version?: string;
}

export function parseFrontmatter(text: string): { fm: GhFrontmatter; body: string } | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4);
  const fm: Record<string, string> = {};
  let key: string | null = null;
  for (const line of raw.split("\n")) {
    const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (m) {
      key = m[1];
      const val = m[2].trim();
      fm[key] = val === "" || val === ">" || val === "|" ? "" : val.replace(/^["']|["']$/g, "");
    } else if (key && line.trim()) {
      fm[key] = (fm[key] ? fm[key] + " " : "") + line.trim().replace(/^-\s*/, "");
    }
  }
  return { fm, body };
}

function deriveCategory(path: string): string {
  // "skills/testing/test-driven-development/SKILL.md" -> "testing"
  // "skills/receiving-code-review/SKILL.md" -> no category segment -> "uncategorized"
  const m = path.match(/(?:^|\/)skills\/([^/]+)\/([^/]+)\/SKILL\.md$/);
  return m ? m[1] : "uncategorized";
}

function skillNameFromPath(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 2] ?? parts[0];
}

function ghHeaders(githubToken?: string): HeadersInit {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "sieve-registry" };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  return headers;
}

export async function getDefaultBranch(owner: string, repo: string, githubToken?: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders(githubToken) });
  if (!res.ok) throw new Error(`repo lookup ${owner}/${repo} -> ${res.status}`);
  const data = (await res.json()) as { default_branch?: string };
  return data.default_branch ?? "main";
}

export async function getCurrentCommitSha(owner: string, repo: string, ref: string, githubToken?: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}`, { headers: ghHeaders(githubToken) });
  if (!res.ok) throw new Error(`commit lookup ${owner}/${repo}@${ref} -> ${res.status}`);
  const data = (await res.json()) as { sha?: string };
  if (!data.sha) throw new Error(`commit lookup ${owner}/${repo}@${ref} returned no sha`);
  return data.sha;
}

// Curated sources sync at a specific, human-reviewed commit (pinned_sha) so
// a later compromise of the upstream repo can't reach the registry without
// a deliberate re-review. 'user' sources (self-service, already surfaced as
// unverified) and curated sources with no pin yet fall back to whatever the
// default branch currently is — unchanged, pre-pinning behavior.
async function resolveRef(source: SourceRow, owner: string, repo: string, githubToken?: string): Promise<string> {
  if (source.kind === "curated" && source.pinned_sha) return source.pinned_sha;
  return getDefaultBranch(owner, repo, githubToken);
}

interface SkillMdEntry {
  path: string;
  sha: string;
}

async function listSkillMdEntries(owner: string, repo: string, branch: string, githubToken?: string): Promise<SkillMdEntry[]> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, {
    headers: ghHeaders(githubToken),
  });
  if (!res.ok) throw new Error(`tree lookup ${owner}/${repo}@${branch} -> ${res.status}`);
  const data = (await res.json()) as { tree?: { path: string; type: string; sha: string }[] };
  return (data.tree ?? [])
    .filter((e) => e.type === "blob" && e.path.endsWith("SKILL.md"))
    .map((e) => ({ path: e.path, sha: e.sha }))
    .slice(0, MAX_FILES_PER_SOURCE);
}

export interface ScanResult {
  upserted: number;
  removed: number;
  skippedFailures: string[];
  flagged: string[];
}

export async function syncGenericSource(db: D1Database, source: SourceRow, githubToken?: string): Promise<ScanResult> {
  const parsed = parseRepoUrl(source.repo_url);
  if (!parsed) throw new Error(`unparseable repo_url: ${source.repo_url}`);
  const { owner, repo } = parsed;

  const ref = await resolveRef(source, owner, repo, githubToken);
  const entries = await listSkillMdEntries(owner, repo, ref, githubToken);

  const synced: string[] = [];
  const skippedFailures: string[] = [];
  const flagged: string[] = [];

  for (const { path, sha } of entries) {
    const rawRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`);
    if (!rawRes.ok) {
      skippedFailures.push(path);
      continue;
    }
    const text = await rawRes.text();
    const parsedFm = parseFrontmatter(text);
    if (!parsedFm?.fm.name || !parsedFm.fm.description) {
      skippedFailures.push(path);
      continue;
    }
    const { fm } = parsedFm;
    const name: string = fm.name ?? skillNameFromPath(path);
    const description: string = fm.description ?? "";
    const scan = scanSkillBody(text);
    if (scan.flagged) flagged.push(name);
    await upsertSkill(db, {
      source_id: source.id,
      name,
      category: deriveCategory(path),
      tier: "catalog", // never trust a non-sieve source to declare guardrail tier
      description,
      tags: fm.tags ? fm.tags.split(/[,\s]+/).filter(Boolean) : [],
      // Prefer the author's own version string; fall back to the blob's git
      // sha (short form) rather than a fixed "external" that made every
      // unversioned skill from every connected source indistinguishable.
      version: fm.version || sha.slice(0, 12),
      last_reviewed: new Date().toISOString().slice(0, 10),
      body: text,
      blob_sha: sha,
      validated: false, // generic scan, never run through validate-skill.mjs
      flagged: scan.flagged,
      flag_reason: scan.reasons,
    });
    synced.push(name);
  }

  const removed = await pruneSkillsNotIn(db, source.id, synced);
  return { upserted: synced.length, removed, skippedFailures, flagged };
}
