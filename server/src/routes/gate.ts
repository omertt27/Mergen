/**
 * routes/gate.ts — HTTP entrypoint into the same tool-call gate MCP calls go
 * through (tool-guard.ts's applyGate), for non-MCP callers.
 *
 *   POST /gate/evaluate
 *
 * Used by:
 *   - `mergen-server exec -- <cmd>` — evaluates, then executes locally if PASS
 *   - `mergen-server gate-check -- <cmd>` — evaluates only, exits 0/1 (used by
 *     the Claude Code PreToolUse hook; Claude Code executes the command itself
 *     if the hook allows it)
 *
 * This is the actual fix for CLI/terminal coverage: previously `exec` ran its
 * own simplified, standalone policy check (no HITL hold, no blast-radius
 * upgrade, no injection detection, no session/reputation tracking, no
 * blunder-store logging) — a materially weaker gate than the MCP path for the
 * exact same kind of command. Routing through applyGate here means a CLI
 * caller gets the identical decision path an MCP tool call gets, including
 * suspending on HOLD until a human approves via /hitl/approve or /hitl/deny.
 *
 * Requires x-mergen-secret (registered in app.ts's MUTATING_PATHS) — this
 * evaluates and can execute security-relevant decisions, so it must not be
 * reachable by an unauthenticated caller on the local network.
 */

import { Router } from 'express';
import { z } from 'zod';
import { applyGate } from '../intelligence/tool-guard.js';

// actor is intentionally not accepted from the caller — tool-guard.ts's own
// rationale for MCP calls applies equally here: actor identity must not be
// derived from the caller's own claim, or a CLI invocation could pass
// --actor=human to evade AI-scoped policy rules.
const EvaluateSchema = z.object({
  toolName: z.string().min(1).optional(),
  command:  z.string().min(1),
});

export function createGateRouter(port: number): Router {
  const router = Router();

  router.post('/gate/evaluate', async (req, res) => {
    const parsed = EvaluateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'command is required', details: parsed.error.flatten() });
      return;
    }
    const { toolName, command } = parsed.data;

    // No real handler to invoke — the CLI caller executes the command itself
    // (or, for gate-check, doesn't execute at all). applyGate only calls this
    // once the verdict is already 'pass' (or a bypass token cleared a HOLD).
    const next = async () => ({ content: [{ type: 'text' as const, text: 'pass' }] });

    const result = await applyGate(toolName ?? 'cli_exec', { command }, next, port);
    res.json({
      isError: result.isError === true,
      text: result.content[0]?.text ?? '',
    });
  });

  return router;
}
