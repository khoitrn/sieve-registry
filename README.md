# sieve-registry

The central skill registry for [Sieve](https://github.com/khoitrn/sieve). A
Cloudflare Worker + D1 database that `sievekit init` pulls a recommended
skill shortlist from, instead of always copying the entire bundled catalog.

Separate repo from `sieve` (the npm package, zero runtime deps, must keep
working offline) and from `sieve-dashboard` (explicitly no-database,
read-only) on purpose — this is the one piece of the three that's actually
stateful.

## API

- `GET /api/skills` — full catalog
- `POST /api/recommend` — body `{ mode: "new-idea" | "existing-project", focus: string[] }` → `{ guardrails, recommended }` (skill names). v1 recommendation is rule-based tag/category matching against `sieve.index.json`'s own `tags` field — no ML/LLM scoring yet.
- `POST /api/projects` — body `{ id, repo? }`, registers/updates a project
- `POST /api/projects/:id/assign` — body `{ skills: [{ name, version }] }`, upserts assignment records
- `GET /api/projects/:id/skills` — currently-assigned skills for a project
- `POST /api/admin/sync` — gated by `X-Seed-Token` header matching the `SEED_TOKEN` secret; pulls `sieve.index.json` + every skill body straight from `raw.githubusercontent.com/khoitrn/sieve/main` and upserts into D1, pruning any skill no longer present upstream. Also runs on a Cron Trigger (`*/30 * * * *`, see `wrangler.toml`) so the catalog stays current automatically — this is the "tunnel" from `sieve`'s repo into the registry. Doubles as the initial seed (an empty table syncs in fully).

No auth beyond the seed token in v1 — read-heavy, no user-identifying data
beyond an opaque project id.

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
