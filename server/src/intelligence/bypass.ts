/**
 * bypass.ts — operator bypass-token lifecycle for the tool-call gate.
 *
 * Extracted from tool-guard.ts. When the gate BLOCKs a call, it registers a
 * one-time bypass token (logged to the operator terminal only, never returned to
 * the agent — see tool-guard.ts). An operator approves the token out-of-band;
 * the next matching call consumes it and is allowed through (hard-block rules are
 * still re-checked in tool-guard.ts and can never be bypassed).
 *
 * Owns the pending-bypass map and its signed persistence file so the state has a
 * single home; tool-guard.ts and routes/hitl.ts call these functions.
 */
import { randomBytes, createHmac } from 'crypto';
import fs from 'fs';
import { recordHitlDecision } from './gate-analytics.js';
import { BYPASS_PENDING_FILE, DATA_DIR, zeroRetentionMode } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

// ── Bypass file signing secret ────────────────────────────────────────────────
// Set from index.ts once the local secret is loaded. Used to HMAC-sign the
// bypass persistence file so it can't be tampered with while the server is down.
let _bypassSigningSecret = '';
export function setBypassSecret(secret: string): void {
  _bypassSigningSecret = secret;
}

function _signBypassPayload(payload: string): string {
  if (!_bypassSigningSecret) return '';
  return createHmac('sha256', _bypassSigningSecret).update(payload).digest('hex');
}

interface PendingBypass {
  token: string;
  toolName: string;
  commandArg: string;
  triggeredRules: string[];
  registeredAt: number;
  approved: boolean;
  expiresAt: number;
}

const _pendingBypasses = new Map<string, PendingBypass>();

function normalizeCommand(cmd: unknown): string {
  if (typeof cmd !== 'string') return '';
  return cmd.trim().replace(/\s+/g, ' ');
}

export function registerBypassBlock(toolName: string, commandArg: string, triggeredRules: string[] = []): string {
  const normalizedCmd = normalizeCommand(commandArg);
  const now = Date.now();
  for (const [token, b] of _pendingBypasses.entries()) {
    if (now > b.expiresAt) _pendingBypasses.delete(token);
  }

  for (const [token, b] of _pendingBypasses.entries()) {
    if (b.toolName === toolName && b.commandArg === normalizedCmd && !b.approved) {
      return token;
    }
  }

  // Use 16 random bytes as hex (128 bits) — no hyphens, no modulo bias, opaque.
  let token: string;
  do { token = randomBytes(16).toString('hex'); } while (_pendingBypasses.has(token));

  _pendingBypasses.set(token, {
    token,
    toolName,
    commandArg: normalizedCmd,
    triggeredRules,
    registeredAt: now,
    approved: false,
    expiresAt: now + 10 * 60 * 1000, // 10 minutes
  });
  return token;
}

export function approveBypass(token: string): { ok: boolean; toolName?: string; commandArg?: string } {
  const b = _pendingBypasses.get(token);
  if (!b || Date.now() > b.expiresAt) return { ok: false };
  b.approved = true;
  recordHitlDecision(b.triggeredRules, 'approve', b.registeredAt);
  return { ok: true, toolName: b.toolName, commandArg: b.commandArg };
}

export function checkAndConsumeBypass(toolName: string, commandArg: string): boolean {
  const normalizedCmd = normalizeCommand(commandArg);
  const now = Date.now();
  for (const [token, b] of _pendingBypasses.entries()) {
    if (now > b.expiresAt) {
      _pendingBypasses.delete(token);
      continue;
    }
    if (b.toolName === toolName && b.commandArg === normalizedCmd && b.approved) {
      _pendingBypasses.delete(token);
      return true;
    }
  }
  return false;
}

export function getPendingBypasses(): Array<{ token: string; toolName: string; commandArg: string; expiresAt: number }> {
  const now = Date.now();
  const list = [];
  for (const [token, b] of _pendingBypasses.entries()) {
    if (now > b.expiresAt) {
      _pendingBypasses.delete(token);
      continue;
    }
    if (!b.approved) {
      list.push({
        token: b.token,
        toolName: b.toolName,
        commandArg: b.commandArg,
        expiresAt: b.expiresAt,
      });
    }
  }
  return list;
}

export function getPendingBypassDetail(token: string) {
  const b = _pendingBypasses.get(token);
  if (!b || Date.now() > b.expiresAt) return null;
  return b;
}

/** Forcibly invalidate a bypass token — called after too many failed approval attempts. */
export function invalidateBypassToken(token: string): void {
  _pendingBypasses.delete(token);
}

// ── Bypass token persistence (survives server restarts within validity window) ──

interface BypassFile { version: 1; bypasses: PendingBypass[]; sig?: string }

export function persistBypasses(): void {
  if (zeroRetentionMode()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const now    = Date.now();
    const active = [..._pendingBypasses.values()].filter((b) => b.expiresAt > now);
    const payload = JSON.stringify({ version: 1, bypasses: active } satisfies Omit<BypassFile, 'sig'>);
    const sig     = _signBypassPayload(payload);
    const final   = sig ? JSON.stringify({ version: 1, bypasses: active, sig } satisfies BypassFile) : payload;
    const tmp     = `${BYPASS_PENDING_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, final, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, BYPASS_PENDING_FILE);
  } catch (err) {
    logger.warn({ err }, 'tool-guard: bypass persist failed');
  }
}

export function loadBypasses(): void {
  if (zeroRetentionMode() || !fs.existsSync(BYPASS_PENDING_FILE)) return;
  try {
    const fileContent = fs.readFileSync(BYPASS_PENDING_FILE, 'utf8');
    const raw = JSON.parse(fileContent) as BypassFile;
    if (raw?.version !== 1 || !Array.isArray(raw.bypasses)) return;

    // Verify HMAC if we have a signing secret. Reject the file if it fails.
    if (_bypassSigningSecret && raw.sig !== undefined) {
      const { sig, ...rest } = raw;
      const expectedPayload = JSON.stringify(rest);
      const expected = _signBypassPayload(expectedPayload);
      const sigBuf      = Buffer.from(sig,      'hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      const valid = sigBuf.length === expectedBuf.length &&
        createHmac('sha256', _bypassSigningSecret).update(expectedPayload).digest().equals(expectedBuf);
      if (!valid) {
        logger.error(
          { path: BYPASS_PENDING_FILE },
          'tool-guard: bypass file HMAC mismatch — file may have been tampered with. Discarding.',
        );
        try { fs.unlinkSync(BYPASS_PENDING_FILE); } catch { /* ignore */ }
        return;
      }
    } else if (_bypassSigningSecret && raw.sig === undefined) {
      // Secret is set but file has no sig — written before signing was enabled.
      // Accept once and re-sign on next persist (migration path).
      logger.warn({ path: BYPASS_PENDING_FILE }, 'tool-guard: bypass file has no signature — accepting once and re-signing');
    }

    const now = Date.now();
    for (const b of raw.bypasses) {
      if (b.expiresAt > now) _pendingBypasses.set(b.token, b);
    }
    if (_pendingBypasses.size > 0) logger.info({ count: _pendingBypasses.size }, 'tool-guard: restored pending bypass tokens');
  } catch (err) {
    logger.warn({ err }, 'tool-guard: bypass load failed');
  }
}
