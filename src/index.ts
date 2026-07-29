import {
  assignSkill,
  createProject,
  createSource,
  deleteSource,
  listAssignments,
  listSkills,
  listVisibleSources,
  markSourceStatus,
  resolveSourceIds,
} from "./db";
import { bearerToken, resolveGithubUser } from "./github-identity";
import { recommend, type OnboardingAnswers } from "./recommend";
import { parseRepoUrl, syncGenericSource } from "./scan";
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

    // POST /api/recommend — body: OnboardingAnswers -> { guardrails, recommended }
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
      const skills = await listSkills(env.DB, sourceIds);
      return json(recommend(skills, { mode: answers.mode, focus: Array.isArray(answers.focus) ? answers.focus : [] }));
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
        const result = await syncGenericSource(env.DB, { id, repo_url: body.repoUrl, kind: "user", added_by: login, status: "active", last_synced_at: null, created_at: "" }, env.GITHUB_TOKEN);
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
