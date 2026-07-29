import type { Skill } from "./db";

export interface OnboardingAnswers {
  mode: "new-idea" | "existing-project";
  focus: string[]; // free-text keywords the user cared about, matched against skill tags
}

const MODE_TAGS: Record<OnboardingAnswers["mode"], string[]> = {
  "new-idea": ["discovery", "execution"],
  "existing-project": ["context", "root-cause"],
};

// v1: rule-based tag/category matching seeded from sieve.index.json's own
// tags field. No ML/LLM scoring — deferred until there's real usage data to
// design against, same reasoning as everything else in this catalog.
export function recommend(skills: Skill[], answers: OnboardingAnswers): { guardrails: string[]; recommended: string[] } {
  const guardrails = skills.filter((s) => s.tier === "guardrail").map((s) => s.name);

  const modeTags = new Set(MODE_TAGS[answers.mode] ?? []);
  const focusTags = new Set(answers.focus.map((f) => f.toLowerCase()));

  const recommended = skills
    .filter((s) => s.tier === "catalog")
    .filter((s) => s.tags.some((t) => modeTags.has(t) || focusTags.has(t.toLowerCase())))
    .map((s) => s.name);

  return { guardrails, recommended };
}
