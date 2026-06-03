import { Request, Response, Router } from 'express';
import { layer2Store } from '../sensor/layer2-store.js';
import { layer3Store } from '../sensor/layer3-store.js';

export const layersRouter = Router();

// ── Layer 3: Command polling endpoint for extension ──────────────────────────

layersRouter.get('/commands', (_req: Request, res: Response): void => {
  const commands = layer3Store.getPendingCommands();
  res.json({ commands });
});

// ── Layer 3: Captured log data from extension ────────────────────────────────

layersRouter.post('/log-capture', (req: Request, res: Response): void => {
  const { id, data } = req.body;
  if (!id) {
    res.status(400).json({ error: 'Missing id' });
    return;
  }
  layer3Store.captureLogData(id, data);
  res.status(204).end();
});

// ── Layer 3: Mock hit tracking ───────────────────────────────────────────────

layersRouter.post('/mock-hit', (req: Request, res: Response): void => {
  const { url, method } = req.body;
  if (!url || !method) {
    res.status(400).json({ error: 'Missing url or method' });
    return;
  }
  const mock = layer3Store.getMock(url, method);
  if (mock) {
    res.json(mock);
  } else {
    res.status(404).json({ error: 'No mock found' });
  }
});

// ── Snapshot debugging ────────────────────────────────────────────────────────
// GET  /snapshots        → list all captured diagnostic snapshots (newest first)
// GET  /snapshots/:id    → get one snapshot as JSON (downloadable bundle)
// DELETE /snapshots      → clear all snapshots

layersRouter.get('/snapshots', (_req: Request, res: Response): void => {
  const snaps = layer3Store.listSnapshots().map(s => ({
    id:         s.id,
    capturedAt: s.capturedAt,
    capturedAtIso: new Date(s.capturedAt).toISOString(),
    trigger:    s.trigger,
    logCount:   s.recentLogs.length,
    netCount:   s.recentNetwork.length,
    hasContext: !!s.contextSnapshot,
  }));
  res.json({ ok: true, count: snaps.length, snapshots: snaps });
});

layersRouter.get('/snapshots/:id', (req: Request, res: Response): void => {
  const snap = layer3Store.getSnapshot(req.params['id'] ?? '');
  if (!snap) {
    res.status(404).json({ error: 'snapshot not found' });
    return;
  }
  res.setHeader('Content-Disposition', `attachment; filename="mergen-snapshot-${snap.id}.json"`);
  res.json(snap);
});

layersRouter.delete('/snapshots', (_req: Request, res: Response): void => {
  layer3Store.clearSnapshots();
  res.json({ ok: true });
});

// Prune old data periodically
setInterval(() => {
  layer2Store.pruneEventIndex();
  layer3Store.pruneOldCommands();
}, 30_000);
