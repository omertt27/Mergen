/**
 * routes/agents.ts — Per-agent identity and permission management.
 *
 *   GET    /agents          List all registered agent profiles
 *   POST   /agents          Register a new agent profile
 *   GET    /agents/:id      Get a specific profile
 *   PATCH  /agents/:id      Update a profile
 *   DELETE /agents/:id      Remove a profile
 *   GET    /agents/active   Show which profile is active on this server instance
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  listProfiles,
  getProfile,
  saveProfile,
  deleteProfile,
  AgentProfile,
} from '../intelligence/agent-profiles.js';
import { getGateEvents } from '../intelligence/gate-analytics.js';
import { getStores } from '../storage/store-registry.js';

const ProfileSchema = z.object({
  id:              z.string().min(1).max(60).regex(/^[a-z0-9_-]+$/, 'id must be lowercase alphanumeric, hyphens, underscores'),
  name:            z.string().min(1).max(80),
  description:     z.string().max(300).default(''),
  allowedTools:    z.array(z.string()).default([]),
  blockedTools:    z.array(z.string()).default([]),
  allowedServices: z.array(z.string()).default([]),
  maxRiskTier:     z.enum(['read', 'restart', 'deploy', 'full']).default('restart'),
});

export function createAgentsRouter(): Router {
  const router = Router();

  router.get('/agents', (_req, res) => {
    const profiles = listProfiles();
    const activeId = process.env.MERGEN_AGENT_ID ?? null;
    res.json({ ok: true, profiles, activeId });
  });

  router.get('/agents/active', (_req, res) => {
    const agentId = process.env.MERGEN_AGENT_ID;
    if (!agentId) { res.json({ ok: true, active: null, note: 'MERGEN_AGENT_ID not set — no agent profile active' }); return; }
    const profile = getProfile(agentId);
    res.json({ ok: true, activeId: agentId, active: profile ?? null, registered: !!profile });
  });

  router.get('/agents/:id', (req, res) => {
    const profile = getProfile(req.params.id);
    if (!profile) { res.status(404).json({ error: 'Agent profile not found' }); return; }
    res.json({ ok: true, profile });
  });

  router.post('/agents', (req, res) => {
    const parsed = ProfileSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
    if (getProfile(parsed.data.id)) { res.status(409).json({ error: `Agent '${parsed.data.id}' already exists` }); return; }

    const profile: AgentProfile = { ...parsed.data, createdAt: Date.now() };
    saveProfile(profile);
    res.status(201).json({ ok: true, profile });
  });

  router.patch('/agents/:id', (req, res) => {
    const existing = getProfile(req.params.id);
    if (!existing) { res.status(404).json({ error: 'Agent profile not found' }); return; }

    const UpdateSchema = ProfileSchema.partial().omit({ id: true });
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

    const updated: AgentProfile = { ...existing, ...parsed.data };
    saveProfile(updated);
    res.json({ ok: true, profile: updated });
  });

  router.delete('/agents/:id', (req, res) => {
    if (!deleteProfile(req.params.id)) { res.status(404).json({ error: 'Agent profile not found' }); return; }
    res.json({ ok: true });
  });

  // ── GET /agents/:id/timeline — per-agent forensics timeline ─────────────────
  // Returns a unified chronological view of every gate decision + blunder for
  // the given agent. Use this for post-mortems: "what exactly did this agent do
  // during the incident, and what did the gate block?"
  //
  // Gate events: from the in-memory ring buffer (last 500 calls); filtered by agentId.
  // Blunders: from the hash-chained blunder log; filtered by actor == agentId.
  // Query params:
  //   limit  — max events to return (default 100, max 500)
  //   from   — Unix ms start (default: 24h ago)
  //   to     — Unix ms end (default: now)
  router.get('/agents/:id/timeline', async (req, res) => {
    const agentId = req.params.id;
    const now     = Date.now();
    const from    = Number(req.query.from ?? now - 24 * 60 * 60 * 1_000);
    const to      = Number(req.query.to   ?? now);
    const limit   = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));

    // Gate events from ring buffer
    const gateEntries = getGateEvents()
      .filter((e) => e.agentId === agentId && e.ts >= from && e.ts <= to)
      .map((e) => ({
        type:           'gate' as const,
        ts:             e.ts,
        toolName:       e.toolName,
        command:        e.command,
        verdict:        e.verdict,
        triggeredRules: e.triggeredRules,
        guidedAlternative: e.guidedAlternative,
        service:        e.service,
        environment:    e.environment,
      }));

    // Blunders from hash-chained log
    const blunderEntries = (await getStores().blunders.list())
      .filter((b) => b.actor === agentId && b.recordedAt >= from && b.recordedAt <= to)
      .map((b) => ({
        type:        'blunder' as const,
        ts:          b.recordedAt,
        toolName:    null as string | null,
        command:     b.command,
        verdict:     'block' as const,
        blunderType: b.blunderType,
        blockReason: b.blockReason,
        service:     b.service,
        hash:        b.hash,
      }));

    // Merge and sort chronologically, newest first
    const timeline = [...gateEntries, ...blunderEntries]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);

    const profile = getProfile(agentId);

    res.json({
      ok: true,
      agentId,
      profile: profile ?? null,
      from,
      to,
      total: timeline.length,
      timeline,
    });
  });

  return router;
}
