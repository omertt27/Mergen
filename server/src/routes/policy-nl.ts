/**
 * routes/policy-nl.ts — Natural language policy authoring.
 *
 *   POST /policies/from-description   Parse plain English → draft policy rule
 *
 * Converts sentences like:
 *   "Block anything touching the payments database after 5pm on Fridays"
 *   "Warn when Claude tries to run terraform in production"
 *   "Block all schema migrations in prod for AI agents"
 *
 * Returns a draft rule for the caller to review and save via POST /policies/rules.
 * No LLM in the path — deterministic regex heuristics only, so the gate logic
 * itself remains provably deterministic.
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

export function createPolicyNlRouter(): Router {
  const router = Router();

  router.post('/policies/from-description', (req, res) => {
    const body = z.object({ description: z.string().min(5).max(500) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'description (string, 5-500 chars) required' });
      return;
    }

    const result = parseNaturalLanguagePolicy(body.data.description);
    res.json({ ok: true, ...result });
  });

  return router;
}

// ── Parser ────────────────────────────────────────────────────────────────────

interface ParsedRule {
  rule: {
    id: string;
    name: string;
    description: string;
    action: 'block' | 'warn' | 'pass';
    reason: string;
    conditions: {
      commands?: string[];
      files?: string[];
      actorType?: 'ai' | 'human' | 'all';
      daysOfWeek?: number[];
      hourWindow?: [number, number];
      environments?: string[];
      repos?: string[];
      agentIds?: string[];
    };
  };
  confidence: number;
  notes: string[];
}

const DESTRUCTIVE_KEYWORDS = [
  'terraform destroy', 'kubectl delete', 'rm -rf', 'drop table', 'drop database',
  'truncate', 'delete all', 'wipe', 'nuke', 'format',
];

const SCHEMA_KEYWORDS = [
  'migration', 'schema', 'alter table', 'add column', 'drop column',
  'prisma migrate', 'db:migrate',
];

const KEYWORD_DOMAINS: Array<{ patterns: string[]; commands: string[]; files?: string[] }> = [
  { patterns: ['terraform', 'infra', 'infrastructure'], commands: ['terraform destroy', 'terraform apply'], files: ['.tf'] },
  { patterns: ['database', 'db', 'postgres', 'mysql', 'sql'], commands: ['drop table', 'drop database', 'truncate table'], files: ['migration', 'schema.sql'] },
  { patterns: ['schema', 'migration', 'migrate'], commands: ['alter table', 'db:migrate', 'prisma migrate', 'knex migrate'], files: ['migration'] },
  { patterns: ['kubernetes', 'k8s', 'cluster', 'kubectl'], commands: ['kubectl delete', 'kubectl drain'], files: [] },
  { patterns: ['auth', 'authentication', 'login', 'jwt', 'token'], commands: [], files: ['auth', 'login', 'jwt', 'middleware'] },
  { patterns: ['payment', 'billing', 'stripe', 'checkout'], commands: [], files: ['payment', 'billing', 'stripe', 'checkout'] },
  { patterns: ['production', 'prod'], commands: [], files: [] },
];

const DAY_MAP: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function parseNaturalLanguagePolicy(description: string): ParsedRule {
  const lower = description.toLowerCase();
  const notes: string[] = [];
  const conditions: ParsedRule['rule']['conditions'] = {};
  let confidence = 0.5;

  // ── Action ────────────────────────────────────────────────────────────────
  let action: 'block' | 'warn' | 'pass' = 'warn';
  if (/\b(block|prevent|stop|deny|forbid|disallow|reject)\b/.test(lower)) {
    action = 'block';
    confidence += 0.1;
  } else if (/\b(warn|flag|alert|notify|hold|pause|review)\b/.test(lower)) {
    action = 'warn';
    confidence += 0.1;
  } else if (/\b(allow|permit|enable|pass|approve)\b/.test(lower)) {
    action = 'pass';
    confidence += 0.05;
  } else {
    notes.push('Could not determine action (block/warn/pass) — defaulting to warn');
  }

  // ── Actor type ────────────────────────────────────────────────────────────
  if (/\b(claude|cursor|agent|ai|bot|copilot|windsurf|automated|autonomous)\b/.test(lower)) {
    conditions.actorType = 'ai';
    confidence += 0.05;
  } else if (/\bhuman\b/.test(lower)) {
    conditions.actorType = 'human';
    confidence += 0.05;
  }

  // ── Environment ───────────────────────────────────────────────────────────
  const envMatch = lower.match(/\b(production|prod|staging|stage|development|dev|test|testing)\b/);
  if (envMatch) {
    conditions.environments = [envMatch[1] === 'stage' ? 'staging' : envMatch[1] === 'dev' ? 'development' : envMatch[1]];
    confidence += 0.1;
  }

  // ── Time: days of week ────────────────────────────────────────────────────
  const daysFound: number[] = [];
  for (const [name, num] of Object.entries(DAY_MAP)) {
    if (lower.includes(name)) daysFound.push(num);
  }
  if (/\bweekend\b/.test(lower)) daysFound.push(0, 6);
  if (/\bweekday\b/.test(lower)) daysFound.push(1, 2, 3, 4, 5);
  if (daysFound.length > 0) {
    conditions.daysOfWeek = [...new Set(daysFound)].sort();
    confidence += 0.1;
  }

  // ── Time: hour window ────────────────────────────────────────────────────
  const afterMatch = lower.match(/after\s+(\d{1,2})(am|pm)?/);
  const beforeMatch = lower.match(/before\s+(\d{1,2})(am|pm)?/);
  const betweenMatch = lower.match(/between\s+(\d{1,2})(am|pm)?\s+and\s+(\d{1,2})(am|pm)?/);
  if (betweenMatch) {
    const start = toHour(parseInt(betweenMatch[1]), betweenMatch[2]);
    const end   = toHour(parseInt(betweenMatch[3]), betweenMatch[4]);
    conditions.hourWindow = [start, end];
    confidence += 0.1;
  } else if (afterMatch) {
    const start = toHour(parseInt(afterMatch[1]), afterMatch[2]);
    conditions.hourWindow = [start, 24];
    confidence += 0.1;
  } else if (beforeMatch) {
    const end = toHour(parseInt(beforeMatch[1]), beforeMatch[2]);
    conditions.hourWindow = [0, end];
    confidence += 0.1;
  }

  // ── Commands + files from domain keywords ─────────────────────────────────
  const extractedCommands: string[] = [];
  const extractedFiles: string[] = [];

  // Direct destructive keyword mentions
  for (const kw of DESTRUCTIVE_KEYWORDS) {
    if (lower.includes(kw.split(' ')[0])) {
      extractedCommands.push(kw);
    }
  }
  for (const kw of SCHEMA_KEYWORDS) {
    if (lower.includes(kw.split(' ')[0])) {
      extractedCommands.push(kw);
    }
  }

  // Domain-specific extraction
  for (const domain of KEYWORD_DOMAINS) {
    if (domain.patterns.some(p => lower.includes(p))) {
      extractedCommands.push(...domain.commands);
      if (domain.files) extractedFiles.push(...domain.files);
    }
  }

  if (extractedCommands.length > 0) {
    conditions.commands = [...new Set(extractedCommands)];
    confidence += 0.15;
  } else {
    notes.push('Could not extract specific commands — you may need to add conditions.commands manually');
    confidence -= 0.1;
  }

  if (extractedFiles.length > 0) {
    conditions.files = [...new Set(extractedFiles)];
  }

  // ── Generate ID and name ──────────────────────────────────────────────────
  const actionWord  = action;
  const envWord     = conditions.environments?.[0] ?? '';
  const actorWord   = conditions.actorType === 'ai' ? 'ai' : conditions.actorType === 'human' ? 'human' : '';
  const domainWord  = (conditions.commands?.[0] ?? 'action').replace(/\s+/g, '_').replace(/[^a-z0-9_]/gi, '').slice(0, 20);
  const id = [actionWord, actorWord, envWord, domainWord].filter(Boolean).join('_').toLowerCase().slice(0, 60) + '_' + randomUUID().slice(0, 4);
  const name = description.slice(0, 60) + (description.length > 60 ? '…' : '');

  // ── Reason string ─────────────────────────────────────────────────────────
  const envPhrase = conditions.environments ? ` in ${conditions.environments.join('/')}` : '';
  const actorPhrase = conditions.actorType === 'ai' ? ' for AI agents' : conditions.actorType === 'human' ? ' for human operators' : '';
  const reason = `Policy: ${actionWord === 'block' ? 'Blocked' : 'Flagged'}${envPhrase}${actorPhrase} — ${description.slice(0, 120)}`;

  if (Object.keys(conditions).length === 0) {
    notes.push('No conditions could be extracted — this rule will match everything');
    confidence = 0.2;
  }

  confidence = Math.min(0.95, Math.max(0.1, confidence));

  return {
    rule: { id, name, description, action, reason, conditions },
    confidence: Math.round(confidence * 100) / 100,
    notes,
  };
}

function toHour(h: number, meridiem?: string): number {
  if (!meridiem) return h;
  if (meridiem === 'pm' && h < 12) return h + 12;
  if (meridiem === 'am' && h === 12) return 0;
  return h;
}
