/**
 * feedback-token.ts — HMAC tokens for attribution feedback links.
 *
 * Prevents the /attribution-feedback IDOR: without a token, any caller
 * who knows an incident row ID can forge feedback verdicts and corrupt the
 * calibration corpus. Tokens are per-(id, correct) pairs so they can't be
 * re-used across incident IDs or flipped from correct to wrong.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './paths.js';

const TOKEN_FILE = path.join(DATA_DIR, 'feedback-secret');
const TOKEN_LEN = 32; // hex chars returned by slice

let _secret = '';

function getSecret(): string {
  if (_secret) return _secret;
  try {
    const s = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (s.length >= 64) { _secret = s; return _secret; }
  } catch {}
  _secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, _secret, { mode: 0o600 });
  } catch {}
  return _secret;
}

/** Generate a short HMAC token scoped to a specific (id, correct) pair. */
export function generateFeedbackToken(id: number, correct: 0 | 1): string {
  return crypto
    .createHmac('sha256', getSecret())
    .update(`${id}:${correct}`)
    .digest('hex')
    .slice(0, TOKEN_LEN);
}

/** Verify a token in constant time. Returns false on any mismatch or error. */
export function verifyFeedbackToken(id: number, correct: 0 | 1, token: string): boolean {
  if (!token || token.length !== TOKEN_LEN) return false;
  const expected = generateFeedbackToken(id, correct);
  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
