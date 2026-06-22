/**
 * routes/runbooks.ts — Pre-approved runbook library.
 *
 * Runbooks are named, step-by-step repair procedures that humans approve
 * before going live. When the autopilot matches an incident tag to an
 * approved runbook it executes those steps instead of generating an ad-hoc
 * LLM command — giving compliance-conscious teams a review gate equivalent
 * to Shoreline's pre-approval model.
 *
 * GET  /runbooks              — list all runbooks
 * GET  /runbooks/:id          — fetch one runbook
 * POST /runbooks              — create a runbook (draft)
 * PUT  /runbooks/:id/approve  — record a human approval
 * DELETE /runbooks/:id        — remove a runbook
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Router } from 'express';
import { DATA_DIR } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

const LIBRARY_FILE = path.join(DATA_DIR, 'runbooks', 'library.json');
const RUNBOOKS_DIR = path.join(DATA_DIR, 'runbooks');

export interface Runbook {
  id: string;
  name: string;
  incidentTag: string;
  steps: string[];
  riskTier: 'RESTART' | 'DEPLOY' | 'FULL';
  requiredApprovers: number;
  approvals: { actor: string; approvedAt: number }[];
  approved: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function readLibrary(): Runbook[] {
  try {
    if (!fs.existsSync(LIBRARY_FILE)) return [];
    return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8')) as Runbook[];
  } catch {
    return [];
  }
}

function writeLibrary(runbooks: Runbook[]): void {
  try {
    fs.mkdirSync(RUNBOOKS_DIR, { recursive: true });
    const tmp = `${LIBRARY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(runbooks, null, 2), 'utf8');
    fs.renameSync(tmp, LIBRARY_FILE);
  } catch (err) {
    logger.error({ err }, 'runbooks: failed to persist library');
  }
}

// ── Public helper used by incident-autopilot ─────────────────────────────────

export function getRunbookForTag(incidentTag: string): Runbook | undefined {
  return readLibrary().find((r) => r.incidentTag === incidentTag && r.approved);
}

// ── Router ───────────────────────────────────────────────────────────────────

export function createRunbooksRouter(): Router {
  const router = Router();

  // GET /runbooks
  router.get('/runbooks', (_req, res) => {
    const runbooks = readLibrary();
    res.json({ ok: true, total: runbooks.length, runbooks });
  });

  // GET /runbooks/:id
  router.get('/runbooks/:id', (req, res) => {
    const runbook = readLibrary().find((r) => r.id === req.params['id']);
    if (!runbook) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ ok: true, runbook });
  });

  // POST /runbooks
  router.post('/runbooks', (req, res) => {
    const { name, incidentTag, steps, riskTier, requiredApprovers } = req.body as {
      name?: string;
      incidentTag?: string;
      steps?: string[];
      riskTier?: Runbook['riskTier'];
      requiredApprovers?: number;
    };

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' }); return;
    }
    if (!incidentTag || typeof incidentTag !== 'string') {
      res.status(400).json({ error: 'incidentTag is required' }); return;
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      res.status(400).json({ error: 'steps must be a non-empty array' }); return;
    }
    const validTiers = ['RESTART', 'DEPLOY', 'FULL'] as const;
    if (!riskTier || !validTiers.includes(riskTier)) {
      res.status(400).json({ error: 'riskTier must be RESTART, DEPLOY, or FULL' }); return;
    }

    const now = Date.now();
    const runbook: Runbook = {
      id: randomUUID(),
      name: name.slice(0, 200),
      incidentTag: incidentTag.slice(0, 100),
      steps: steps.map((s) => String(s).slice(0, 500)),
      riskTier,
      requiredApprovers: typeof requiredApprovers === 'number' && requiredApprovers > 0
        ? requiredApprovers
        : 1,
      approvals: [],
      approved: false,
      createdAt: now,
      updatedAt: now,
    };

    const library = readLibrary();
    library.push(runbook);
    writeLibrary(library);
    logger.info({ id: runbook.id, name: runbook.name, incidentTag }, 'runbooks: created');
    res.status(201).json({ ok: true, runbook });
  });

  // PUT /runbooks/:id/approve
  router.put('/runbooks/:id/approve', (req, res) => {
    const { actor } = req.body as { actor?: string };
    if (!actor || typeof actor !== 'string') {
      res.status(400).json({ error: 'actor is required' }); return;
    }

    const library = readLibrary();
    const runbook = library.find((r) => r.id === req.params['id']);
    if (!runbook) { res.status(404).json({ error: 'not found' }); return; }

    if (runbook.approvals.some((a) => a.actor === actor)) {
      res.status(409).json({ error: 'actor has already approved this runbook' }); return;
    }

    runbook.approvals.push({ actor: actor.slice(0, 100), approvedAt: Date.now() });
    runbook.approved = runbook.approvals.length >= runbook.requiredApprovers;
    runbook.updatedAt = Date.now();
    writeLibrary(library);

    logger.info(
      { id: runbook.id, actor, approved: runbook.approved, approvals: runbook.approvals.length },
      'runbooks: approval recorded',
    );
    res.json({ ok: true, runbook });
  });

  // DELETE /runbooks/:id
  router.delete('/runbooks/:id', (req, res) => {
    const library = readLibrary();
    const idx = library.findIndex((r) => r.id === req.params['id']);
    if (idx === -1) { res.status(404).json({ error: 'not found' }); return; }
    const [removed] = library.splice(idx, 1);
    writeLibrary(library);
    logger.info({ id: removed!.id, name: removed!.name }, 'runbooks: deleted');
    res.json({ ok: true });
  });

  return router;
}
