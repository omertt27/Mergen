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

  return router;
}
