/**
 * routes/explain-why.ts — File-level PR intent lookup.
 *
 * GET /explain-why/file?path=src/api/auth.ts&repo=my-service&limit=5
 *
 * Returns PRs that touched the given file path, with their captured
 * intent: title, body excerpt, author, approvers, linked issues.
 *
 * Called by the VS Code extension's mergen.whyThisFile command and the
 * sidebar intent card — surfaces "why was this code written this way?"
 * at exactly the debugging moment without an LLM call.
 */
import { Router } from 'express';
import { commitContextStore } from '../sensor/commit-context-store.js';

export function createExplainWhyRouter(): Router {
  const router = Router();

  router.get('/explain-why/file', (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    const repo     = typeof req.query.repo  === 'string' && req.query.repo.trim() ? req.query.repo.trim() : undefined;
    const limit    = Math.min(10, Math.max(1, Number(req.query.limit ?? 5)));

    if (!filePath) {
      res.status(400).json({ error: '"path" query param is required' });
      return;
    }

    const contexts = commitContextStore.listByFile(filePath, repo, limit);
    res.json({
      ok: true,
      file: filePath,
      count: contexts.length,
      contexts: contexts.map((c) => ({
        sha:         c.sha.slice(0, 7),
        prNumber:    c.prNumber,
        prTitle:     c.prTitle,
        prBody:      c.prBody ? c.prBody.slice(0, 500) : null,
        author:      c.author,
        approvers:   c.approvers,
        linkedIssues: c.linkedIssues,
        aiGenerated: c.aiGenerated,
        aiTool:      c.aiTool,
        mergedAt:    c.mergedAt,
        capturedAt:  c.capturedAt,
      })),
    });
  });

  return router;
}
