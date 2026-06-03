/**
 * redact.ts — PII redaction for ingested events (D2).
 *
 * Even though all data stays on 127.0.0.1, devs routinely paste Context Packs
 * into AI chats (Cursor, Claude). We redact common PII patterns BEFORE the
 * data ever lands in the ring buffer so it can't accidentally leak.
 *
 * Configuration (env, comma-separated, case-insensitive):
 *   MERGEN_REDACT_KEYS="email,token,password,authorization,cookie,jwt"
 *     → any object key matching one of these is replaced with [REDACTED].
 *
 * Built-in value patterns are ALWAYS on:
 *   • JWTs (xxx.yyy.zzz with base64url segments)
 *   • Bearer tokens
 *   • Email addresses
 *   • Credit-card-like 13–19 digit runs
 *
 * Design contract:
 *   • MUST never throw — failure mode is "return input unchanged".
 *   • MUST be O(n) over the JSON size — no recursion bombs.
 *   • Strings/objects/arrays only; numbers/booleans/null pass through.
 */

const DEFAULT_KEYS = [
  'password', 'passwd', 'pwd',
  'authorization', 'auth',
  'cookie', 'set-cookie',
  'token', 'access_token', 'refresh_token', 'id_token', 'jwt',
  'apikey', 'api_key', 'api-key',
  'secret', 'client_secret',
  'session', 'sessionid', 'session_id',
  'email',
  'ssn', 'creditcard', 'credit_card', 'cc_number',
];

function loadKeys(): Set<string> {
  const env = process.env.MERGEN_REDACT_KEYS;
  const extra = env
    ? env.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  return new Set([...DEFAULT_KEYS, ...extra]);
}

let _keys = loadKeys();

/** Re-read MERGEN_REDACT_KEYS — for tests and future SIGHUP support. */
export function reloadRedactKeys(): void {
  _keys = loadKeys();
}

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

// Value patterns — always-on
const RE_JWT     = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const RE_BEARER  = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}\b/gi;
const RE_EMAIL   = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const RE_CARD    = /\b(?:\d[ -]?){13,19}\b/g;

function redactString(s: string): string {
  // Fully redact strings that are far beyond any legitimate field length — PII
  // patterns inside a multi-MB blob aren't useful to the LLM anyway.
  if (s.length > 100_000) return REDACTED;
  return s
    .replace(RE_JWT, REDACTED)
    .replace(RE_BEARER, `Bearer ${REDACTED}`)
    .replace(RE_EMAIL, REDACTED)
    .replace(RE_CARD, REDACTED);
}

function isSensitiveKey(key: string): boolean {
  return _keys.has(key.toLowerCase());
}

function redactInternal(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') return redactString(value as string);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactInternal(v, depth + 1));
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      out[k] = isSensitiveKey(k)
        ? REDACTED
        : redactInternal(obj[k], depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * Public API. Always call this on user-controlled values before storing.
 * Returns the redacted value, or the original on internal failure.
 */
export function redact(value: unknown): unknown {
  try {
    return redactInternal(value, 0);
  } catch {
    return value;
  }
}
