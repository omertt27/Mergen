/**
 * service-graph.ts — Live service dependency graph inferred from OTLP spans.
 *
 * Every CLIENT span that arrives via POST /v1/traces carries:
 *   - The caller's service.name (from the resource attributes)
 *   - The callee's address (peer.service, net.peer.name, or http.url host)
 *
 * We maintain a weighted directed graph:
 *   caller → callee → { callCount, errorCount, lastSeenAt }
 *
 * This graph becomes a structural prior for hypothesis generation:
 * if service B is erroring AND service A → B is an observed edge, surface
 * a cascading-failure hypothesis for A with boosted confidence.
 *
 * The graph is in-memory (rebuilt from the OTLP stream per server run).
 * It is also exposed via GET /service-graph for dashboards and MCP tools.
 */

interface EdgeStats {
  callCount:  number;
  errorCount: number;
  lastSeenAt: number;
}

interface ServiceNode {
  /** Outbound edges: callee → stats */
  calls: Map<string, EdgeStats>;
  /** Inbound edges: caller services that call this service */
  calledBy: Set<string>;
}

class ServiceGraph {
  private _nodes = new Map<string, ServiceNode>();
  private _lastUpdated = 0;

  private _node(service: string): ServiceNode {
    if (!this._nodes.has(service)) {
      this._nodes.set(service, { calls: new Map(), calledBy: new Set() });
    }
    return this._nodes.get(service)!;
  }

  /** Record an observed call from `caller` to `callee`. */
  recordCall(caller: string, callee: string, isError: boolean): void {
    if (!caller || !callee || caller === callee) return;
    const node = this._node(caller);
    const callerCallee = node.calls.get(callee);
    if (callerCallee) {
      callerCallee.callCount++;
      if (isError) callerCallee.errorCount++;
      callerCallee.lastSeenAt = Date.now();
    } else {
      node.calls.set(callee, {
        callCount: 1,
        errorCount: isError ? 1 : 0,
        lastSeenAt: Date.now(),
      });
    }
    this._node(callee).calledBy.add(caller);
    this._lastUpdated = Date.now();
  }

  /** Returns all services that directly depend on (call) `service`. */
  getCallers(service: string): string[] {
    return [...(this._nodes.get(service)?.calledBy ?? [])];
  }

  /** Returns all services that `service` calls. */
  getCallees(service: string): string[] {
    return [...(this._nodes.get(service)?.calls.keys() ?? [])];
  }

  /** Returns all services that transitively depend on `service` (BFS, depth ≤ 3). */
  getUpstreamImpact(service: string, maxDepth = 3): string[] {
    const visited = new Set<string>();
    const queue: Array<{ s: string; depth: number }> = [{ s: service, depth: 0 }];
    while (queue.length > 0) {
      const { s, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      for (const caller of this.getCallers(s)) {
        if (!visited.has(caller)) {
          visited.add(caller);
          queue.push({ s: caller, depth: depth + 1 });
        }
      }
    }
    return [...visited];
  }

  /**
   * Risk multiplier for hypothesis execution:
   * if a failing service has many upstream dependents, fixes are higher risk.
   *   0–2 callers  → 'low'
   *   3–5 callers  → 'medium'
   *   6+ callers   → 'high'
   */
  getBlastRisk(service: string): 'low' | 'medium' | 'high' {
    const impacted = this.getUpstreamImpact(service).length;
    if (impacted >= 6) return 'high';
    if (impacted >= 3) return 'medium';
    return 'low';
  }

  /** Serialise for the /service-graph endpoint. */
  toJSON(): object {
    const edges: Array<{
      source: string; target: string;
      callCount: number; errorCount: number; lastSeenAt: number;
    }> = [];
    for (const [source, node] of this._nodes) {
      for (const [target, stats] of node.calls) {
        edges.push({ source, target, ...stats });
      }
    }
    return {
      services: [...this._nodes.keys()],
      edges,
      lastUpdated: this._lastUpdated,
    };
  }

  get size(): number { return this._nodes.size; }
}

export const serviceGraph = new ServiceGraph();

/** Extract a callee service name from a CLIENT span's attributes. */
export function extractCalleeService(
  attrs: Record<string, string>,
  spanName: string,
): string {
  // Explicit peer annotation — most reliable
  if (attrs['peer.service']) return attrs['peer.service'];
  // Net peer name (hostname / k8s service DNS)
  if (attrs['net.peer.name']) return attrs['net.peer.name'].split(':')[0];
  // HTTP URL — extract host
  const url = attrs['http.url'] ?? attrs['url.full'] ?? attrs['http.target'] ?? '';
  if (url) {
    try {
      const host = new URL(url.startsWith('http') ? url : `http://${url}`).hostname;
      // Strip port, strip known infra suffixes (.svc.cluster.local, .internal)
      return host.replace(/\.(svc\.cluster\.local|internal|local)$/, '').split('.')[0];
    } catch {}
  }
  // DB systems — use system name as the callee
  if (attrs['db.system']) return attrs['db.system'];
  // Fall back to the span name if it looks like a service
  if (spanName && !/^(GET|POST|PUT|DELETE|PATCH)\s/.test(spanName)) return spanName;
  return '';
}
