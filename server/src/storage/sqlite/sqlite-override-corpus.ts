/**
 * sqlite-override-corpus.ts — IOverrideCorpus backed by the existing module-level
 * functions in override-corpus.ts.
 *
 * All methods are thin async wrappers. tenantId params are accepted for interface
 * conformance but ignored — the JSON-file corpus is single-tenant.
 */

import {
  recordOverride,
  updateOutcome,
  hasRecentOverride,
  dominantOverrideReason,
  getOverridesForTag,
  getOverrideById,
  getAllOverrides,
  compactCorpus,
  getRulesForTag,
  describeTopRule,
  getOverrideSummary,
  compileOverrideFromSlackThread,
  compileOverridesFromSlackThread,
  getStaleOverrides,
  markOverrideReviewed,
} from '../../intelligence/override-corpus.js';
import type {
  OverrideEvent,
  OverrideReason,
  OverrideOutcome,
  CompactedRule,
  OverrideSummary,
} from '../../intelligence/override-corpus.js';
import type { IOverrideCorpus } from '../interfaces.js';

export class SqliteOverrideCorpus implements IOverrideCorpus {
  async recordOverride(
    input: Omit<OverrideEvent, 'id' | 'dayOfWeek' | 'hourOfDay' | 'recordedAt'>,
    _tenantId?: string,
  ): Promise<OverrideEvent> {
    return Promise.resolve(recordOverride(input));
  }

  async updateOutcome(
    id: string,
    outcome: OverrideOutcome,
    _tenantId?: string,
  ): Promise<boolean> {
    return Promise.resolve(updateOutcome(id, outcome));
  }

  async hasRecentOverride(
    incidentTag: string,
    service: string,
    dayOfWeek: number,
    hourOfDay: number,
    _tenantId?: string,
  ): Promise<boolean> {
    return Promise.resolve(hasRecentOverride(incidentTag, service, dayOfWeek, hourOfDay));
  }

  async dominantOverrideReason(
    incidentTag: string,
    service: string,
    _tenantId?: string,
  ): Promise<OverrideReason | null> {
    return Promise.resolve(dominantOverrideReason(incidentTag, service));
  }

  async getOverridesForTag(tag: string, _tenantId?: string): Promise<OverrideEvent[]> {
    return Promise.resolve(getOverridesForTag(tag));
  }

  async getOverrideById(id: string, _tenantId?: string): Promise<OverrideEvent | null> {
    return Promise.resolve(getOverrideById(id));
  }

  async getAllOverrides(_tenantId?: string): Promise<readonly OverrideEvent[]> {
    return Promise.resolve(getAllOverrides());
  }

  async compactCorpus(_tenantId?: string): Promise<CompactedRule[]> {
    return Promise.resolve(compactCorpus());
  }

  async getRulesForTag(
    incidentTag: string,
    service: string,
    _tenantId?: string,
  ): Promise<CompactedRule[]> {
    return Promise.resolve(getRulesForTag(incidentTag, service));
  }

  async describeTopRule(
    incidentTag: string,
    service: string,
    _tenantId?: string,
  ): Promise<string | null> {
    return Promise.resolve(describeTopRule(incidentTag, service));
  }

  async getOverrideSummary(_tenantId?: string): Promise<OverrideSummary[]> {
    return Promise.resolve(getOverrideSummary());
  }

  async compileOverrideFromSlackThread(
    slackThread: string,
    service?: string,
    _tenantId?: string,
  ): Promise<OverrideEvent | null> {
    return Promise.resolve(compileOverrideFromSlackThread(slackThread, service));
  }

  async compileOverridesFromSlackThread(
    slackThread: string,
    service?: string,
    _tenantId?: string,
  ): Promise<OverrideEvent[]> {
    return Promise.resolve(compileOverridesFromSlackThread(slackThread, service));
  }

  async getStaleOverrides(daysThreshold = 60, _tenantId?: string): Promise<OverrideEvent[]> {
    return Promise.resolve(getStaleOverrides(daysThreshold));
  }

  async markOverrideReviewed(id: string, _tenantId?: string): Promise<boolean> {
    return Promise.resolve(markOverrideReviewed(id));
  }
}
