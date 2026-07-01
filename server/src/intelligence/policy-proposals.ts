/**
 * policy-proposals.ts — staging area for corpus-derived policy rules that are
 * awaiting human approval.
 *
 * When MERGEN_AUTO_CORPUS_PROPOSE=true, proposeRulesFromCorpus() (corpus-to-
 * policy.ts) stages HOLD-only rules here instead of activating them. A proposed
 * rule is INERT: it is not part of loadEnterprisePolicy() and is never evaluated
 * by the gate until an operator approves it via
 * POST /policies/proposals/:id/approve.
 *
 * This is the opt-in, never-auto-BLOCK counterpart to autoActivateReviewedRules()
 * — that path commits reviewed corpus rules (which may BLOCK) straight to live
 * policy; this path only ever proposes a HOLD, and only a human turns it on.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { EnterprisePolicyRule } from './enterprise-policy-engine.js';
import { DATA_DIR, zeroRetentionMode } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

export type ProposalStatus = 'proposed' | 'approved' | 'rejected';

export interface PolicyProposal {
  id:                string;
  /** Idempotency key — the synthesized rule id (`corpus_auto_<hash>`). */
  ruleHash:          string;
  /** The rule to install on approval. Always action:'warn' (HOLD-only). */
  rule:              EnterprisePolicyRule;
  sourceOccurrences: number;
  status:            ProposalStatus;
  proposedAt:        number;
  decidedAt:         number | null;
}

const PROPOSALS_FILE = path.join(DATA_DIR, 'policy-proposals.json');
let _proposals: PolicyProposal[] | null = null;

function load(): PolicyProposal[] {
  if (_proposals) return _proposals;
  if (zeroRetentionMode() || !fs.existsSync(PROPOSALS_FILE)) {
    _proposals = [];
    return _proposals;
  }
  try {
    _proposals = JSON.parse(fs.readFileSync(PROPOSALS_FILE, 'utf8')) as PolicyProposal[];
  } catch (err) {
    logger.warn({ err }, 'policy-proposals: file unreadable — starting empty');
    _proposals = [];
  }
  return _proposals;
}

function persist(): void {
  if (zeroRetentionMode()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${PROPOSALS_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(_proposals ?? [], null, 2));
    fs.renameSync(tmp, PROPOSALS_FILE);
  } catch (err) {
    logger.warn({ err }, 'policy-proposals: persist failed');
  }
}

/**
 * Stage a HOLD-only proposal. Idempotent on ruleHash: if a non-rejected
 * proposal for the same rule already exists, returns null (no duplicate).
 * Throws if handed a rule that is not action:'warn' — proposals never BLOCK.
 */
export function stageProposal(
  ruleHash: string,
  rule: EnterprisePolicyRule,
  sourceOccurrences: number,
): PolicyProposal | null {
  if (rule.action !== 'warn') {
    throw new Error(`policy-proposals: refusing to stage a non-HOLD proposal (action=${rule.action})`);
  }
  const list = load();
  const existing = list.find((p) => p.ruleHash === ruleHash && p.status !== 'rejected');
  if (existing) return null;
  const proposal: PolicyProposal = {
    id:                randomUUID(),
    ruleHash,
    rule,
    sourceOccurrences,
    status:            'proposed',
    proposedAt:        Date.now(),
    decidedAt:         null,
  };
  list.push(proposal);
  persist();
  logger.info({ id: proposal.id, ruleId: rule.id }, 'policy-proposals: staged HOLD-only proposal');
  return proposal;
}

export function getProposals(status?: ProposalStatus): PolicyProposal[] {
  const list = load();
  return status ? list.filter((p) => p.status === status) : [...list];
}

export function getProposal(id: string): PolicyProposal | null {
  return load().find((p) => p.id === id) ?? null;
}

/** Transition a proposal to approved/rejected. Returns null if not found or already decided. */
export function markProposalDecided(id: string, status: 'approved' | 'rejected'): PolicyProposal | null {
  const list = load();
  const p = list.find((x) => x.id === id);
  if (!p || p.status !== 'proposed') return null;
  p.status = status;
  p.decidedAt = Date.now();
  persist();
  logger.info({ id, status }, 'policy-proposals: proposal decided');
  return p;
}

export function _resetProposalsForTesting(): void {
  _proposals = null;
  try { fs.unlinkSync(PROPOSALS_FILE); } catch { /* ignore */ }
}
