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
import { getRulesForTag, hasRecentOverride, getOverrideSummary } from '../intelligence/override-corpus.js';
import type { CompactedRule } from '../intelligence/override-corpus.js';
import { analyzeSemanticRisk } from '../intelligence/action-risk.js';
import { postmortemStore } from '../intelligence/postmortem-store.js';
import logger from '../sensor/logger.js';

export function createCIGateRouter(): Router {
  const router = Router();

  // POST /ci/gate
  router.post('/ci/gate', (req, res) => {
    const body = req.body as {
      files?: string[];
      prTitle?: string;
      diff?: string;
      service?: string;
      actor?: string;
    };

    const files: string[] = Array.isArray(body.files) ? body.files : [];
    const prTitle: string = typeof body.prTitle === 'string' ? body.prTitle.slice(0, 300) : '';
    const diff: string = typeof body.diff === 'string' ? body.diff.slice(0, 20_000) : '';
    const actor: string = typeof body.actor === 'string' ? body.actor.slice(0, 100) : 'unknown';

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
      const rules = getRulesForTag(tag, service);
      for (const rule of rules) {
        matchedRules.push(rule);
        const timeMatch = hasRecentOverride(tag, service, dayOfWeek, hourOfDay);
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
        reasons.push(`Semantic risk HIGH: ${semantic.reason ?? 'destructive operation detected in diff'}`);
      } else if (semantic.risk === 'medium' && verdict === 'pass') {
        verdict = 'warn';
        reasons.push(`Semantic risk MEDIUM: ${semantic.reason ?? 'elevated-risk operation in diff'}`);
      }
    }

    // 5. PR title keyword check against corpus tags
    if (prTitle) {
      const titleLower = prTitle.toLowerCase();
      const summary = getOverrideSummary();
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
        : 'No corpus conflicts found. Safe to merge based on operational memory.';

    logger.info({ verdict, riskScore, tags: inferredTags, service, actor, files: files.length }, 'ci-gate: evaluated PR');

    res.json({
      ok: true,
      verdict,
      riskScore,
      reasons,
      recommendation,
      corpusMatches: matchedRules,
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
    for (const { tag } of tagStats.data.slice(0, 20)) {
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
