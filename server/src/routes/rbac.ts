/**
 * routes/rbac.ts — REST API for managing RBAC membership.
 *
 *   GET    /rbac/members          list all members
 *   POST   /rbac/members          add or update { id, role }
 *   PUT    /rbac/members/:id      update role { role }
 *   DELETE /rbac/members/:id      remove member
 *
 * All mutating endpoints require the x-mergen-member header to identify the
 * caller, and the caller must have the 'admin' role (or RBAC must be unconfigured).
 */

import { Router } from 'express';
import { z } from 'zod';
import { listMembers, upsertMember, removeMember, hasPermission, resolveRole } from '../sensor/rbac.js';
import logger from '../sensor/logger.js';

const RoleSchema = z.enum(['viewer', 'responder', 'admin']);

export function createRbacRouter(): Router {
  const router = Router();

  // ── List ─────────────────────────────────────────────────────────────────────
  router.get('/rbac/members', (_req, res) => {
    res.json({ ok: true, members: listMembers() });
  });

  // ── Add / update ─────────────────────────────────────────────────────────────
  router.post('/rbac/members', (req, res) => {
    const caller = (req.headers['x-mergen-member'] as string | undefined) ?? 'unknown';
    if (!hasPermission(caller, 'admin')) {
      res.status(403).json({ error: 'admin role required' });
      return;
    }

    const parsed = z.object({ id: z.string().min(1), role: RoleSchema }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'id and role (viewer|responder|admin) are required' });
      return;
    }

    const member = upsertMember(parsed.data.id, parsed.data.role);
    logger.info({ caller, target: member.id, role: member.role }, 'rbac: member added via API');
    res.json({ ok: true, member });
  });

  // ── Update role ───────────────────────────────────────────────────────────────
  router.put('/rbac/members/:id', (req, res) => {
    const caller = (req.headers['x-mergen-member'] as string | undefined) ?? 'unknown';
    if (!hasPermission(caller, 'admin')) {
      res.status(403).json({ error: 'admin role required' });
      return;
    }

    const parsed = z.object({ role: RoleSchema }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'role (viewer|responder|admin) is required' });
      return;
    }

    const member = upsertMember(req.params.id, parsed.data.role);
    res.json({ ok: true, member });
  });

  // ── Remove ────────────────────────────────────────────────────────────────────
  router.delete('/rbac/members/:id', (req, res) => {
    const caller = (req.headers['x-mergen-member'] as string | undefined) ?? 'unknown';
    if (!hasPermission(caller, 'admin')) {
      res.status(403).json({ error: 'admin role required' });
      return;
    }

    const removed = removeMember(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'member not found' });
      return;
    }
    res.json({ ok: true });
  });

  // ── Check own role ────────────────────────────────────────────────────────────
  router.get('/rbac/me', (req, res) => {
    const actor = (req.headers['x-mergen-member'] as string | undefined) ?? 'unknown';
    res.json({ ok: true, actor, role: resolveRole(actor) });
  });

  return router;
}
