import {
  assignSkill,
  authoredSourceId,
  createProject,
  createSource,
  deleteOwnSkill,
  deleteSource,
  ensureAuthoredSource,
  listAllSources,
  listAssignments,
  listBundles,
  listSkills,
  listVisibleSources,
  markSourceStatus,
  resolveSourceIds,
  setPinnedSha,
  unassignSkill,
  upsertSkill,
} from "./db";
import { bearerToken, resolveGithubUser } from "./github-identity";
import { recommend, type OnboardingAnswers } from "./recommend";
import { getCurrentCommitSha, getDefaultBranch, parseRepoUrl, syncGenericSource } from "./scan";
import { scanSkillBody } from "./security-scan";
import { SIEVE_SOURCE_ID, syncAllSources } from "./sync";

export interface Env {
  DB: D1Database;
  SEED_TOKEN?: string; // required header to hit /api/admin/sync
  GITHUB_TOKEN?: string; // optional: raises the GitHub API rate limit for scanning sources
}

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Seed-Token");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data: unknown, status = 200): Response {
  return cors(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
}

// Resolves the caller's GitHub login from the Authorization header, if
// present. Returns null for anonymous callers (they only ever see curated
// sources/skills) and also null if a token was sent but is invalid.
async function callerLogin(request: Request): Promise<string | null> {
  const token = bearerToken(request);
  if (!token) return null;
  return resolveGithubUser(token);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // GET /api/skills — curated catalog, plus the caller's own sources if authenticated
    if (pathname === "/api/skills" && request.method === "GET") {
      const login = await callerLogin(request);
      const sourceIds = await resolveSourceIds(env.DB, login);
      return json(await listSkills(env.DB, sourceIds));
    }

    // POST /api/recommend — body: OnboardingAnswers -> { guardrails, recommended, bundle? }
    if (pathname === "/api/recommend" && request.method === "POST") {
      let answers: OnboardingAnswers;
      try {
        answers = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (answers.mode !== "new-idea" && answers.mode !== "existing-project") {
        return json({ error: "invalid_mode" }, 400);
      }
      const login = await callerLogin(request);
      const sourceIds = await resolveSourceIds(env.DB, login);
      const [skills, bundles] = await Promise.all([listSkills(env.DB, sourceIds), listBundles(env.DB)]);
      return json(recommend(skills, { mode: answers.mode, focus: Array.isArray(answers.focus) ? answers.focus : [] }, bundles));
    }

    // GET /api/bundles — curated groups of skills known to work well together.
    // No auth/scoping: bundles are curated only, same visibility as the
    // curated skill catalog.
    if (pathname === "/api/bundles" && request.method === "GET") {
      return json(await listBundles(env.DB));
    }

    // GET /api/sources — curated sources plus the caller's own (requires auth)
    if (pathname === "/api/sources" && request.method === "GET") {
      const login = await callerLogin(request);
      if (!login) return json({ error: "unauthorized" }, 401);
      return json(await listVisibleSources(env.DB, login));
    }

    // POST /api/sources — body: { repoUrl } -> registers + immediately syncs a source
    if (pathname === "/api/sources" && request.method === "POST") {
      const login = await callerLogin(request);
      if (!login) return json({ error: "unauthorized" }, 401);
      let body: { repoUrl?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (!body.repoUrl) return json({ error: "missing_repoUrl" }, 400);
      const parsed = parseRepoUrl(body.repoUrl);
      if (!parsed) return json({ error: "unparseable_repo_url" }, 400);

      const id = `github:${parsed.owner}/${parsed.repo}`;
      await createSource(env.DB, id, body.repoUrl, login);
      try {
        const result = await syncGenericSource(
          env.DB,
          { id, repo_url: body.repoUrl, kind: "user", added_by: login, status: "active", last_synced_at: null, created_at: "", pinned_sha: null },
          env.GITHUB_TOKEN,
        );
        await markSourceStatus(env.DB, id, "active");
        return json({ ok: true, id, status: "active", ...result });
      } catch (err) {
        await markSourceStatus(env.DB, id, "failed");
        return json({ ok: true, id, status: "failed", error: (err as Error).message });
      }
    }

    // DELETE /api/sources/:id — only the source's own added_by may delete it
    const sourceIdMatch = pathname.match(/^\/api\/sources\/(.+)$/);
    if (sourceIdMatch && request.method === "DELETE") {
      const login = await callerLogin(request);
      if (!login) return json({ error: "unauthorized" }, 401);
      const deleted = await deleteSource(env.DB, decodeURIComponent(sourceIdMatch[1]), login);
      if (!deleted) return json({ error: "forbidden_or_not_found" }, 403);
      return json({ ok: true });
    }

    // POST /api/my-skills — body: { name, description, category?, tags?, body, version? }
    // Hand-authored skills, scoped to the caller's GitHub login, not any repo.
    if (pathname === "/api/my-skills" && request.method === "POST") {
      const login = await callerLogin(request);
      if (!login) return json({ error: "unauthorized" }, 401);
      let body: { name?: string; description?: string; category?: string; tags?: string[]; body?: string; version?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (!body.name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(body.name)) {
        return json({ error: "invalid_name", detail: "lowercase words joined by hyphens" }, 400);
      }
      if (!body.description) return json({ error: "missing_description" }, 400);
      if (!body.body) return json({ error: "missing_body" }, 400);

      const sourceId = await ensureAuthoredSource(env.DB, login);
      const scan = scanSkillBody(body.body);
      await upsertSkill(env.DB, {
        source_id: sourceId,
        name: body.name,
        category: body.category?.trim() || "personal",
        tier: "catalog", // never let a user claim guardrail tier either
        description: body.description,
        tags: Array.isArray(body.tags) ? body.tags : [],
        version: body.version?.trim() || "1.0.0",
        last_reviewed: new Date().toISOString().slice(0, 10),
        body: body.body,
        blob_sha: null, // no backing repo — hand-authored, not scanned from a git tree
        validated: false, // self-attested, never run through validate-skill.mjs
        flagged: scan.flagged,
        flag_reason: scan.reasons,
      });
      return json({ ok: true, sourceId, name: body.name, flagged: scan.flagged, flag_reason: scan.reasons });
    }

    // DELETE /api/my-skills/:name — only from the caller's own authored source
    const mySkillMatch = pathname.match(/^\/api\/my-skills\/(.+)$/);
    if (mySkillMatch && request.method === "DELETE") {
      const login = await callerLogin(request);
      if (!login) return json({ error: "unauthorized" }, 401);
      const deleted = await deleteOwnSkill(env.DB, authoredSourceId(login), decodeURIComponent(mySkillMatch[1]));
      if (!deleted) return json({ error: "not_found" }, 404);
      return json({ ok: true });
    }

    // POST /api/projects — body: { id: string, repo?: string } -> registers/updates a project
    if (pathname === "/api/projects" && request.method === "POST") {
      let body: { id?: string; repo?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (!body.id) return json({ error: "missing_id" }, 400);
      await createProject(env.DB, body.id, body.repo ?? null);
      return json({ ok: true });
    }

    // POST /api/projects/:id/assign — body: { skills: [{name, version, sourceId?}] }
    // sourceId defaults to sieve's own source for callers that don't send one
    // (today's onboard.mjs, which doesn't yet know about multiple sources).
    const assignMatch = pathname.match(/^\/api\/projects\/([^/]+)\/assign$/);
    if (assignMatch && request.method === "POST") {
      const projectId = decodeURIComponent(assignMatch[1]);
      let body: { skills?: { name: string; version: string; sourceId?: string }[] };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      for (const s of body.skills ?? []) {
        if (s.name && s.version) await assignSkill(env.DB, projectId, s.sourceId ?? SIEVE_SOURCE_ID, s.name, s.version);
      }
      return json({ ok: true });
    }

    // DELETE /api/projects/:id/assign/:name — drop one skill from a project's
    // assignment (used by `sieve remove`), so the dashboard doesn't drift from
    // what's actually on disk.
    const unassignMatch = pathname.match(/^\/api\/projects\/([^/]+)\/assign\/([^/]+)$/);
    if (unassignMatch && request.method === "DELETE") {
      const projectId = decodeURIComponent(unassignMatch[1]);
      const skillName = decodeURIComponent(unassignMatch[2]);
      const removed = await unassignSkill(env.DB, projectId, skillName);
      return json({ removed });
    }

    // GET /api/projects/:id/skills — what's currently assigned
    const skillsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/skills$/);
    if (skillsMatch && request.method === "GET") {
      const projectId = decodeURIComponent(skillsMatch[1]);
      return json(await listAssignments(env.DB, projectId));
    }

    // POST /api/admin/sync — on-demand sync of every registered source
    // (also what the Cron Trigger runs), gated by a shared token.
    if (pathname === "/api/admin/sync" && request.method === "POST") {
      if (!env.SEED_TOKEN || request.headers.get("X-Seed-Token") !== env.SEED_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      const summaries = await syncAllSources(env.DB, env.GITHUB_TOKEN);
      return json({ ok: true, sources: summaries });
    }

    // POST /api/admin/sources/:id/pin — advance a curated source's reviewed
    // commit. Body { "sha": "<commit sha>" } to pin an exact reviewed
    // commit, or an empty body to pin at whatever the default branch
    // currently resolves to. Deliberately manual — no auto-advance path —
    // this is the human-review gate the pinning exists for.
    const pinMatch = pathname.match(/^\/api\/admin\/sources\/([^/]+)\/pin$/);
    if (pinMatch && request.method === "POST") {
      if (!env.SEED_TOKEN || request.headers.get("X-Seed-Token") !== env.SEED_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      const sourceId = decodeURIComponent(pinMatch[1]);
      const source = (await listAllSources(env.DB)).find((s) => s.id === sourceId);
      if (!source) return json({ error: "not_found" }, 404);
      if (source.kind !== "curated") return json({ error: "not_curated" }, 400);
      const parsed = parseRepoUrl(source.repo_url);
      if (!parsed) return json({ error: "unparseable_repo_url" }, 400);

      let body: { sha?: string } = {};
      try {
        const raw = await request.text();
        if (raw) body = JSON.parse(raw);
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      let sha = body.sha;
      if (!sha) {
        const branch = await getDefaultBranch(parsed.owner, parsed.repo, env.GITHUB_TOKEN);
        sha = await getCurrentCommitSha(parsed.owner, parsed.repo, branch, env.GITHUB_TOKEN);
      }

      const ok = await setPinnedSha(env.DB, sourceId, sha);
      if (!ok) return json({ error: "pin_failed" }, 500);
      return json({ ok: true, sourceId, pinned_sha: sha });
    }

    return json({ error: "not_found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      syncAllSources(env.DB, env.GITHUB_TOKEN)
        .then((summaries) => {
          const failed = summaries.filter((s) => !s.ok);
          console.log(`[sieve-registry] scheduled sync: ${summaries.length} source(s), ${failed.length} failed`);
          for (const f of failed) console.error(`[sieve-registry] source ${f.sourceId} failed: ${f.error}`);
        })
        .catch((err) => console.error("[sieve-registry] scheduled sync failed:", err)),
    );
  },
} satisfies ExportedHandler<Env>;
