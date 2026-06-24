import { randomUUID } from 'crypto';
import type { ServerResponse } from 'http';

export interface ActivityEvent {
  id:             string;
  timestamp:      number;
  toolName:       string;
  commandArg:     string;
  verdict:        'PASS' | 'BLOCK' | 'HOLD';
  triggeredRules: string[];
  ruleNames:      string[];
}

const FEED_SIZE = 200;
const _feed: ActivityEvent[] = [];
const _sseClients = new Set<ServerResponse>();

export function recordActivity(event: Omit<ActivityEvent, 'id' | 'timestamp'>): void {
  const full: ActivityEvent = { id: randomUUID(), timestamp: Date.now(), ...event };
  _feed.push(full);
  if (_feed.length > FEED_SIZE) _feed.shift();
  for (const res of _sseClients) {
    try { res.write(`data: ${JSON.stringify(full)}\n\n`); } catch { _sseClients.delete(res); }
  }
}

export function getRecentActivity(limit = 50): ActivityEvent[] {
  return _feed.slice(-Math.min(limit, FEED_SIZE)).reverse();
}

export function subscribeToActivity(res: ServerResponse): () => void {
  _sseClients.add(res);
  // Hydrate with last 20 events
  const recent = _feed.slice(-20);
  for (const ev of recent) {
    try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { break; }
  }
  return () => _sseClients.delete(res);
}
