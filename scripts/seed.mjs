#!/usr/bin/env node
// One-time (idempotent, safe to re-run) load of sieve's sieve.index.json + each
// skill's SKILL.md body into the registry's skills table via POST /api/admin/seed.
//
// Usage: SEED_TOKEN=<token> node scripts/seed.mjs [--remote]
//   default target: http://localhost:8787 (wrangler dev)
//   --remote target: https://sieve-registry.<account>.workers.dev, override with SEED_URL

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sieveRoot = join(__dirname, "..", "..", "sieve");
const remote = process.argv.includes("--remote");

const token = process.env.SEED_TOKEN;
if (!token) {
  console.error("SEED_TOKEN env var is required (matches the Worker's SEED_TOKEN secret)");
  process.exit(1);
}

const url = process.env.SEED_URL ?? (remote ? undefined : "http://localhost:8787");
if (!url) {
  console.error("Set SEED_URL to the deployed Worker URL when using --remote");
  process.exit(1);
}

const index = JSON.parse(readFileSync(join(sieveRoot, "sieve.index.json"), "utf8"));

const skills = index.skills.map((s) => ({
  name: s.name,
  category: s.category,
  tier: s.tier,
  description: s.description,
  tags: s.tags ?? [],
  version: s.version,
  last_reviewed: s.last_reviewed,
  body: readFileSync(join(sieveRoot, s.url), "utf8"),
}));

const res = await fetch(`${url}/api/admin/seed`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Seed-Token": token },
  body: JSON.stringify({ skills }),
});

if (!res.ok) {
  console.error(`Seed failed: ${res.status} ${res.statusText}`, await res.text());
  process.exit(1);
}

const result = await res.json();
console.log(`Seeded ${result.count} skills into ${url}`);
