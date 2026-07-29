import { pruneSkillsNotIn, upsertSkill } from "./db";

// The tunnel: pulls sieve.index.json + every skill body straight from
// sieve's own repo (public, so no auth needed — same raw.githubusercontent.com
// pattern sieve-dashboard already uses) and upserts them into D1. Run on a
// Cron Trigger so the registry stays current without a manual seed step, and
// exposed as an on-demand endpoint for an immediate refresh right after a push.

const SIEVE_RAW_BASE = "https://raw.githubusercontent.com/khoitrn/sieve/main";

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
}

export async function syncFromSieveRepo(db: D1Database): Promise<SyncResult> {
  const indexRes = await fetch(`${SIEVE_RAW_BASE}/sieve.index.json`);
  if (!indexRes.ok) throw new Error(`fetch sieve.index.json -> ${indexRes.status}`);
  const index: SieveIndex = await indexRes.json();

  const skippedFailures: string[] = [];
  const synced: string[] = [];

  for (const entry of index.skills) {
    const bodyRes = await fetch(`${SIEVE_RAW_BASE}/${entry.url}`);
    if (!bodyRes.ok) {
      skippedFailures.push(entry.name);
      continue;
    }
    const body = await bodyRes.text();
    await upsertSkill(db, {
      name: entry.name,
      category: entry.category,
      tier: entry.tier,
      description: entry.description,
      tags: entry.tags ?? [],
      version: entry.version,
      last_reviewed: entry.last_reviewed,
      body,
    });
    synced.push(entry.name);
  }

  // Only prune using names we actually confirmed synced this run — a skill
  // that merely failed to fetch (skippedFailures) must not be deleted.
  const removed = await pruneSkillsNotIn(db, [...synced, ...skippedFailures]);

  return { upserted: synced.length, removed, skippedFailures };
}
