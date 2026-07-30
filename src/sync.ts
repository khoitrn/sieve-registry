import { listAllSources, markSourceStatus, pruneSkillsNotIn, upsertSkill } from "./db";
import { syncGenericSource } from "./scan";
import { scanSkillBody } from "./security-scan";

// The tunnel: pulls sieve.index.json + every skill body straight from
// sieve's own repo (public, so no auth needed — same raw.githubusercontent.com
// pattern sieve-dashboard already uses) and upserts them into D1. Run on a
// Cron Trigger so the registry stays current without a manual seed step, and
// exposed as an on-demand endpoint for an immediate refresh right after a push.

const SIEVE_RAW_BASE = "https://raw.githubusercontent.com/khoitrn/sieve/main";
export const SIEVE_SOURCE_ID = "github:khoitrn/sieve";

interface SieveIndexSkill {
  name: string;
  category: string;
  tier: string;
  description: string;
  tags?: string[];
  version: string;
  last_reviewed: string;
  url: string;
}

interface SieveIndex {
  skills: SieveIndexSkill[];
}

export interface SyncResult {
  upserted: number;
  removed: number;
  skippedFailures: string[];
  flagged: string[];
}

export async function syncFromSieveRepo(db: D1Database): Promise<SyncResult> {
  const indexRes = await fetch(`${SIEVE_RAW_BASE}/sieve.index.json`);
  if (!indexRes.ok) throw new Error(`fetch sieve.index.json -> ${indexRes.status}`);
  const index: SieveIndex = await indexRes.json();

  const skippedFailures: string[] = [];
  const synced: string[] = [];
  const flagged: string[] = [];

  for (const entry of index.skills) {
    const bodyRes = await fetch(`${SIEVE_RAW_BASE}/${entry.url}`);
    if (!bodyRes.ok) {
      skippedFailures.push(entry.name);
      continue;
    }
    const body = await bodyRes.text();
    // Scanned even though this path is gated by validate-skill.mjs in CI —
    // defense in depth, not a substitute for that gate.
    const scan = scanSkillBody(body);
    if (scan.flagged) flagged.push(entry.name);
    await upsertSkill(db, {
      source_id: SIEVE_SOURCE_ID,
      name: entry.name,
      category: entry.category,
      tier: entry.tier,
      description: entry.description,
      tags: entry.tags ?? [],
      version: entry.version,
      last_reviewed: entry.last_reviewed,
      body,
      blob_sha: null, // sieve.index.json doesn't carry a per-file git sha
      validated: true, // this path only ever ingests sieve's own repo, gated by validate-skill.mjs in CI
      flagged: scan.flagged,
      flag_reason: scan.reasons,
    });
    synced.push(entry.name);
  }

  // Only prune using names we actually confirmed synced this run — a skill
  // that merely failed to fetch (skippedFailures) must not be deleted.
  const removed = await pruneSkillsNotIn(db, SIEVE_SOURCE_ID, [...synced, ...skippedFailures]);

  return { upserted: synced.length, removed, skippedFailures, flagged };
}

export interface SourceSyncSummary {
  sourceId: string;
  ok: boolean;
  upserted?: number;
  removed?: number;
  flagged?: string[];
  error?: string;
}

// Runs every source through the right sync path (sieve's own
// sieve.index.json shortcut, or the generic scanner for everything else).
// One source's failure never blocks the rest.
export async function syncAllSources(db: D1Database, githubToken: string | undefined): Promise<SourceSyncSummary[]> {
  const sources = await listAllSources(db);
  const summaries: SourceSyncSummary[] = [];

  for (const source of sources) {
    // Hand-authored skills have no backing repo — they're already the
    // source of truth, nothing to pull.
    if (source.id.startsWith("custom:")) {
      summaries.push({ sourceId: source.id, ok: true, upserted: 0, removed: 0, flagged: [] });
      continue;
    }
    try {
      const result =
        source.id === SIEVE_SOURCE_ID ? await syncFromSieveRepo(db) : await syncGenericSource(db, source, githubToken);
      await markSourceStatus(db, source.id, "active");
      if (result.flagged.length) {
        console.warn(`[sieve-registry] security-scan flagged ${result.flagged.length} skill(s) in ${source.id}: ${result.flagged.join(", ")}`);
      }
      summaries.push({ sourceId: source.id, ok: true, upserted: result.upserted, removed: result.removed, flagged: result.flagged });
    } catch (err) {
      await markSourceStatus(db, source.id, "failed");
      summaries.push({ sourceId: source.id, ok: false, error: (err as Error).message });
    }
  }

  return summaries;
}
