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

/** Re-read ~/.mergen/pii-config.json — for tests and future SIGHUP support. */
export function reloadPiiConfig(): void {
  loadPiiConfig();
}

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

// Value patterns — always-on
const RE_JWT      = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const RE_BEARER   = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}\b/gi;
const RE_EMAIL    = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const RE_CARD     = /\b(?:\d[ -]?){13,19}\b/g;
// Phone: US/international formats — narrow enough to avoid false-positives on version numbers
const RE_PHONE    = /\b(\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/g;
// AWS access key IDs — always 20 uppercase alphanumeric starting with AKIA/AROA/ASIA/AIDA/ANPA/ANVA/APKA
const RE_AWS_KEY  = /\b(AKIA|AROA|ASIA|AIDA|ANPA|ANVA|APKA)[0-9A-Z]{16}\b/g;
// PEM private key headers — strip entire key value
const RE_PEM      = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g;

// ── File-based PII config ─────────────────────────────────────────────────────
// ~/.mergen/pii-config.json can add { "patterns": ["/regex/flags"] } entries.
// Loaded once at startup; send SIGHUP or restart to reload.
import fs from 'fs';
import path from 'path';
import os from 'os';

const PII_CONFIG_FILE = path.join(os.homedir(), '.mergen', 'pii-config.json');
let _customPatterns: RegExp[] = [];

function loadPiiConfig(): void {
  if (!fs.existsSync(PII_CONFIG_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(PII_CONFIG_FILE, 'utf8')) as { patterns?: string[] };
    _customPatterns = (raw.patterns ?? []).flatMap((p) => {
      try {
        const m = p.match(/^\/(.*)\/([gimsuy]*)$/);
        return m ? [new RegExp(m[1], m[2])] : [];
      } catch { return []; }
    });
  } catch { /* ignore */ }
}

loadPiiConfig();

function redactString(s: string): string {
  // Fully redact strings that are far beyond any legitimate field length — PII
  // patterns inside a multi-MB blob aren't useful to the LLM anyway.
  if (s.length > 100_000) return REDACTED;
  let out = s
    .replace(RE_PEM, REDACTED)
    .replace(RE_JWT, REDACTED)
    .replace(RE_BEARER, `Bearer ${REDACTED}`)
    .replace(RE_AWS_KEY, REDACTED)
    .replace(RE_EMAIL, REDACTED)
    .replace(RE_CARD, REDACTED)
    .replace(RE_PHONE, REDACTED);
  for (const re of _customPatterns) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
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
