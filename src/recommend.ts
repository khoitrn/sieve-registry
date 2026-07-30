import type { Bundle, Skill } from "./db";

export interface OnboardingAnswers {
  mode: "new-idea" | "existing-project";
  focus: string[]; // free-text keywords the user cared about, matched against skill tags
}

export interface RecommendResult {
  guardrails: string[];
  recommended: string[];
  bundle?: { id: string; name: string; description: string; skill_names: string[] };
}

const MODE_TAGS: Record<OnboardingAnswers["mode"], string[]> = {
  "new-idea": ["discovery", "execution"],
  "existing-project": ["context", "root-cause"],
};

// v1: rule-based tag/category matching seeded from sieve.index.json's own
// tags field. No ML/LLM scoring — deferred until there's real usage data to
// design against, same reasoning as everything else in this catalog.
export function recommend(skills: Skill[], answers: OnboardingAnswers, bundles: Bundle[] = []): RecommendResult {
  const guardrails = skills.filter((s) => s.tier === "guardrail").map((s) => s.name);

  const modeTags = new Set(MODE_TAGS[answers.mode] ?? []);
  const focusTags = new Set(answers.focus.map((f) => f.toLowerCase()));
  const allTags = new Set([...modeTags, ...focusTags]);

  // A matching curated bundle is surfaced separately from the flat list — a
  // named, known-good group reads differently than an undifferentiated pile
  // of individually tag-matched skills. First match wins; bundles aren't
  // expected to overlap today (curated, hand-seeded, small in number).
  const matchedBundle = bundles.find((b) => b.match_tags.some((t) => allTags.has(t.toLowerCase())));
  const bundledNames = new Set(matchedBundle?.skill_names ?? []);

  // Skills already covered by a matched bundle are presented there instead of
  // duplicated in the flat list — same union of skills either way, just not
  // listed twice.
  const recommended = skills
    .filter((s) => s.tier === "catalog")
    .filter((s) => !bundledNames.has(s.name))
    .filter((s) => s.tags.some((t) => modeTags.has(t) || focusTags.has(t.toLowerCase())))
    .map((s) => s.name);

  if (!matchedBundle) return { guardrails, recommended };

  return {
    guardrails,
    recommended,
    bundle: {
      id: matchedBundle.id,
      name: matchedBundle.name,
      description: matchedBundle.description,
      skill_names: matchedBundle.skill_names,
    },
  };
}
