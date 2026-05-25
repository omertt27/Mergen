/**
 * debug-sessions.ts — Track debug hypothesis workflow sessions
 *
 * Enables "Debug Mode" pattern: capture baseline state, prompt user to reproduce,
 * then compare post-reproduction state to find what changed.
 */

import { randomUUID } from 'crypto';

interface DebugSession {
  id: string;
  hypothesis: string;
  target_component?: string;
  baseline_timestamp: number;
  baseline_buffer_size: number;
  started_at: number;
  ended_at?: number;
}

const activeSessions = new Map<string, DebugSession>();

export function startDebugSession(
  hypothesis: string,
  target_component?: string
): { session_id: string; baseline_timestamp: number; message: string } {
  const session: DebugSession = {
    id: randomUUID(),
    hypothesis,
    target_component,
    baseline_timestamp: Date.now(),
    baseline_buffer_size: 0, // Will be filled by tool
    started_at: Date.now(),
  };

  activeSessions.set(session.id, session);

  return {
    session_id: session.id,
    baseline_timestamp: session.baseline_timestamp,
    message:
      `Debug session started (ID: ${session.id}).\n\n` +
      `**Hypothesis:** ${hypothesis}\n` +
      `${target_component ? `**Target component:** ${target_component}\n` : ''}` +
      `**Baseline captured at:** ${new Date(session.baseline_timestamp).toISOString()}\n\n` +
      `**Next step:** Reproduce the issue now, then call \`end_debug_session("${session.id}")\` to see what changed.`,
  };
}

export function endDebugSession(
  session_id: string
): { session: DebugSession | null; post_reproduction_timestamp: number } {
  const session = activeSessions.get(session_id);

  if (!session) {
    return { session: null, post_reproduction_timestamp: Date.now() };
  }

  session.ended_at = Date.now();
  activeSessions.delete(session_id);

  return { session, post_reproduction_timestamp: Date.now() };
}

export function getActiveSession(session_id: string): DebugSession | null {
  return activeSessions.get(session_id) || null;
}

export function listActiveSessions(): DebugSession[] {
  return Array.from(activeSessions.values());
}

export function clearAllSessions(): number {
  const count = activeSessions.size;
  activeSessions.clear();
  return count;
}
