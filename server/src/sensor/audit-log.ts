/**
 * audit-log.ts — Append-only request audit log for enterprise compliance.
 *
 * Logs all non-trivial HTTP requests to ~/.mergen/audit.log as JSONL.
 * Rolls the file when it exceeds 10 MB (renamed to audit.log.1).
 *
 * Each entry records: timestamp, actor identity, method, path, HTTP status,
 * duration, and client IP. Actor is resolved from the x-mergen-member header,
 * falling back to the source IP.
 *
 * Enable with: MERGEN_AUDIT=true (or always-on — low overhead)
 * Read recent entries: GET /audit?limit=<n>
 */

import fs from 'fs';
import type { Request, Response, NextFunction } from 'express';
import { AUDIT_LOG, DATA_DIR } from './paths.js';
import logger from './logger.js';

const MAX_AUDIT_BYTES = 10 * 1024 * 1024; // 10 MB

const SKIP_PATHS = new Set(['/', '/health', '/metrics', '/dashboard', '/local-secret']);

export interface AuditEntry {
  ts: string;
  actor: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip: string;
}

function resolveActor(req: Request): string {
  const member = req.headers['x-mergen-member'] as string | undefined;
  if (member) return member;
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function appendEntry(entry: AuditEntry): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Rotate if over size limit
    try {
      const stat = fs.statSync(AUDIT_LOG);
      if (stat.size >= MAX_AUDIT_BYTES) {
        const rotated = AUDIT_LOG + '.1';
        try { fs.unlinkSync(rotated); } catch { /* ignore */ }
        fs.renameSync(AUDIT_LOG, rotated);
      }
    } catch { /* file doesn't exist yet — first write */ }
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    logger.warn({ err }, 'audit log write failed');
  }
}

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_PATHS.has(req.path) || req.path.startsWith('/dashboard')) { next(); return; }
  const start = Date.now();
  res.on('finish', () => {
    appendEntry({
      ts:         new Date().toISOString(),
      actor:      resolveActor(req),
      method:     req.method,
      path:       req.path,
      status:     res.statusCode,
      durationMs: Date.now() - start,
      ip:         req.ip ?? req.socket.remoteAddress ?? 'unknown',
    });
  });
  next();
}

export function getAuditLog(limit = 200): AuditEntry[] {
  try {
    const raw   = fs.readFileSync(AUDIT_LOG, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines.slice(-Math.min(limit, 2000)).map(l => JSON.parse(l) as AuditEntry).reverse();
  } catch {
    return [];
  }
}
