import { Router } from 'express';
import { getWatchState } from '../sensor/fs-watcher.js';

export function createValidateRouter(): Router {
  const router = Router();

  router.get('/validate/state', (_req, res) => {
    const state = getWatchState();
    res.json({ watching: state !== null, ...(state ?? {}) });
  });

  return router;
}
