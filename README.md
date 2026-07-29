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
- `POST /api/admin/seed` — body `{ skills: [...] }`, gated by `X-Seed-Token` header matching the `SEED_TOKEN` secret; loads/updates the catalog from `sieve`'s `sieve.index.json`

No auth beyond the seed token in v1 — read-heavy, no user-identifying data
beyond an opaque project id.

## Develop

```
npm install
npm run db:migrate        # applies migrations/0001_init.sql locally
npm run dev                # wrangler dev, http://localhost:8787
SEED_TOKEN=<value> npm run db:seed
```

## Deploy

```
npx wrangler d1 create sieve-registry     # once; paste the returned id into wrangler.toml
npm run db:migrate:remote
npx wrangler secret put SEED_TOKEN
npm run deploy
SEED_TOKEN=<value> SEED_URL=<deployed-url> npm run db:seed:remote
```
