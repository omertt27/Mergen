/**
 * hypothesis-history.ts — In-memory ring of recent causal-engine results.
 *
 * Powers two features that share the same data path:
 *
 *   B2 — Sidebar Context Pack card. Auto-runs `buildCausalChain()` whenever
 *        a new error event arrives, caches the result, and exposes it via
 *        `/last-pack` so the VS Code panel can render it. *No credit cost* —
 *        the gate is on `analyze_runtime` (the MCP tool), not on internal
 *        builds. This makes the Hypothesis Engine visible to free users.
 *
 *   C1 — Hypothesis history view. Same store, but exposed as a list so the
 *        panel can show "last N diagnoses" with timestamps and confidence.
 *
 * Design contract:
 *   • Bounded ring (HISTORY_SIZE = 20) — never grows unbounded.
 *   • Debounced rebuild (2 s) — if 50 errors arrive in a burst we compute
 *     the pack ONCE, not 50 times. This is critical for performance.
 *   • Best-effort: failures in causal building are logged and swallowed —
 *     the host MUST NEVER block ingest on this.
 *   • Pure read API — never mutates the buffer.
 */

import type { CausalChain, Hypothesis } from './causal.js';
import { buildCausalChain } from './causal.js';
import { store } from './buffer.js';
import { recordAnalysis } from './usage.js';
import logger from './logger.js';

const HISTORY_SIZE = 20;
const REBUILD_DEBOUNCE_MS = 2_000;

/**
 * Why a rebuild was triggered. Lets the panel show *why* a Context Pack
 * appeared even when nothing crashed — the core "continuous diagnostic"
 * loop. `error` is the legacy trigger; everything else is new.
 */
export type RebuildReason =
  | 'error'        // a console.error landed
  | 'pageload'     // the tab finished loading — analyze baseline health
  | 'net_burst'    // ≥ 3 failed requests in 10s
  | 'slow_burst'   // ≥ 3 slow requests (> 500 ms) in 10s
  | 'hmr'          // dev server hot-reload — analyze post-save state
  | 'periodic'     // background watcher tick
  | 'manual';      // explicit /diagnose or panel "Refresh"

export interface HistoryEntry {
  /** Wall-clock when the pack was built (ms since epoch). */
  builtAt: number;
  /** ISO string for display. */
  builtAtIso: string;
  /** First error message that triggered the build, for list display. */
  triggerMessage: string;
  /** Why this entry was built — drives panel iconography. */
  reason: RebuildReason;
  /** The top-ranked hypothesis (if any), denormalised for list rendering. */
  topHypothesis: Hypothesis | null;
  /** Full causal chain — heavy, only fetched by /last-pack. */
  chain: CausalChain;
}

class HypothesisHistory {
  private _ring: HistoryEntry[] = [];
  private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private _building = false;
  /** Reason for the in-flight rebuild, captured when notify*() is called. */
  private _pendingReason: RebuildReason | null = null;

  /** Return the most-recent N entries in newest-first order (without `chain`). */
  list(limit = HISTORY_SIZE): Array<Omit<HistoryEntry, 'chain'>> {
    return this._ring
      .slice(-limit)
      .reverse()
      .map(({ chain: _chain, ...rest }) => rest);
  }

  /** Return the most-recent full entry, or null if the buffer hasn't seen any errors yet. */
  latest(): HistoryEntry | null {
    return this._ring.length > 0 ? this._ring[this._ring.length - 1] : null;
  }

  size(): number {
    return this._ring.length;
  }

  clear(): void {
    this._ring = [];
    if (this._rebuildTimer) {
      clearTimeout(this._rebuildTimer);
      this._rebuildTimer = null;
    }
    this._pendingReason = null;
  }

  /**
   * Notify that a new error event was just ingested. Debounced — we collapse
   * bursts of errors into a single pack build to keep the event loop healthy.
   */
  notifyError(): void {
    this._scheduleRebuild('error');
  }

  /**
   * Notify of *any* meaningful activity worth a baseline diagnosis.
   * This is the core of the continuous-diagnostic loop: page loaded, network
   * burst, slow-API burst, HMR after save, periodic background tick.
   *
   * Same debounce window as notifyError, so a pageload + immediate error
   * collapse to one rebuild — and we keep the *highest-priority* reason.
   */
  notifyActivity(reason: RebuildReason): void {
    this._scheduleRebuild(reason);
  }

  private _scheduleRebuild(reason: RebuildReason): void {
    // Reason priority: error > net_burst > slow_burst > pageload > hmr > periodic > manual.
    // Higher-priority reasons override an in-flight pending reason so the panel
    // shows the most-actionable label.
    const PRIORITY: Record<RebuildReason, number> = {
      error: 6, net_burst: 5, slow_burst: 4, pageload: 3, hmr: 2, periodic: 1, manual: 0,
    };
    if (
      this._pendingReason === null ||
      PRIORITY[reason] > PRIORITY[this._pendingReason]
    ) {
      this._pendingReason = reason;
    }
    if (this._rebuildTimer) return;
    this._rebuildTimer = setTimeout(() => {
      const triggeredBy = this._pendingReason ?? 'manual';
      this._pendingReason = null;
      this._rebuildTimer = null;
      this._rebuild(triggeredBy).catch((err) =>
        logger.warn({ err }, 'hypothesis-history rebuild failed'),
      );
    }, REBUILD_DEBOUNCE_MS);
  }

  private async _rebuild(reason: RebuildReason): Promise<void> {
    if (this._building) return;
    this._building = true;
    try {
      const logs     = store.getLogs(200);
      const network  = store.getNetwork(200);
      const contexts = store.getContext(20);

      const errors = logs.filter((e) => e.level === 'error');

      // Continuous-diagnostic shift: we no longer require an error to build.
      // For non-error reasons (pageload, periodic, hmr, *_burst), build a
      // *baseline* pack as long as there is *some* meaningful activity to
      // analyse. This is what turns Mergen from a fire alarm into a watcher.
      const hasMeaningfulActivity =
        errors.length > 0 ||
        logs.some((l) => l.level === 'warn') ||
        network.length > 0;
      if (!hasMeaningfulActivity) return;

      const chain = await buildCausalChain(logs, network, contexts);
      const triggerMessage = chain.errors[0]?.message
        ?? this._baselineTriggerMessage(reason, chain);
      const builtAt = Date.now();

      const entry: HistoryEntry = {
        builtAt,
        builtAtIso: new Date(builtAt).toISOString(),
        triggerMessage,
        reason,
        topHypothesis: chain.hypotheses[0] ?? null,
        chain,
      };

      // De-dupe: if the most-recent entry has the same trigger AND top-tag,
      // replace it instead of appending. This prevents "last 20 entries are
      // all the same crash" spam during reload loops, AND prevents periodic
      // background ticks from flooding the history with identical baselines.
      const last = this._ring[this._ring.length - 1];
      if (
        last &&
        last.triggerMessage === entry.triggerMessage &&
        last.topHypothesis?.tag === entry.topHypothesis?.tag
      ) {
        this._ring[this._ring.length - 1] = entry;
      } else {
        this._ring.push(entry);
        if (this._ring.length > HISTORY_SIZE) this._ring.shift();
      }
      // North-Star metric: count every successful auto-rebuild as one
      // "analysis" for today. This is what we report on /usage.
      try { recordAnalysis(); } catch (err) { logger.warn({ err }, 'recordAnalysis failed'); }
    } finally {
      this._building = false;
    }
  }

  /**
   * Human-readable trigger string for non-error baselines.
   * Used in the panel's history list so a "no errors, just watching" entry
   * still tells you *why* it was built and what's notable about it.
   */
  private _baselineTriggerMessage(reason: RebuildReason, chain: CausalChain): string {
    const top = chain.hypotheses[0];
    if (top) return `${this._reasonLabel(reason)}: ${top.summary}`;
    return `${this._reasonLabel(reason)}: baseline check — no anomalies found`;
  }

  private _reasonLabel(reason: RebuildReason): string {
    switch (reason) {
      case 'pageload':   return 'Page loaded';
      case 'net_burst':  return 'Network burst';
      case 'slow_burst': return 'Slow-API burst';
      case 'hmr':        return 'After save (HMR)';
      case 'periodic':   return 'Background watch';
      case 'manual':     return 'Manual diagnose';
      case 'error':      return 'Error';
    }
  }

  /** Test hook: force a rebuild synchronously and ignore debounce. */
  async _rebuildNowForTesting(reason: RebuildReason = 'error'): Promise<void> {
    if (this._rebuildTimer) {
      clearTimeout(this._rebuildTimer);
      this._rebuildTimer = null;
    }
    this._pendingReason = null;
    await this._rebuild(reason);
  }
}

export const hypothesisHistory = new HypothesisHistory();
