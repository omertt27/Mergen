/**
 * gate-decision.ts — pure decision helpers for the tool-call gate.
 *
 * Extracted from tool-guard.ts so the security-relevant matching logic (prompt-
 * injection detection, guided alternatives, recursive arg extraction) is free of
 * I/O and module state and can be unit-tested in isolation. Nothing here reads
 * files, env, or mutable module state — same input always yields same output.
 */
import { normalizeForMatching } from './normalize.js';

// ── Recursive arg string extractor ────────────────────────────────────────────
// Agents can hide commands in non-standard keys; scan every string value in the
// args tree, not just command/cmd/fix. Depth-limited to prevent DoS via
// deeply-nested payloads.
export function extractAllStrings(obj: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof obj === 'string') return obj.length > 0 ? [obj] : [];
  if (Array.isArray(obj)) return obj.flatMap((v) => extractAllStrings(v, depth + 1));
  if (obj !== null && typeof obj === 'object') {
    return Object.values(obj as Record<string, unknown>).flatMap((v) => extractAllStrings(v, depth + 1));
  }
  return [];
}

// ── Prompt injection detection ────────────────────────────────────────────────
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /disregard\s+(the\s+)?(above|previous|prior)/i,
  /forget\s+(all\s+)?previous\s+instructions?/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /new\s+system\s+prompt/i,
  /\bjailbreak\b/i,
  /\bdan\s+mode\b/i,
  /override\s+(all\s+)?(?:safety|security|policy)\s+(rules?|constraints?|restrictions?)/i,
  // Additional paraphrase variants
  /act\s+as\s+(?:if\s+)?(?:you\s+(?:have\s+no|are\s+without)\s+(?:restrictions?|guidelines?|rules?))/i,
  /from\s+now\s+on\s+(?:you\s+(?:are|will|must|should))/i,
  /pretend\s+(?:you\s+(?:have\s+no|are\s+without)|that\s+(?:safety|policy|rules?))/i,
  /(?:ignore|bypass|circumvent|disable)\s+(?:your\s+)?(?:safety|security|policy|guidelines?|restrictions?)/i,
  /(?:system|instruction|prompt)\s+(?:override|injection|hijack)/i,
  /<\s*(?:system|instructions?)\s*>/i,
];

export function detectInjection(text: string): string | null {
  const normalized = normalizeForMatching(text);
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) return pattern.source;
  }
  return null;
}

// ── Suggested alternatives for blocked tool calls ─────────────────────────────

const COMMAND_ALTERNATIVES: Array<[RegExp, string]> = [
  [/terraform destroy/i,       'Run `terraform plan -destroy` to preview the blast radius and share the plan output, then request human approval before proceeding.'],
  [/kubectl delete/i,          'Run `kubectl describe <resource>` to confirm the target and current state, then request HITL approval before deletion.'],
  [/drop (table|database)/i,   'Export a schema snapshot, confirm row counts, then create a reversible migration with a rollback path and request HITL approval.'],
  [/truncate table/i,          'Confirm row count with `SELECT count(*) FROM <table>` and back up the data, then request approval to truncate.'],
  [/rm -rf/i,                  'List the target first with `ls -la <path>` to confirm scope, then request human approval before deleting.'],
  [/(destroy|nuke|wipe)\b/i,   'Describe the specific resource and intended outcome, then request human approval — this action is irreversible.'],
];

const RULE_ALTERNATIVES: Record<string, string> = {
  policy_auth_batch_window:
    'Auth changes are locked during the Friday settlement window (12:00–24:00 UTC). Schedule this for after Saturday 00:00 UTC, or submit a change request via HITL for manual override.',
  hold_schema_mutations:
    'Schema mutations require operator approval. Describe the migration intent, submit it for HITL review, and await the operator response before proceeding.',
  policy_prod_database_warn:
    'Database migrations should run via automated pipelines. Open a PR to trigger the migration workflow rather than running it directly.',
};

export function getSuggestedAlternative(triggeredRules: string[], commandArg: string): string {
  for (const ruleId of triggeredRules) {
    const ruleAlt = RULE_ALTERNATIVES[ruleId];
    if (ruleAlt) return ruleAlt;
  }
  const haystack = commandArg.toLowerCase();
  for (const [pattern, alt] of COMMAND_ALTERNATIVES) {
    if (pattern.test(haystack)) return alt;
  }
  return 'Describe the intended outcome and the specific resource, then request human approval before executing irreversible actions.';
}
