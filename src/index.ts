import { assignSkill, createProject, listAssignments, listSkills, upsertSkill } from "./db";
import { recommend, type OnboardingAnswers } from "./recommend";

export interface Env {
  DB: D1Database;
  SEED_TOKEN?: string; // required header to hit /api/admin/seed
}

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, X-Seed-Token");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data: unknown, status = 200): Response {
  return cors(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // GET /api/skills — full catalog
    if (pathname === "/api/skills" && request.method === "GET") {
      return json(await listSkills(env.DB));
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
      const skills = await listSkills(env.DB);
      return json(recommend(skills, { mode: answers.mode, focus: Array.isArray(answers.focus) ? answers.focus : [] }));
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

    // POST /api/projects/:id/assign — body: { skills: [{name, version}] }
    const assignMatch = pathname.match(/^\/api\/projects\/([^/]+)\/assign$/);
    if (assignMatch && request.method === "POST") {
      const projectId = decodeURIComponent(assignMatch[1]);
      let body: { skills?: { name: string; version: string }[] };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      for (const s of body.skills ?? []) {
        if (s.name && s.version) await assignSkill(env.DB, projectId, s.name, s.version);
      }
      return json({ ok: true });
    }

    // GET /api/projects/:id/skills — what's currently assigned
    const skillsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/skills$/);
    if (skillsMatch && request.method === "GET") {
      const projectId = decodeURIComponent(skillsMatch[1]);
      return json(await listAssignments(env.DB, projectId));
    }

    // POST /api/admin/seed — one-time/idempotent catalog load, gated by a shared token
    if (pathname === "/api/admin/seed" && request.method === "POST") {
      if (!env.SEED_TOKEN || request.headers.get("X-Seed-Token") !== env.SEED_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      let body: { skills?: Parameters<typeof upsertSkill>[1][] };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      for (const s of body.skills ?? []) await upsertSkill(env.DB, s);
      return json({ ok: true, count: body.skills?.length ?? 0 });
    }

    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
