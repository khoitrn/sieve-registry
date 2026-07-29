# sieve-registry

The central skill registry for [Sieve](https://github.com/khoitrn/sieve). A
Cloudflare Worker + D1 database that `sievekit init` pulls a recommended
skill shortlist from, instead of always copying the entire bundled catalog.

Separate repo from `sieve` (the npm package, zero runtime deps, must keep
working offline) and from `sieve-dashboard` (explicitly no-database,
read-only) on purpose — this is the one piece of the three that's actually
stateful.

## API

- `GET /api/skills` — the curated catalog, plus the caller's own sources if an `Authorization: Bearer <github-token>` header is sent and resolves to a real GitHub identity. Anonymous callers only ever see curated skills.
- `POST /api/recommend` — body `{ mode: "new-idea" | "existing-project", focus: string[] }` → `{ guardrails, recommended }` (skill names). Same source scoping as `/api/skills`. v1 recommendation is rule-based tag/category matching — no ML/LLM scoring yet.
- `GET /api/sources` — requires `Authorization`; curated sources plus the caller's own.
- `POST /api/sources` — requires `Authorization`; body `{ repoUrl }`; registers a `kind: "user"` source scoped to the caller's GitHub login and syncs it immediately (generic `SKILL.md` scan — see below).
- `DELETE /api/sources/:id` — requires `Authorization`; 403 unless the caller is the source's owner. Curated sources (`added_by = NULL`) can never be deleted this way.
- `POST /api/my-skills` — requires `Authorization`; body `{ name, description, category?, tags?, body, version? }`. Hand-authored skills, not pulled from any repo — scoped to a virtual per-user source (`custom:<login>`) so the sync loop has nothing to walk; the caller is already the source of truth. `name` must be lowercase-hyphenated; skills are always forced to `tier: "catalog"`, same as the generic scanner.
- `DELETE /api/my-skills/:name` — requires `Authorization`; only deletes from the caller's own authored source.
- `POST /api/projects` — body `{ id, repo? }`, registers/updates a project
- `POST /api/projects/:id/assign` — body `{ skills: [{ name, version, sourceId? }] }`, upserts assignment records (`sourceId` defaults to sieve's own source for older callers)
- `GET /api/projects/:id/skills` — currently-assigned skills for a project
- `POST /api/admin/sync` — gated by `X-Seed-Token` header matching the `SEED_TOKEN` secret; syncs **every** registered source. `sieve`'s own source uses its `sieve.index.json` manifest (cheap, exact); every other source is walked generically — every `SKILL.md` in the repo tree, frontmatter parsed with a plain regex (never eval/exec), forced to `tier: "catalog"` regardless of what its own frontmatter claims (only `sieve`'s own repo may ship `guardrail`-tier skills). Also runs on a Cron Trigger (`*/30 * * * *`) so every source — curated or user-added — stays current automatically. Doubles as the initial seed for a brand-new source.

Identity is resolved per-request by calling `https://api.github.com/user`
with whatever bearer token the caller sends — no sessions, no stored
tokens, matching `sieve-dashboard`'s own no-server-session design. A
user's own sources are never visible to, or blended into recommendations
for, any other caller.

Optional `GITHUB_TOKEN` secret: raises the GitHub API's 60/hr unauthenticated
rate limit for the tree-listing calls the generic scanner makes — worth
setting once there's more than one or two non-curated sources
(`npx wrangler secret put GITHUB_TOKEN`, a personal access token with no
special scopes needed for public repos).

## Develop

```
npm install
npm run db:migrate        # applies migrations/0001_init.sql locally
npm run dev                # wrangler dev, http://localhost:8787
SEED_TOKEN=<value> curl -X POST http://localhost:8787/api/admin/sync -H "X-Seed-Token: $SEED_TOKEN"
```

## Deploy

```
npx wrangler d1 create sieve-registry     # once; paste the returned id into wrangler.toml
npm run db:migrate:remote
npx wrangler secret put SEED_TOKEN
npm run deploy                             # also activates the Cron Trigger
SEED_TOKEN=<value> curl -X POST https://<deployed-url>/api/admin/sync -H "X-Seed-Token: $SEED_TOKEN"
```
