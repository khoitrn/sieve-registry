// Heuristic pattern scan over a skill's Markdown body. This is a first-pass
// filter, not a semantic security review — it exists to catch the shape of
// an attack (a curl-pipe-to-shell, a prompt-injection phrase, a credential
// read paired with an outbound call, an obfuscated blob), not to guarantee
// content is safe. Curated sources are pinned to a reviewed commit
// (see pinned_sha in sources); this scan runs in addition to that, not
// instead of it, and applies to every source including sieve's own.
//
// Never blocks a sync — a flagged skill still gets upserted, with
// flagged=true and a reason, surfaced the same way sieve-dashboard already
// surfaces the "unverified" trust chip. Triage stays a human step.

export interface ScanResult {
  flagged: boolean;
  reasons: string[];
}

interface Rule {
  id: string;
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  {
    id: "pipe-to-shell",
    pattern: /\b(curl|wget)\b[^\n`]{0,200}\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
    reason: "downloads and pipes straight into a shell",
  },
  {
    id: "eval-exec",
    pattern: /\b(eval|exec)\s*\(\s*(atob|Buffer\.from|base64)/i,
    reason: "decodes and evaluates/executes an encoded payload",
  },
  {
    id: "prompt-injection-ignore",
    pattern: /\b(ignore|disregard)\b[^\n]{0,40}\b(previous|prior|all|above)\b[^\n]{0,20}\b(instructions?|rules?|guardrails?)\b/i,
    reason: "phrasing that reads as an attempt to override prior instructions",
  },
  {
    id: "prompt-injection-mode",
    pattern: /\byou are now in\b[^\n]{0,30}\b(developer|debug|unrestricted|unfiltered|jailbreak)\b/i,
    reason: "phrasing that reads as a jailbreak/mode-switch attempt",
  },
  {
    id: "prompt-injection-secrecy",
    pattern: /\bdo not\b[^\n]{0,20}\b(tell|inform|mention|reveal)\b[^\n]{0,20}\buser\b/i,
    reason: "instructs the agent to hide actions from the user",
  },
  {
    id: "reveal-system-prompt",
    pattern: /\breveal\b[^\n]{0,20}\b(system prompt|hidden instructions|your instructions)\b/i,
    reason: "attempts to extract the agent's own system prompt",
  },
  {
    id: "obfuscated-blob",
    pattern: /[A-Za-z0-9+/]{120,}={0,2}/,
    reason: "contains a long base64-like blob, unusual in an instructional file",
  },
];

// Credential/secret paths that only matter in combination with a network
// call nearby — reading `.env` in a skill about env config is normal;
// reading it right next to a fetch/curl to an external host is not.
const SECRET_HINTS = /(\.ssh\/id_rsa|\.aws\/credentials|\.npmrc|process\.env\[|~\/\.env\b)/i;
const NETWORK_HINTS = /\b(curl\s+https?:|fetch\(|axios\.|https?:\/\/(?!localhost|127\.0\.0\.1))/i;

export function scanSkillBody(body: string): ScanResult {
  const reasons: string[] = [];

  for (const rule of RULES) {
    if (rule.pattern.test(body)) reasons.push(rule.reason);
  }

  if (SECRET_HINTS.test(body) && NETWORK_HINTS.test(body)) {
    reasons.push("reads a credential path and makes a network call in the same file");
  }

  return { flagged: reasons.length > 0, reasons };
}
