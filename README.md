# sieve-registry

![status](https://img.shields.io/badge/status-alpha-orange)
![stack](https://img.shields.io/badge/stack-Cloudflare%20Worker%20%2B%20D1-blue)
![sessions](https://img.shields.io/badge/sessions-none-lightgrey)

The central skill registry for [Sieve](https://github.com/khoitrn/sieve). A
Cloudflare Worker + D1 database that `sievekit init` pulls a recommended
skill shortlist from, instead of always copying the entire bundled catalog.

Separate repo from `sieve` (the npm package, zero runtime deps, must keep
working offline) and from `sieve-dashboard` (explicitly no-database,
read-only) on purpose — this is the one piece of the three that's actually
stateful.

## API

| Endpoint | Auth | What it does |
| --- | --- | --- |
| `GET /api/skills` | optional | Curated catalog, plus the caller's own sources if `Authorization: Bearer <github-token>` resolves to a real identity. Anonymous callers see curated only. |
| `POST /api/recommend` | optional | Body `{ mode: "new-idea" \| "existing-project", focus: string[] }` → `{ guardrails, recommended }`. Same source scoping as `/api/skills`. Rule-based tag/category matching — no ML/LLM scoring yet. |
| `GET /api/sources` | required | Curated sources plus the caller's own. |
| `POST /api/sources` | required | Body `{ repoUrl }`. Registers a `kind: "user"` source scoped to the caller's login and syncs it immediately (generic `SKILL.md` scan). |
| `DELETE /api/sources/:id` | required | 403 unless the caller owns the source. Curated sources (`added_by = NULL`) can never be deleted this way. |
| `POST /api/my-skills` | required | Body `{ name, description, category?, tags?, body, version? }`. Hand-authored skills, scoped to a virtual per-user source (`custom:<login>`) — nothing for the sync loop to walk, the caller is already the source of truth. `name` must be lowercase-hyphenated; always forced to `tier: "catalog"`. |
| `DELETE /api/my-skills/:name` | required | Deletes from the caller's own authored source only. |
| `POST /api/projects` | none | Body `{ id, repo? }`. Registers/updates a project. |
| `POST /api/projects/:id/assign` | none | Body `{ skills: [{ name, version, sourceId? }] }`. Upserts assignment records (`sourceId` defaults to sieve's own source for older callers). |
| `GET /api/projects/:id/skills` | none | Currently-assigned skills for a project. |
| `POST /api/admin/sync` | `X-Seed-Token` | Syncs **every** registered source. `sieve`'s own source uses its `sieve.index.json` manifest (cheap, exact); every other source is walked generically — every `SKILL.md` in the tree, frontmatter parsed with a plain regex (never eval/exec), forced to `tier: "catalog"` (only `sieve`'s own repo may ship `guardrail`-tier skills). Also runs on a Cron Trigger (`*/30 * * * *`). Doubles as the initial seed for a brand-new source. |

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

## Check your own project (no dashboard UI yet)

There's no web dashboard in this repo — just the API above. Until one
exists, this is how to see what a project actually has assigned, straight
from the data `sieve init`/`add`/`remove` already write to the registry:

```
# projectId is the "projectId" field in that project's own .sieve/project.json
curl https://sieve-registry.khoitrn.workers.dev/api/projects/<projectId>/skills
```

Returns the current assignment list (name, version, source) for that
project. There's no login/ownership check on this route today — anyone
with the `projectId` can read it, and it's a random UUID generated locally
by `sieve init`, not a secret derived from your GitHub identity, so treat
it like a bearer token: don't publish a project's `.sieve/project.json`
somewhere public if you'd rather its assignment history stayed private.

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
