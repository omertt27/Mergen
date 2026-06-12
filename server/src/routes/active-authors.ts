/**
 * active-authors.ts — Monthly Active PR Author count.
 *
 * This is Mergen's core billing unit: unique GitHub logins that authored or
 * reviewed a PR in a given calendar month. It scales with automated developer
 * footprint (CI bots, AI coding agents) rather than headcount, which means
 * contract value expands automatically as customers deploy more automation.
 *
 * GET /billing/active-authors
 *   Returns the current month's count + trailing 12-month history.
 *   Query params:
 *     ?repo=org/repo   filter to a single repo
 *     ?months=N        history window (default: 12, max: 24)
 *
 * Sources:
 *   - commitContextStore: merged PR authors (primary signal)
 *   - habituationStore:   PR comment + review actors (catches reviewers who
 *     never merge but still interact with Mergen's output)
 *
 * An "active author" is any unique login that either:
 *   (a) merged a PR captured in the commit-context archive, OR
 *   (b) had a Mergen comment posted on their PR (comment_posted event)
 * in the billing month. Bots (login ends with [bot]) are included by default
 * since AI agents are the value driver — pass ?exclude_bots=true to strip them
 * from the count for human-seat comparisons.
 */

import { Router, type Request, type Response } from 'express';
import { commitContextStore } from '../sensor/commit-context-store.js';
import { getHabituationEvents } from '../sensor/habituation-store.js';

export function createActiveAuthorsRouter(): Router {
  const router = Router();

  router.get('/billing/active-authors', (req: Request, res: Response): void => {
    const repoFilter   = typeof req.query.repo === 'string' ? req.query.repo : null;
    const monthsBack   = Math.min(24, Math.max(1, parseInt(String(req.query.months ?? '12'), 10) || 12));
    const excludeBots  = req.query.exclude_bots === 'true';

    // ── Build monthly buckets ─────────────────────────────────────────────────
    // A bucket is "YYYY-MM". We go back `monthsBack` months from today.
    const now = new Date();
    const buckets: string[] = [];
    for (let i = 0; i < monthsBack; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    function toMonthKey(ts: number): string {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    // authorsByMonth[monthKey] = Set<login>
    const authorsByMonth = new Map<string, Set<string>>();
    for (const b of buckets) authorsByMonth.set(b, new Set());

    // Source 1: merged PR authors from commit-context archive
    const windowStart = new Date(now.getFullYear(), now.getMonth() - monthsBack + 1, 1).getTime();
    const windowEnd   = Date.now();
    const commitCtxs  = repoFilter
      ? commitContextStore.listByWindow(windowStart, windowEnd, repoFilter, 5000)
      : commitContextStore.listByWindow(windowStart, windowEnd, undefined, 5000);

    for (const ctx of commitCtxs) {
      const key = toMonthKey(ctx.mergedAt ?? ctx.capturedAt);
      const bucket = authorsByMonth.get(key);
      if (!bucket) continue;
      if (ctx.author) {
        if (!excludeBots || !ctx.author.endsWith('[bot]')) bucket.add(ctx.author);
      }
    }

    // Source 2: habituation events — covers reviewers who never push
    const habEvents = getHabituationEvents().filter(
      (e) => e.recordedAt >= windowStart &&
             e.eventType === 'comment_posted' &&
             (!repoFilter || e.repo === repoFilter),
    );
    for (const e of habEvents) {
      const key = toMonthKey(e.recordedAt);
      const bucket = authorsByMonth.get(key);
      if (!bucket) continue;
      if (!excludeBots || !e.actor.endsWith('[bot]')) bucket.add(e.actor);
    }

    // ── Shape response ────────────────────────────────────────────────────────
    const monthly = buckets.map((month) => ({
      month,
      activeAuthors: authorsByMonth.get(month)?.size ?? 0,
      authors: [...(authorsByMonth.get(month) ?? [])].sort(),
    }));

    const currentMonth = monthly[0];
    const prevMonth    = monthly[1] ?? null;
    const mom = prevMonth && prevMonth.activeAuthors > 0
      ? Math.round(((currentMonth.activeAuthors - prevMonth.activeAuthors) / prevMonth.activeAuthors) * 100)
      : null;

    res.json({
      billingUnit:        'active_pr_authors_per_month',
      currentMonth:       currentMonth.month,
      currentCount:       currentMonth.activeAuthors,
      momChangePercent:   mom,
      excludeBots,
      monthly,
    });
  });

  return router;
}