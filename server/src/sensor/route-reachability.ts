/**
 * route-reachability.ts — Live route registry built from OTLP SERVER spans.
 *
 * The core problem: a static analysis tool (or LLM) can flag a vulnerability
 * in a function that is unreachable in production — dead code, feature-flagged
 * routes, or paths removed from the router but not from the source tree.
 *
 * This module maintains the set of HTTP routes that have actually been called
 * in the current server run (populated from OTLP SERVER spans via the OTLP
 * receiver). When a hypothesis references a specific endpoint, the topology
 * filter in incident-autopilot.ts can penalise it if that route has never
 * appeared in live traces — reducing hallucinated vulnerability escalations.
 *
 * Route normalisation: dynamic path segments are replaced with :param so that
 *   /api/users/123  and  /api/users/456  map to the same canonical route
 *   /api/users/:param.
 *
 * The registry is in-memory (rebuilt per server run). Routes decay after
 * STALE_AFTER_MS of no observations so removed routes eventually drop out.
 */

const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

interface RouteEntry {
  callCount: number;
  lastSeenAt: number;
  errorCount: number;
}

class RouteReachabilityRegistry {
  private _routes = new Map<string, RouteEntry>();

  /** Normalise a raw path by replacing UUIDs, numeric IDs, and hash-like segments. */
  normalise(rawPath: string): string {
    try {
      const parsed = new URL(rawPath.startsWith('http') ? rawPath : `http://x${rawPath}`);
      rawPath = parsed.pathname;
    } catch {}
    return rawPath
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
      .replace(/\/\d{4,}/g, '/:id')
      .replace(/\/[a-f0-9]{24,}/gi, '/:hash')
      .replace(/\/\d+/g, '/:id');
  }

  /** Record an observed route from a SERVER span. */
  record(rawPath: string, isError: boolean): void {
    const canonical = this.normalise(rawPath);
    const existing = this._routes.get(canonical);
    if (existing) {
      existing.callCount++;
      existing.lastSeenAt = Date.now();
      if (isError) existing.errorCount++;
    } else {
      this._routes.set(canonical, {
        callCount: 1,
        lastSeenAt: Date.now(),
        errorCount: isError ? 1 : 0,
      });
    }
  }

  /**
   * Returns true if the given path (or a prefix of it) has been observed in
   * live OTLP traces within the staleness window.
   *
   * Matching is intentionally loose: a hypothesis mentioning "/api/auth" will
   * match any recorded route that starts with "/api/auth".
   */
  isReachable(path: string): boolean {
    if (this._routes.size === 0) return true; // no data → don't penalise
    const cutoff = Date.now() - STALE_AFTER_MS;
    const canonical = this.normalise(path);
    for (const [route, entry] of this._routes) {
      if (entry.lastSeenAt < cutoff) continue;
      if (route.startsWith(canonical) || canonical.startsWith(route)) return true;
    }
    return false;
  }

  /** All non-stale routes with their stats, for the /route-reachability endpoint. */
  toJSON(): object {
    const cutoff = Date.now() - STALE_AFTER_MS;
    const routes: Array<{
      route: string;
      callCount: number;
      errorCount: number;
      lastSeenAt: number;
    }> = [];
    for (const [route, entry] of this._routes) {
      if (entry.lastSeenAt < cutoff) continue;
      routes.push({ route, ...entry });
    }
    routes.sort((a, b) => b.callCount - a.callCount);
    return { totalRoutes: routes.length, routes };
  }

  get size(): number {
    return this._routes.size;
  }
}

export const routeReachability = new RouteReachabilityRegistry();