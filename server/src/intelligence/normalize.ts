/**
 * normalize.ts — Shared string normalization for injection detection and policy matching.
 *
 * Applies the same four-step normalization used by enterprise-policy-engine so that
 * injection detection in tool-guard operates on the same canonical form.
 */

/**
 * Unicode confusables map — characters that NFKC alone does not collapse to their ASCII
 * equivalents but that attackers use to bypass keyword matching.
 *
 * Sources: Unicode Consortium confusables.txt (https://www.unicode.org/Public/security/latest/confusables.txt)
 * Covers the highest-risk subset: Cyrillic, Greek, and Mathematical Alphanumeric lookalikes
 * for every ASCII letter that appears in the blocked command vocabulary.
 * Each entry maps the confusable codepoint → ASCII replacement.
 */
const CONFUSABLES: [RegExp, string][] = [
  // ── r ─────────────────────────────────────────────────────────────────────
  [/[гԹ𝐫𝑟𝒓𝓻𝔯𝕣𝖗𝗿𝘳𝙧ɼɾᵣ]/gu, 'r'],
  // ── m ─────────────────────────────────────────────────────────────────────
  [/[𝐦𝑚𝒎𝓶𝔪𝕞𝖒𝗺𝘮𝙢ṃɱ]/gu, 'm'],
  // ── d ─────────────────────────────────────────────────────────────────────
  [/[ԁ𝐝𝑑𝒅𝓭𝔡𝕕𝖉𝗱𝘥𝙙ḋḍ]/gu, 'd'],
  // ── o / 0 ─────────────────────────────────────────────────────────────────
  [/[оοσ𝐨𝑜𝒐𝓸𝔬𝕠𝖔𝗼𝘰𝙤ọởôöō]/gu, 'o'],
  // ── p ─────────────────────────────────────────────────────────────────────
  [/[рρ𝐩𝑝𝒑𝓹𝔭𝕡𝖕𝗽𝘱𝙥]/gu, 'p'],
  // ── e ─────────────────────────────────────────────────────────────────────
  [/[еε𝐞𝑒𝒆𝓮𝔢𝕖𝖊𝗲𝘦𝙚ëēėę]/gu, 'e'],
  // ── t ─────────────────────────────────────────────────────────────────────
  [/[τ𝐭𝑡𝒕𝓽𝔱𝕥𝖙𝗍𝘵𝙩ţ]/gu, 't'],
  // ── a ─────────────────────────────────────────────────────────────────────
  [/[аα𝐚𝑎𝒂𝓪𝔞𝕒𝖆𝗮𝘢𝙖äãāăâ]/gu, 'a'],
  // ── b ─────────────────────────────────────────────────────────────────────
  [/[Ь𝐛𝑏𝒃𝓫𝔟𝕓𝖇𝗯𝘣𝙗ḃ]/gu, 'b'],
  // ── c ─────────────────────────────────────────────────────────────────────
  [/[сϲ𝐜𝑐𝒄𝓬𝔠𝕔𝖈𝗰𝘤𝙘çć]/gu, 'c'],
  // ── f ─────────────────────────────────────────────────────────────────────
  [/[𝐟𝑓𝒇𝓯𝔣𝕗𝖋𝗳𝘧𝙛ḟ]/gu, 'f'],
  // ── g ─────────────────────────────────────────────────────────────────────
  [/[𝐠𝑔𝒈𝓰𝔤𝕘𝖌𝗴𝘨𝙜ğǧ]/gu, 'g'],
  // ── i ─────────────────────────────────────────────────────────────────────
  [/[іϊ𝐢𝑖𝒊𝓲𝔦𝕚𝖎𝗶𝘪𝙞ìíîïīįı]/gu, 'i'],
  // ── k ─────────────────────────────────────────────────────────────────────
  [/[κ𝐤𝑘𝒌𝓴𝔨𝕜𝖐𝗸𝘬𝙠]/gu, 'k'],
  // ── l ─────────────────────────────────────────────────────────────────────
  [/[ӏ𝐥𝑙𝒍𝓵𝔩𝕝𝖑𝗹𝘭𝙡ļłℓ]/gu, 'l'],
  // ── n ─────────────────────────────────────────────────────────────────────
  [/[η𝐧𝑛𝒏𝓷𝔫𝕟𝖓𝗻𝘯𝙣ñńņ]/gu, 'n'],
  // ── s ─────────────────────────────────────────────────────────────────────
  [/[ѕ𝐬𝑠𝒔𝓼𝔰𝕤𝖘𝗌𝘴𝙨śšş]/gu, 's'],
  // ── u ─────────────────────────────────────────────────────────────────────
  [/[υ𝐮𝑢𝒖𝓾𝔲𝕦𝖚𝗎𝘶𝙪ùúûüū]/gu, 'u'],
  // ── v ─────────────────────────────────────────────────────────────────────
  [/[ν𝐯𝑣𝒗𝓿𝔳𝕧𝖛𝗏𝘷𝙫]/gu, 'v'],
  // ── w ─────────────────────────────────────────────────────────────────────
  [/[ω𝐰𝑤𝒘𝔀𝔴𝕨𝖜𝗐𝘸𝙬]/gu, 'w'],
  // ── x ─────────────────────────────────────────────────────────────────────
  [/[х×𝐱𝑥𝒙𝔁𝔵𝕩𝖝𝗑𝘹𝙭]/gu, 'x'],
  // ── y ─────────────────────────────────────────────────────────────────────
  [/[уγ𝐲𝑦𝒚𝔂𝔶𝕪𝖞𝗒𝘺𝙮ýÿ]/gu, 'y'],
  // ── z ─────────────────────────────────────────────────────────────────────
  [/[𝐳𝑧𝒛𝔃𝔷𝕫𝖟𝗓𝘻𝙯źżž]/gu, 'z'],
];

/**
 * Apply the confusables map to replace visually similar Unicode characters
 * with their ASCII equivalents, catching homoglyph bypass attempts that
 * survive NFKC normalization (e.g., Cyrillic 'р' → 'p', 'с' → 'c').
 */
function _deconfuse(s: string): string {
  let out = s;
  for (const [re, replacement] of CONFUSABLES) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Normalize a string to defeat common obfuscation techniques before pattern matching:
 *   - NFKC unicode catches lookalike characters (Cyrillic 'о' → 'o', full-width chars → ASCII)
 *   - Confusables map catches homoglyphs NFKC misses (Mathematical Alphanumeric, Greek letters)
 *   - Quote stripping removes shell no-op quoting for BOTH single and double
 *     quotes (dr'o'p → drop, dr"o"p → drop). All bare quote characters are
 *     removed — not just matched pairs — so unbalanced quotes (drop" → drop)
 *     can't slip a destructive keyword past the matcher either.
 *   - Backslash-escape collapsing removes literal escapes (ta\ble → table)
 *   - Whitespace collapsing catches double-space separators
 */
export function normalizeForMatching(s: string): string {
  return _deconfuse(s
    .normalize('NFKC')
    .replace(/['"]/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .toLowerCase());
}
