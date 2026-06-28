/**
 * normalize.ts — Shared string normalization for injection detection and policy matching.
 *
 * Applies the same four-step normalization used by enterprise-policy-engine so that
 * injection detection in tool-guard operates on the same canonical form.
 */

/**
 * Normalize a string to defeat common obfuscation techniques before pattern matching:
 *   - NFKC unicode catches lookalike characters (Cyrillic 'о' → 'o', full-width chars → ASCII)
 *   - Single-quote stripping removes shell no-op quoting (dr'o'p → drop)
 *   - Backslash-escape collapsing removes literal escapes (ta\ble → table)
 *   - Whitespace collapsing catches double-space separators
 */
export function normalizeForMatching(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/'([^']*)'/g, '$1')
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
