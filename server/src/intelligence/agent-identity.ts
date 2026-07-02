/**
 * agent-identity.ts — Signed agent identity tokens.
 *
 * Before this module, an agent's identity was `process.env.MERGEN_AGENT_ID` —
 * a plain, unauthenticated string set in the same environment the MCP server
 * spawns in. That's the same actor Mergen's own threat model distrusts (an AI
 * agent, or anything with the filesystem/process access one has): it could
 * self-declare any agentId, either to satisfy a permissive agent-profile's
 * allowlist or to evade a policy rule scoped to a different, specific agentId
 * via `conditions.agentIds`.
 *
 * This replaces self-assertion with a server-issued, HMAC-signed token —
 * following the exact `sha256=<hex>` + timingSafeEqual pattern already used
 * for enterprise-policy.json signing (enterprise-policy-engine.ts) and remote
 * policy sync verification (policy-sync.ts). Verification is stateless (no
 * database lookup): the token is self-contained, so any mergen-server process
 * can verify one issued by another as long as they share the signing secret.
 *
 * Issue:  `mergen-server agent-register <profile-id>` (commands/agent-identity.ts)
 * Verify: resolveAgentIdentity(), used by tool-guard.ts in place of the raw
 *         process.env.MERGEN_AGENT_ID read for anything that grants privilege
 *         or lets a caller evade a targeted rule (agent-profiles.ts allowlists,
 *         enterprise-policy-engine.ts conditions.agentIds). The raw env var is
 *         still used for reputation/session-tracking labeling, where a false
 *         label only affects which bucket telemetry lands in, not enforcement.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

const TOKEN_RECORD_DIR = path.join(DATA_DIR, 'agent-tokens');

/** Tokens are long-lived (re-issued explicitly via `agent-register`, not meant
 *  to expire mid-session) — 1 year, not a short-lived session credential. */
const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

interface AgentIdentityPayload {
  agentId:   string;
  issuedAt:  number;
  expiresAt: number;
  nonce:     string;
}

interface IssuedTokenRecord {
  agentId:   string;
  issuedAt:  number;
  expiresAt: number;
}

let _tokenSecret = '';

/** Wired at startup from index.ts, mirroring setPolicySigningSecret/setBypassSecret. */
export function setAgentTokenSecret(secret: string): void {
  _tokenSecret = secret;
}

function sign(payload: AgentIdentityPayload): string {
  const body = JSON.stringify(payload);
  const sig = createHmac('sha256', _tokenSecret).update(body).digest('hex');
  return Buffer.from(JSON.stringify({ payload, sig }), 'utf8').toString('base64url');
}

/** Issues a new signed token for agentId. Throws if the signing secret hasn't
 *  been initialized (setAgentTokenSecret must run before this — server startup
 *  ordering, not a runtime condition callers need to handle). */
export function issueToken(agentId: string, ttlMs = DEFAULT_TTL_MS): string {
  if (!_tokenSecret) {
    throw new Error('agent-identity: token secret not initialized — setAgentTokenSecret must run before issueToken');
  }
  const payload: AgentIdentityPayload = {
    agentId,
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    nonce: randomBytes(8).toString('hex'),
  };
  const token = sign(payload);
  _recordIssuedToken(agentId, payload.issuedAt, payload.expiresAt);
  return token;
}

/** Verifies a token's signature and expiry. Returns the verified agentId, or
 *  null if the token is malformed, tampered, expired, or the signing secret
 *  isn't configured (unverifiable is treated as invalid, not as valid). */
export function verifyToken(token: string): string | null {
  if (!_tokenSecret) return null;

  let decoded: { payload?: AgentIdentityPayload; sig?: string };
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!decoded.payload?.agentId || !decoded.sig) return null;

  const body = JSON.stringify(decoded.payload);
  const expected = createHmac('sha256', _tokenSecret).update(body).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  let actualBuf: Buffer;
  try {
    actualBuf = Buffer.from(decoded.sig, 'hex');
  } catch {
    return null;
  }
  if (expectedBuf.length !== actualBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return null;

  if (Date.now() > decoded.payload.expiresAt) return null;

  return decoded.payload.agentId;
}

let _warnedUnauthenticated = false;
let _warnedNoSecretWithToken = false;

/**
 * Resolves the caller's agent identity for THIS call. `verified: true` only
 * when a valid MERGEN_AGENT_TOKEN was presented — callers that grant privilege
 * or let a caller evade a targeted rule (agent-profiles allowlists,
 * conditions.agentIds matching) must check `verified` and treat an
 * unverified agentId as absent for those purposes. Reputation/session
 * tracking may use the raw id regardless, since a false label there only
 * affects telemetry bucketing, not enforcement.
 */
export function resolveAgentIdentity(): { agentId: string | undefined; verified: boolean } {
  const token = process.env.MERGEN_AGENT_TOKEN;
  if (token) {
    const verifiedId = verifyToken(token);
    if (verifiedId) return { agentId: verifiedId, verified: true };
    if (!_tokenSecret && !_warnedNoSecretWithToken) {
      logger.warn('agent-identity: MERGEN_AGENT_TOKEN is set but no signing secret is configured on this server — cannot verify, treating as unverified');
      _warnedNoSecretWithToken = true;
    } else {
      logger.warn('agent-identity: MERGEN_AGENT_TOKEN is set but invalid or expired — ignoring');
    }
  }

  const raw = process.env.MERGEN_AGENT_ID;
  if (raw && !_warnedUnauthenticated) {
    logger.warn(
      'agent-identity: MERGEN_AGENT_ID is set but unauthenticated (no valid MERGEN_AGENT_TOKEN) — it will ' +
      'be used for reputation/session labeling only, not for agent-profile permissions or policy ' +
      'conditions.agentIds matching. Run `mergen-server agent-register <profile-id>` to issue a verified token.',
    );
    _warnedUnauthenticated = true;
  }
  return { agentId: raw, verified: false };
}

// ── Issued-token record-keeping (operator visibility only — verification above
// is fully stateless and does not consult this list) ──────────────────────────

function _recordIssuedToken(agentId: string, issuedAt: number, expiresAt: number): void {
  try {
    fs.mkdirSync(TOKEN_RECORD_DIR, { recursive: true, mode: 0o700 });
    const file = path.join(TOKEN_RECORD_DIR, `${agentId}.json`);
    const record: IssuedTokenRecord = { agentId, issuedAt, expiresAt };
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    logger.warn({ err, agentId }, 'agent-identity: failed to persist issued-token record (non-fatal — token is still valid)');
  }
}

/** Lists issued-token records for operator visibility (`mergen-server agent-list`). */
export function listIssuedTokenRecords(): IssuedTokenRecord[] {
  try {
    if (!fs.existsSync(TOKEN_RECORD_DIR)) return [];
    return fs.readdirSync(TOKEN_RECORD_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(TOKEN_RECORD_DIR, f), 'utf8')) as IssuedTokenRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is IssuedTokenRecord => r !== null)
      .sort((a, b) => b.issuedAt - a.issuedAt);
  } catch {
    return [];
  }
}

/** Test-only reset so suites don't leak warned-once state or a secret across files. */
export function _resetAgentIdentityForTesting(): void {
  _tokenSecret = '';
  _warnedUnauthenticated = false;
  _warnedNoSecretWithToken = false;
}
