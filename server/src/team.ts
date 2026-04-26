/**
 * team.ts — Team sync backend.
 *
 * Architecture:
 *   - Team members share a "team token" (stored in ~/.mergen/team.json).
 *   - Each member's server POSTs events to a shared relay endpoint, or uses
 *     a self-hosted relay (configurable via MERGEN_RELAY_URL env).
 *   - Built-in relay: GET /team/stream  → SSE stream of teammate events
 *                     POST /team/push   → ingest a teammate's batch (auth by team token)
 *   - When teamSync is enabled, the ingest pipeline also calls broadcastToTeam()
 *     which fans events out to all connected SSE subscribers.
 *
 * Team token flow:
 *   POST /team/init  { token }  → save token, enable team mode
 *   DELETE /team     → disable team mode
 *   GET /team        → current team state
 */

import fs from 'fs/promises';
import os from 'os';
import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { BrowserEvent } from './buffer.js';
import { store, BrowserEventSchema } from './buffer.js';
import { getActivePlanId } from './license.js';
import { DATA_DIR, TEAM_FILE } from './paths.js';  // P4.1
import logger from './logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TeamState {
  token: string;               // shared secret among team members
  memberName: string;          // human-readable name for this member (hostname by default)
  relayUrl: string | null;     // external relay URL, null = use built-in relay
  enabled: boolean;
  joinedAt: string;
}

interface SseClient {
  id: string;
  res: Response;
  memberName: string;
}

// ── Safe token comparison ─────────────────────────────────────────────────
// timingSafeEqual throws RangeError if buffers differ in length.
function safeTokenCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ── In-memory state ───────────────────────────────────────────────────────────

let _team: TeamState | null = null;
const _clients: Map<string, SseClient> = new Map();

export function getTeamState(): TeamState | null { return _team; }

export function isTeamEnabled(): boolean {
  return _team?.enabled === true && getActivePlanId() === 'team';
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persistTeam(state: TeamState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TEAM_FILE, JSON.stringify(state, null, 2), 'utf8');
  _team = state;
}

export async function initTeam(): Promise<void> {
  try {
    const raw = await fs.readFile(TEAM_FILE, 'utf8');
    _team = JSON.parse(raw) as TeamState;
    logger.info({ memberName: _team.memberName, relay: _team.relayUrl ?? 'built-in' }, 'team sync loaded');
  } catch {
    // No team configured — that's fine
  }
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

/**
 * Broadcast events to all connected SSE subscribers (built-in relay mode).
 * Called by the ingest pipeline when team sync is active.
 */
export function broadcastToTeam(events: BrowserEvent[], fromMember: string): void {
  if (_clients.size === 0) return;
  const payload = JSON.stringify({ from: fromMember, events, ts: Date.now() });
  for (const [id, client] of _clients) {
    try {
      client.res.write(`data: ${payload}\n\n`);
    } catch {
      _clients.delete(id);
    }
  }
}

/**
 * Push events to an external relay (when relayUrl is configured).
 */
export async function pushToRelay(events: BrowserEvent[]): Promise<void> {
  if (!_team?.relayUrl) return;
  try {
    await fetch(`${_team.relayUrl}/team/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mergen-team-token': _team.token,
        'x-mergen-member': _team.memberName,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    logger.warn({ err }, 'team relay push failed');
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export const teamRouter = Router();

/** GET /team — current team state */
teamRouter.get('/team', (_req: Request, res: Response): void => {
  if (!_team) {
    res.json({ enabled: false, connectedPeers: 0 });
    return;
  }
  res.json({
    enabled: _team.enabled,
    memberName: _team.memberName,
    relayUrl: _team.relayUrl,
    joinedAt: _team.joinedAt,
    connectedPeers: _clients.size,
    planSupportsTeam: getActivePlanId() === 'team',
  });
});

/** POST /team/init { token, memberName?, relayUrl? } — join a team */
teamRouter.post('/team/init', async (req: Request, res: Response): Promise<void> => {
  if (getActivePlanId() !== 'team') {
    res.status(403).json({ error: 'Team sync requires a Team plan license' });
    return;
  }

  const { token, memberName, relayUrl } = req.body as {
    token?: string;
    memberName?: string;
    relayUrl?: string;
  };

  if (!token || typeof token !== 'string' || token.trim().length < 8) {
    res.status(400).json({ error: 'token must be at least 8 characters' });
    return;
  }

  const state: TeamState = {
    token: token.trim(),
    memberName: (memberName ?? os.hostname()).trim(),
    relayUrl: relayUrl?.trim() || null,
    enabled: true,
    joinedAt: new Date().toISOString(),
  };

  await persistTeam(state);
  logger.info({ memberName: state.memberName }, 'team sync initialized');
  res.json({ ok: true, memberName: state.memberName, relayUrl: state.relayUrl ?? 'built-in' });
});

/** DELETE /team — leave the team */
teamRouter.delete('/team', async (_req: Request, res: Response): Promise<void> => {
  await fs.rm(TEAM_FILE, { force: true });
  _team = null;
  // Close all SSE connections
  for (const [, client] of _clients) {
    try { client.res.end(); } catch { /* ignore */ }
  }
  _clients.clear();
  logger.info('team sync disabled');
  res.json({ ok: true });
});

/**
 * GET /team/stream — SSE stream of teammate events.
 * Clients authenticate with the shared team token via header or query param.
 */
teamRouter.get('/team/stream', (req: Request, res: Response): void => {
  if (!_team?.enabled) {
    res.status(404).json({ error: 'team sync not configured' });
    return;
  }

  const token = (req.headers['x-mergen-team-token'] as string) ?? (req.query.token as string);
  if (!token || !safeTokenCompare(token, _team.token)) {
    res.status(401).json({ error: 'invalid team token' });
    return;
  }

  const memberName = (req.headers['x-mergen-member'] as string) ?? 'unknown';
  const clientId = crypto.randomUUID();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial handshake
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId, memberCount: _clients.size + 1 })}\n\n`);

  _clients.set(clientId, { id: clientId, res, memberName });
  logger.info({ memberName, clientId, total: _clients.size }, 'team member connected to SSE');

  // Broadcast join event to other clients
  const joinPayload = JSON.stringify({ type: 'peer_joined', memberName, ts: Date.now() });
  for (const [id, client] of _clients) {
    if (id !== clientId) {
      try { client.res.write(`data: ${joinPayload}\n\n`); } catch { _clients.delete(id); }
    }
  }

  req.on('close', () => {
    _clients.delete(clientId);
    logger.info({ memberName, clientId, remaining: _clients.size }, 'team member disconnected');
    // Broadcast leave
    const leavePayload = JSON.stringify({ type: 'peer_left', memberName, ts: Date.now() });
    for (const [id, client] of _clients) {
      try { client.res.write(`data: ${leavePayload}\n\n`); } catch { _clients.delete(id); }
    }
  });

  // Heartbeat every 25 s to keep connection alive through proxies
  const hb = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(hb);
      _clients.delete(clientId);
    }
  }, 25_000);

  req.on('close', () => clearInterval(hb));
});

/**
 * POST /team/push — receive events from a teammate (relay mode).
 * Authenticated by the shared team token.
 */
teamRouter.post('/team/push', async (req: Request, res: Response): Promise<void> => {
  if (!_team?.enabled) {
    res.status(404).json({ error: 'team sync not configured' });
    return;
  }

  const token = req.headers['x-mergen-team-token'] as string;
  if (!token || !safeTokenCompare(token, _team.token)) {
    res.status(401).json({ error: 'invalid team token' });
    return;
  }

  const from = (req.headers['x-mergen-member'] as string) ?? 'unknown';
  const { events } = req.body as { events?: BrowserEvent[] };

  if (!Array.isArray(events) || events.length === 0) {
    res.status(400).json({ error: 'events array required' });
    return;
  }

  // Validate each event with Zod before injecting into the buffer
  const validated: BrowserEvent[] = [];
  for (const raw of events) {
    const result = BrowserEventSchema.safeParse(raw);
    if (result.success) validated.push(result.data);
  }

  if (validated.length === 0) {
    res.status(400).json({ error: 'no valid events in payload' });
    return;
  }

  for (const e of validated) {
    store.push(e);
  }
  broadcastToTeam(validated, from);

  logger.info({ from, count: validated.length, dropped: events.length - validated.length }, 'team events received');
  res.json({ ok: true, ingested: validated.length });
});
