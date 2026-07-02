/**
 * routes/ci-gate.ts — CI/CD Corpus Gate for AI-generated PRs.
 *
 * POST /ci/gate
 *   Checks a set of changed files and PR title against the Override Corpus
 *   and semantic risk classifier. Returns a verdict (pass/warn/block) with
 *   reasons — intended to be consumed by a GitHub Action that blocks or warns
 *   on PRs that touch areas the team has historically overridden.
 *
 * This is the Phase 3 deliverable from the investment memo: the CI gate that
 * intercepts AI-generated changes before they reach production and validates
 * them against your team's operational knowledge.
 */
import { Router } from 'express';
import type { CompactedRule } from '../intelligence/override-corpus.js';
import { getStores } from '../storage/store-registry.js';
import { analyzeSemanticRisk } from '../intelligence/action-risk.js';
import { postmortemStore } from '../intelligence/postmortem-store.js';
import { evaluateEnterprisePolicy, isAiActor } from '../intelligence/enterprise-policy-engine.js';
import { evaluateDiffSize } from '../intelligence/diff-size.js';
import logger from '../sensor/logger.js';

export function createCIGateRouter(): Router {
  const router = Router();

  // POST /ci/gate
  router.post('/ci/gate', async (req, res) => {
    const body = req.body as {
      files?: string[];
      prTitle?: string;
      diff?: string;
      service?: string;
      actor?: string;
      diffStats?: { filesChanged?: number; additions?: number; deletions?: number };
    };

    const files: string[] = Array.isArray(body.files) ? body.files : [];
    const prTitle: string = typeof body.prTitle === 'string' ? body.prTitle.slice(0, 300) : '';
    const diff: string = typeof body.diff === 'string' ? body.diff.slice(0, 20_000) : '';
    const actor: string = typeof body.actor === 'string' ? body.actor.slice(0, 100) : 'unknown';
    const diffStats = body.diffStats && typeof body.diffStats === 'object'
      ? {
          filesChanged: Number(body.diffStats.filesChanged) || 0,
          additions:    Number(body.diffStats.additions)    || 0,
          deletions:    Number(body.diffStats.deletions)    || 0,
        }
      : null;

    // 1. Infer service from files or explicit param
    const service = inferService(body.service, files);

    // 2. Infer incident tags from postmortem history for these files
    //    and from the PR title keywords
    const inferredTags = inferTagsFromContext(files, prTitle);

    // 3. Corpus check: look up override rules for each tag
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const hourOfDay = now.getUTCHours();

    const matchedRules: CompactedRule[] = [];
    const reasons: string[] = [];
    let verdict: 'pass' | 'warn' | 'block' = 'pass';

    for (const tag of inferredTags) {
      const rules = await getStores().overrides.getRulesForTag(tag, service, req.tenantId);
      for (const rule of rules) {
        matchedRules.push(rule);
        const timeMatch = await getStores().overrides.hasRecentOverride(tag, service, dayOfWeek, hourOfDay, req.tenantId);
        const dayName = rule.dayOfWeek != null
          ? ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][rule.dayOfWeek]
          : null;
        const hourDesc = rule.hourWindow
          ? `${rule.hourWindow[0]}:00–${rule.hourWindow[1]}:00 UTC`
          : null;

        if (rule.occurrences >= 3 && timeMatch) {
          verdict = 'block';
          reasons.push(
            `Corpus block: \`${tag}\` has been overridden ${rule.occurrences}× ` +
            `(reason: ${rule.overrideReason})` +
            (dayName ? ` — typically on ${dayName}` : '') +
            (hourDesc ? ` ${hourDesc}` : '') +
            '. This matches your current time window.',
          );
        } else if (rule.occurrences >= 1) {
          if (verdict === 'pass') verdict = 'warn';
          reasons.push(
            `Corpus warning: \`${tag}\` has been overridden ${rule.occurrences}× ` +
            `(reason: ${rule.overrideReason})` +
            (dayName ? ` — pattern clusters on ${dayName}` : '') +
            '.',
          );
        }
      }
    }

    // 4. Semantic risk check on the diff (if provided)
    if (diff) {
      const semantic = analyzeSemanticRisk(diff);
      if (semantic.risk === 'high') {
        verdict = 'block';
        reasons.push(semantic.reason ?? 'Blocked: destructive operation detected in diff. Review and replace with a reversible alternative before merging.');
      } else if (semantic.risk === 'medium' && verdict === 'pass') {
        verdict = 'warn';
        reasons.push(`Semantic risk MEDIUM: ${semantic.reason ?? 'elevated-risk operation in diff'}`);
      }
    }

    // 4.5. Enterprise Custom Policy Engine evaluation
    const enterpriseResult = evaluateEnterprisePolicy({
      files,
      actor,
      service,
      timestamp: Date.now(),
    });
    if (enterpriseResult.triggeredRules.length > 0) {
      if (enterpriseResult.verdict === 'block') {
        verdict = 'block';
      } else if (enterpriseResult.verdict === 'warn' && verdict !== 'block') {
        verdict = 'warn';
      }
      reasons.push(...enterpriseResult.reasons);
    }

    // 4.75. Diff explosion / diff-size check — only runs when the caller
    // supplies aggregate stats (action.yml computes these from listFiles());
    // absent for callers that only send a truncated diff string.
    let diffSizeReport: ReturnType<typeof evaluateDiffSize> | null = null;
    if (diffStats) {
      diffSizeReport = evaluateDiffSize(diffStats, { actorIsAi: isAiActor(actor) });
      if (diffSizeReport.requiresApproval) {
        if (verdict !== 'block') verdict = 'warn'; // flag, don't hard-block on size alone — see recommendation text
        reasons.push(`Diff size HIGH (${diffSizeReport.score}/100): ${diffSizeReport.recommendation}`);
      } else if (diffSizeReport.level === 'MEDIUM' && verdict === 'pass') {
        verdict = 'warn';
        reasons.push(`Diff size MEDIUM (${diffSizeReport.score}/100): ${diffSizeReport.recommendation}`);
      }
    }

    // 5. PR title keyword check against corpus tags
    if (prTitle) {
      const titleLower = prTitle.toLowerCase();
      const summary = await getStores().overrides.getOverrideSummary(req.tenantId);
      for (const entry of summary) {
        if (titleLower.includes(entry.tag.replace(/_/g, ' ')) || titleLower.includes(entry.tag.replace(/_/g, '-'))) {
          if (verdict === 'pass') verdict = 'warn';
          if (!reasons.some((r) => r.includes(entry.tag))) {
            reasons.push(`PR title matches known override pattern: \`${entry.tag}\` (${entry.total} historical overrides)`);
          }
        }
      }
    }

    // 6. Risk score 0–100
    const riskScore = computeRiskScore(verdict, matchedRules);

    const recommendation =
      verdict === 'block'
        ? 'Review the override corpus before merging. This change touches areas your team has explicitly blocked in the past.'
        : verdict === 'warn'
        ? 'Proceed with caution — this change touches areas with a history of operational overrides.'
        : 'No corpus conflicts found. Safe to merge based on execution history.';

    logger.info({ verdict, riskScore, tags: inferredTags, service, actor, files: files.length }, 'ci-gate: evaluated PR');

    // Diff-to-decision linking: map specific diff lines to the policy rules that triggered.
    // This lets the PR author see exactly which line caused the block, not just the verdict.
    const lineHits = diff ? _linkDiffToDecisions(diff, matchedRules, reasons) : [];

    res.json({
      ok: true,
      verdict,
      riskScore,
      reasons,
      recommendation,
      corpusMatches: matchedRules,
      lineHits,
      diffSize: diffSizeReport,
      meta: { service, inferredTags, filesChecked: files.length, actor },
    });
  });

  return router;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function inferService(explicit: string | undefined, files: string[]): string {
  if (explicit && explicit.trim()) return explicit.trim();
  // Infer from common monorepo directory patterns: apps/api/..., services/worker/...
  for (const file of files) {
    const match = file.match(/^(?:apps|services|packages|src)\/([^/]+)\//);
    if (match) return match[1]!;
  }
  return 'unknown';
}

function inferTagsFromContext(files: string[], prTitle: string): string[] {
  const tags = new Set<string>();

  // Database-related files → db pool / query tags
  const dbFiles = files.some((f) => /db|database|migration|pool|sequelize|prisma|knex|typeorm/i.test(f));
  if (dbFiles) { tags.add('infra_db_connection_pool'); tags.add('n_plus_one_query'); }

  // Auth files → auth tags
  if (files.some((f) => /auth|jwt|session|token|oauth|passport/i.test(f))) {
    tags.add('auth_token_not_persisted');
  }

  // Memory/cache files → OOM / cache tags
  if (files.some((f) => /cache|redis|memcache|memory|heap/i.test(f))) {
    tags.add('oom_kill');
  }

  // Rate limiting files
  if (files.some((f) => /rate.?limit|throttl/i.test(f))) {
    tags.add('rate_limit_cascade');
  }

  // CI/deploy config files → deployment tags
  if (files.some((f) => /deploy|dockerfile|k8s|helm|\.yml|\.yaml|\.tf/i.test(f))) {
    tags.add('deploy_config_drift');
  }

  // Title keyword extraction
  const titleLower = prTitle.toLowerCase();
  if (/pool|connection/.test(titleLower)) tags.add('infra_db_connection_pool');
  if (/auth|token|session/.test(titleLower)) tags.add('auth_token_not_persisted');
  if (/memory|oom|heap/.test(titleLower)) tags.add('oom_kill');
  if (/rate.?limit|throttl/.test(titleLower)) tags.add('rate_limit_cascade');
  if (/deploy|rollout|release/.test(titleLower)) tags.add('deploy_config_drift');

  // Also pull any tags from postmortem corpus that mention these file paths
  try {
    const tagStats = postmortemStore.tagStats();
    for (const { tag } of tagStats.slice(0, 20)) {
      // If a tag name appears as a substring of any changed file, include it
      const tagSlug = tag.replace(/^infra_/, '').replace(/_/g, '');
      if (files.some((f) => f.toLowerCase().replace(/[^a-z]/g, '').includes(tagSlug))) {
        tags.add(tag);
      }
    }
  } catch { /* postmortemStore may not be initialized in tests */ }

  return [...tags];
}

function computeRiskScore(verdict: 'pass' | 'warn' | 'block', rules: CompactedRule[]): number {
  if (verdict === 'block') return Math.min(100, 70 + rules.length * 5);
  if (verdict === 'warn')  return Math.min(69, 30 + rules.length * 10);
  return Math.max(0, 10 - rules.length * 2);
}

/**
 * Diff-to-decision linking: scan the diff line by line and find lines that
 * contain patterns from triggered corpus rules or semantic risk keywords.
 * Returns an array of { lineNumber, lineContent, reason } hits so the PR
 * author can see exactly which line caused the block.
 */
function _linkDiffToDecisions(
  diff: string,
  matchedRules: CompactedRule[],
  reasons: string[],
): Array<{ lineNumber: number; lineContent: string; matchedPattern: string; reason: string }> {
  const lines  = diff.split('\n');
  const hits: Array<{ lineNumber: number; lineContent: string; matchedPattern: string; reason: string }> = [];

  // Extract keywords from triggered rule tags and reasons
  const patterns: Array<{ pattern: RegExp; reason: string }> = [];

  for (const rule of matchedRules) {
    const tag = rule.incidentTag ?? '';
    const slug = tag.replace(/_/g, '[-_\\s]').replace(/\//g, '\\/');
    if (slug) patterns.push({ pattern: new RegExp(slug, 'i'), reason: `Corpus rule: ${tag} (${rule.overrideReason})` });
  }

  // Semantic risk patterns from the reason strings
  const semanticKeywords = [
    { re: /DROP\s+TABLE|TRUNCATE|DELETE\s+FROM(?!\s+\w+\s+WHERE)/i, reason: 'Destructive SQL operation' },
    { re: /terraform\s+destroy|aws\s+s3\s+rm/i, reason: 'Destructive infrastructure command' },
    { re: /rm\s+-rf/i, reason: 'Destructive filesystem command' },
    { re: /ALTER\s+TABLE/i, reason: 'Schema mutation' },
    { re: /process\.env\.\w*(SECRET|KEY|TOKEN|PASS|PWD)/i, reason: 'Potential secret exposure' },
    { re: /kubectl\s+delete\s+namespace/i, reason: 'Cluster-scope kubectl delete' },
  ];
  for (const kw of semanticKeywords) {
    patterns.push({ pattern: kw.re, reason: kw.reason });
  }

  let lineNumber = 0;
  for (const line of lines) {
    lineNumber++;
    // Only check added lines in the diff (lines starting with '+', not '+++')
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const content = line.slice(1); // strip leading '+'
    for (const { pattern, reason } of patterns) {
      if (pattern.test(content)) {
        // Avoid duplicates for the same line
        if (!hits.some((h) => h.lineNumber === lineNumber)) {
          hits.push({
            lineNumber,
            lineContent: content.slice(0, 200).trim(),
            matchedPattern: pattern.source.slice(0, 80),
            reason,
          });
        }
        break;
      }
    }
    if (hits.length >= 20) break; // cap to avoid huge responses
  }

  return hits;
}
