/**
 * routes/arch.ts — Architectural governance REST endpoints.
 *
 *   GET  /arch/violations          scan for boundary violations (optional ?srcDir=)
 *   POST /arch/risk                compute change risk score for a list of files
 *   GET  /arch/graph               return zone-level adjacency summary
 *   POST /arch/critique            run post-implementation critic on a list of files
 */

import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import { checkBoundaries } from '../intelligence/arch-boundaries.js';
import { scoreChangeRisk } from '../intelligence/change-risk.js';
import { buildGraph, getZone } from '../intelligence/arch-graph.js';
import { critiqueImplementation } from '../intelligence/impl-critic.js';

function defaultSrcDir(): string {
  const cwd = process.cwd();
  const candidates = [path.resolve(cwd, 'src'), path.resolve(cwd, 'server/src')];
  const { existsSync } = require('fs');
  for (const c of candidates) if (existsSync(c)) return c;
  return path.resolve(cwd, 'src');
}

const RiskBodySchema = z.object({
  files:  z.array(z.string()).min(1),
  srcDir: z.string().optional(),
});

const CritiqueBodySchema = z.object({
  files:  z.array(z.string()).min(1),
  srcDir: z.string().optional(),
});

export function createArchRouter(): Router {
  const router = Router();

  router.get('/arch/violations', (req, res) => {
    const srcDir = typeof req.query.srcDir === 'string' ? req.query.srcDir : defaultSrcDir();
    const result = checkBoundaries({ srcDir });
    res.json({ ok: true, violations: result.violations, filesChecked: result.filesChecked, cleanFiles: result.cleanFiles });
  });

  router.post('/arch/risk', (req, res) => {
    const parsed = RiskBodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation failed', details: parsed.error.issues }); return; }
    const { files, srcDir = defaultSrcDir() } = parsed.data;
    const absoluteFiles = files.map((f) => path.isAbsolute(f) ? f : path.resolve(srcDir, f));
    const report = scoreChangeRisk(absoluteFiles, srcDir);
    res.json({ ok: true, report });
  });

  router.get('/arch/graph', (req, res) => {
    const srcDir = typeof req.query.srcDir === 'string' ? req.query.srcDir : defaultSrcDir();
    const graph = buildGraph(srcDir);
    // Return a compact zone-level adjacency summary (full graph can be huge)
    const zonePairs = new Map<string, number>();
    for (const [file, imports] of graph.forward) {
      const fromZone = getZone(file);
      for (const imp of imports) {
        const toZone = getZone(imp);
        const key = `${fromZone}→${toZone}`;
        zonePairs.set(key, (zonePairs.get(key) ?? 0) + 1);
      }
    }
    res.json({
      ok: true,
      files: graph.files.length,
      builtAt: new Date(graph.builtAt).toISOString(),
      zoneSummary: Object.fromEntries(zonePairs),
    });
  });

  router.post('/arch/critique', (req, res) => {
    const parsed = CritiqueBodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation failed', details: parsed.error.issues }); return; }
    const { files, srcDir = defaultSrcDir() } = parsed.data;
    const absoluteFiles = files.map((f) => path.isAbsolute(f) ? f : path.resolve(srcDir, f));
    const report = critiqueImplementation({ files: absoluteFiles, srcDir });
    res.json({ ok: true, report });
  });

  return router;
}
