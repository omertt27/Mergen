/**
 * routes/agent-blunders.ts
 *
 *   GET /agent-blunders           summary + recent events + policy refinement candidates
 *   GET /agent-blunders?limit=N   change page size (max 100)
 *   GET /agent-blunders?agentId=X filter by agent identity
 *   GET /agent-blunders/verify    cryptographic hash-chain audit
 *   GET /agent-blunders/clusters  semantic pattern clustering — repeated threat signals
 *   GET /agent-blunders/evidence-pack  HMAC-signed compliance bundle for a session/time range
 *
 * "Prevented" is the headline number: every time Mergen's safety layer
 * blocked an autonomous action that could have caused harm. YC partner Q:
 * "Why would you trust an AI agent with prod?" Answer: because it blocked
 * itself N times before you had to.
 *
 * "policyRefinementCandidates" are rules that triggered a block and were
 * immediately bypassed (same tool called again within 60s and passed) 5+
 * times — a signal the rule may be too aggressive for this team's workflow.
 *
 * /verify answers: "Has the log been tampered with?" An external auditor
 * calls this endpoint without trusting the server — the hash chain proves
 * integrity of every surviving entry.
 */

import { createHmac } from 'crypto';
import { Router } from 'express';
import { getStores } from '../storage/store-registry.js';
import { getRefinementCandidates, getBypassStats } from '../sensor/bypass-tracker.js';
import { getGateCoverageSummary } from '../intelligence/enterprise-policy-engine.js';
import { buildReport, renderMarkdown } from '../intelligence/case-study-generator.js';
import { loadEnterprisePolicy } from '../intelligence/enterprise-policy-engine.js';
import { computeBlastRadius } from '../intelligence/blast-radius.js';
import type { BlunderEvent } from '../sensor/agent-blunder-store.js';

export function createAgentBlundersRouter(): Router {
  const router = Router();

  router.get('/agent-blunders', async (req, res) => {
    const limit   = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    const store   = getStores().blunders;
    const [stats, all] = await Promise.all([store.getStats(), store.list()]);
    const filtered = agentId ? all.filter((b) => b.agentId === agentId) : all;
    const recent = filtered.slice(-limit).reverse();
    const policyRefinementCandidates = getRefinementCandidates();
    const bypassStats = getBypassStats();
    const gateCovers = getGateCoverageSummary();
    res.json({
      ok: true,
      prevented: stats.total,
      ...stats,
      gateCovers,
      recentBlunders: recent,
      bypassStats,
      policyRefinementCandidates,
    });
  });

  /**
   * GET /agent-blunders/verify
   *
   * Runs a cryptographic hash-chain verification over the blunder log.
   * Safe to call from an external audit script — no authentication required,
   * no state is mutated.
   *
   * Response fields:
   *   valid        — true if every surviving entry is cryptographically intact
   *   truncated    — true if the ring buffer has wrapped (pre-eviction entries
   *                  cannot be verified; this is expected, not a tamper signal)
   *   verified     — count of entries that passed verification
   *   verifiedFrom — id of the oldest entry included in the verified range
   *   firstInvalidIdx / reason — present only when valid: false
   */
  router.get('/agent-blunders/verify', async (_req, res) => {
    const result = await getStores().blunders.verifyChain();
    res.json({ ok: true, ...result });
  });

  /**
   * GET /agent-blunders/clusters
   *
   * Groups blunder entries by semantic pattern (command template + block type)
   * and returns clusters sorted by frequency. Surfaces repeated threat signals:
   * "bash:rm -rf blocked 8× across 4 agents in 3 days" — the difference between
   * a log and an actionable threat signal.
   *
   * Query params:
   *   windowDays=N   — only look at the last N days (default: 30, max: 365)
   *   minCount=N     — only return clusters with at least N occurrences (default: 2)
   */
  router.get('/agent-blunders/clusters', async (req, res) => {
    const windowDays = Math.min(365, Math.max(1, Number(req.query.windowDays ?? 30)));
    const minCount   = Math.min(100, Math.max(1, Number(req.query.minCount ?? 2)));
    const store      = getStores().blunders;
    const all        = await store.list();
    const cutoff     = Date.now() - windowDays * 24 * 60 * 60 * 1_000;
    const recent     = all.filter((b) => b.recordedAt >= cutoff);

    // Cluster by: (blunderType, normalized command template)
    // Template = command with numbers/UUIDs/paths replaced with placeholders
    const clusterMap = new Map<string, {
      key:         string;
      blunderType: string;
      template:    string;
      count:       number;
      agents:      Set<string>;
      services:    Set<string>;
      firstSeen:   number;
      lastSeen:    number;
      examples:    string[];
      triggeredRules: string[];
    }>();

    for (const b of recent) {
      const template = _commandTemplate(b.command ?? b.blockReason);
      const key      = `${b.blunderType}::${template}`;
      let cluster    = clusterMap.get(key);
      if (!cluster) {
        cluster = {
          key,
          blunderType:    b.blunderType,
          template,
          count:          0,
          agents:         new Set(),
          services:       new Set(),
          firstSeen:      b.recordedAt,
          lastSeen:       b.recordedAt,
          examples:       [],
          triggeredRules: [],
        };
        clusterMap.set(key, cluster);
      }
      cluster.count++;
      if (b.agentId) cluster.agents.add(b.agentId);
      if (b.actor)   cluster.agents.add(b.actor);
      if (b.service) cluster.services.add(b.service);
      if (b.recordedAt < cluster.firstSeen) cluster.firstSeen = b.recordedAt;
      if (b.recordedAt > cluster.lastSeen)  cluster.lastSeen  = b.recordedAt;
      if (cluster.examples.length < 3 && b.command) cluster.examples.push(b.command.slice(0, 120));
      for (const r of b.triggeredRules ?? []) {
        if (!cluster.triggeredRules.includes(r)) cluster.triggeredRules.push(r);
      }
    }

    const clusters = [...clusterMap.values()]
      .filter((c) => c.count >= minCount)
      .sort((a, b) => b.count - a.count)
      .map((c) => ({
        key:            c.key,
        blunderType:    c.blunderType,
        template:       c.template,
        count:          c.count,
        uniqueAgents:   c.agents.size,
        uniqueServices: c.services.size,
        firstSeen:      c.firstSeen,
        lastSeen:       c.lastSeen,
        examples:       c.examples,
        triggeredRules: c.triggeredRules,
        threatSignal:   _threatSignal(c.count, c.agents.size, windowDays),
      }));

    res.json({
      ok: true,
      windowDays,
      totalBlunders:    recent.length,
      clustersFound:    clusters.length,
      clusters,
    });
  });

  /**
   * GET /agent-blunders/evidence-pack
   *
   * Returns an HMAC-signed JSON bundle containing the blunder chain, the
   * triggering policy rules, blast-radius scores, and agent identity for
   * every entry in the requested time range. One artifact for compliance
   * reviews and postmortem audits.
   *
   * Query params:
   *   from=<epoch-ms>  — start of range (default: 30 days ago)
   *   to=<epoch-ms>    — end of range (default: now)
   *   agentId=<id>     — filter to a specific agent (optional)
   *   sessionId=<id>   — filter to a specific MCP session (optional)
   *
   * Response includes:
   *   pack.entries[]          — blunder events in range
   *   pack.policySnapshot     — policy rules active at pack generation time
   *   pack.blastRadiusScores  — per-entry blast-radius assessment
   *   pack.generatedAt        — epoch ms when pack was built
   *   signature               — HMAC-SHA256 of pack JSON (key: MERGEN_SECRET)
   */
  router.get('/agent-blunders/evidence-pack', async (req, res) => {
    const now      = Date.now();
    const from     = Number(req.query.from  ?? now - 30 * 24 * 60 * 60 * 1_000);
    const to       = Number(req.query.to    ?? now);
    const agentId  = typeof req.query.agentId   === 'string' ? req.query.agentId   : undefined;
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;

    const store   = getStores().blunders;
    const all     = await store.list();
    let entries: BlunderEvent[] = all.filter((b) => b.recordedAt >= from && b.recordedAt <= to);
    if (agentId)   entries = entries.filter((b) => b.agentId  === agentId);
    if (sessionId) entries = entries.filter((b) => b.sessionId === sessionId);

    const policy = loadEnterprisePolicy();
    const blastRadiusScores = entries.map((b) => ({
      id:          b.id,
      blastRadius: b.command ? computeBlastRadius(b.command) : null,
    }));

    const chainVerification = await store.verifyChain();

    const pack = {
      generatedAt:       now,
      rangeFrom:         from,
      rangeTo:           to,
      filters:           { agentId: agentId ?? null, sessionId: sessionId ?? null },
      entryCount:        entries.length,
      entries,
      policySnapshot:    policy,
      blastRadiusScores,
      chainVerification,
    };

    const packJson  = JSON.stringify(pack);
    const hmacKey   = process.env.MERGEN_SECRET ?? 'mergen-evidence-pack';
    const signature = createHmac('sha256', hmacKey).update(packJson).digest('hex');

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mergen-evidence-pack-${now}.json"`);
    res.json({ ok: true, pack, signature });
  });

  /**
   * GET /agent-blunders/case-study-export
   *
   * Returns anonymized, narrative-enriched case studies derived from the
   * blunder log. Suitable for customer-facing documentation and sales material.
   *
   * Query params:
   *   format=json (default) — structured JSON with caseId, narrative, etc.
   *   format=md             — Markdown document ready to paste into docs/website
   *   limit=N               — cap the number of unique case studies returned (default: 20)
   *
   * Anonymization applied:
   *   - Service names replaced with opaque svc-{hash} identifiers
   *   - PIDs replaced with sequential case-001, case-002, ...
   *   - Timestamps converted to relative ("3 days ago")
   *   - Deep file paths truncated at depth 2
   *   - Commands containing credentials fully redacted
   *
   * Deduplication: repeated identical block patterns appear as a single case.
   */
  router.get('/agent-blunders/case-study-export', async (req, res) => {
    const format = req.query.format === 'md' ? 'md' : 'json';
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));

    const blunders = await getStores().blunders.list();
    const report   = buildReport(blunders);
    report.cases   = report.cases.slice(0, limit);

    if (format === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="mergen-case-studies.md"');
      res.send(renderMarkdown(report));
      return;
    }

    res.json({ ok: true, ...report });
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Replace volatile parts of a command with placeholders to produce a stable
 * template for clustering: UUIDs, hex strings, file paths, port numbers,
 * numeric IDs, and IP addresses become generic tokens.
 */
function _commandTemplate(raw: string): string {
  return raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{32,64}\b/gi, '<hash>')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<ip>')
    .replace(/:\d{2,5}\b/g, ':<port>')
    .replace(/\/[^\s"']{5,}/g, '/<path>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
    .trim();
}

/** Return a threat-signal level based on frequency and agent spread. */
function _threatSignal(count: number, uniqueAgents: number, windowDays: number): 'low' | 'medium' | 'high' | 'critical' {
  const dailyRate = count / windowDays;
  if (dailyRate >= 5 || uniqueAgents >= 4) return 'critical';
  if (dailyRate >= 2 || uniqueAgents >= 2) return 'high';
  if (count >= 3) return 'medium';
  return 'low';
}
