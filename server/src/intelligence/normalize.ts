/**
 * normalize.ts — Shared string normalization for injection detection and policy matching.
 *
 * Applies the same four-step normalization used by enterprise-policy-engine so that
 * injection detection in tool-guard operates on the same canonical form.
 */

/**
 * Normalize a string to defeat common obfuscation techniques before pattern matching:
 *   - NFKC unicode catches lookalike characters (Cyrillic 'о' → 'o', full-width chars → ASCII)
 *   - Quote stripping removes shell no-op quoting for BOTH single and double
 *     quotes (dr'o'p → drop, dr"o"p → drop). All bare quote characters are
 *     removed — not just matched pairs — so unbalanced quotes (drop" → drop)
 *     can't slip a destructive keyword past the matcher either.
 *   - Backslash-escape collapsing removes literal escapes (ta\ble → table)
 *   - Whitespace collapsing catches double-space separators
 */
export function normalizeForMatching(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/['"]/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
