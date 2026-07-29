// Server-side twin of sieve-dashboard's lib/auth.ts:fetchGitHubUser — resolves
// who's making a request from the bearer token they send, without ever
// storing it. No sessions on either side of this system, by design.

export async function resolveGithubUser(token: string): Promise<string | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "sieve-registry" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { login?: string };
  return data.login ?? null;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}
