/**
 * storage/interfaces.ts — Async storage interfaces for all Mergen stores.
 *
 * Every method returns a Promise so that implementations can be swapped
 * transparently between SQLite (Phase 1) and Postgres (Phase 2) without
 * touching any call sites.
 *
 * Phase 1 ships thin SQLite wrappers that delegate to the existing singleton
 * objects. Phase 2 will drop in Postgres implementations behind the same seam.
 */

import type { BrowserEvent } from '../sensor/buffer.js';
import type { Incident, IncidentStatus, ServiceEdge } from '../sensor/incident-store.js';
import type {
  OverrideEvent,
  OverrideReason,
  OverrideOutcome,
  CompactedRule,
  OverrideSummary,
} from '../intelligence/override-corpus.js';
import type { PendingExecution } from '../intelligence/execution-gate.js';
import type {
  ShadowEntry,
  ShadowSkipReason,
  HumanVerdict,
  ShadowReport,
} from '../intelligence/shadow-log.js';

// ── Event store ───────────────────────────────────────────────────────────────

export interface IEventStore {
  init(): Promise<void>;
  push(event: BrowserEvent, tenantId?: string): Promise<void>;
  query(opts: {
    since?: number;
    limit?: number;
    level?: string;
    type?: string;
    tenantId?: string;
  }): Promise<BrowserEvent[]>;
  size(): Promise<number>;
  clear(tenantId?: string): Promise<void>;
  pruneOld(): Promise<void>;
}

// ── Incident store ────────────────────────────────────────────────────────────

export interface IIncidentStore {
  init(): Promise<void>;
  upsert(
    pid: string,
    fields: Partial<Omit<Incident, 'pid' | 'createdAt' | 'updatedAt'>>,
    tenantId?: string,
  ): Promise<Incident>;
  get(pid: string, tenantId?: string): Promise<Incident | null>;
  list(status?: IncidentStatus, limit?: number, tenantId?: string): Promise<Incident[]>;
  addNote(pid: string, note: string, author?: string, tenantId?: string): Promise<Incident | null>;
  markContextViewed(pid: string, tenantId?: string): Promise<void>;
  coOccurringServices(
    service: string,
    windowMs?: number,
    limit?: number,
    tenantId?: string,
  ): Promise<Array<{ service: string; count: number }>>;
  updateServiceEdges(
    service: string,
    at: number,
    windowMs?: number,
    tenantId?: string,
  ): Promise<void>;
  getInteractionGraph(service?: string, tenantId?: string): Promise<ServiceEdge[]>;
}

// ── Override corpus ───────────────────────────────────────────────────────────

export interface IOverrideCorpus {
  recordOverride(
    input: Omit<OverrideEvent, 'id' | 'dayOfWeek' | 'hourOfDay' | 'recordedAt'>,
    tenantId?: string,
  ): Promise<OverrideEvent>;
  updateOutcome(id: string, outcome: OverrideOutcome, tenantId?: string): Promise<boolean>;
  hasRecentOverride(
    incidentTag: string,
    service: string,
    dayOfWeek: number,
    hourOfDay: number,
    tenantId?: string,
  ): Promise<boolean>;
  dominantOverrideReason(
    incidentTag: string,
    service: string,
    tenantId?: string,
  ): Promise<OverrideReason | null>;
  getOverridesForTag(tag: string, tenantId?: string): Promise<OverrideEvent[]>;
  getOverrideById(id: string, tenantId?: string): Promise<OverrideEvent | null>;
  getAllOverrides(tenantId?: string): Promise<readonly OverrideEvent[]>;
  compactCorpus(tenantId?: string): Promise<CompactedRule[]>;
  getRulesForTag(incidentTag: string, service: string, tenantId?: string): Promise<CompactedRule[]>;
  describeTopRule(incidentTag: string, service: string, tenantId?: string): Promise<string | null>;
  getOverrideSummary(tenantId?: string): Promise<OverrideSummary[]>;
  compileOverrideFromSlackThread(
    slackThread: string,
    service?: string,
    tenantId?: string,
  ): Promise<OverrideEvent | null>;
  compileOverridesFromSlackThread(
    slackThread: string,
    service?: string,
    tenantId?: string,
  ): Promise<OverrideEvent[]>;
}

// ── Shadow log ────────────────────────────────────────────────────────────────

export interface IShadowLog {
  recordShadow(
    input: Omit<ShadowEntry, 'id' | 'recordedAt'> & { id?: string },
    tenantId?: string,
  ): Promise<ShadowEntry>;
  recordShadowVerdict(
    id: string,
    verdict: HumanVerdict,
    opts: { note?: string; overrideReason?: OverrideReason; manualAction?: string; actor?: string },
    tenantId?: string,
  ): Promise<{ found: false } | { found: true; entry: ShadowEntry; overrideId?: string }>;
  updateShadowReasonByPid(
    pid: string,
    skipReason: ShadowSkipReason,
    tenantId?: string,
  ): Promise<void>;
  getShadowEntries(tenantId?: string): Promise<readonly ShadowEntry[]>;
  getShadowReport(windowDays?: number, tenantId?: string): Promise<ShadowReport>;
  getShadowSlackDigest(windowDays?: number, tenantId?: string): Promise<object>;
  exportShadowCsv(tenantId?: string): Promise<string>;
}

// ── Approval store ────────────────────────────────────────────────────────────

export interface IApprovalStore {
  add(token: string, execution: PendingExecution, tenantId?: string): Promise<void>;
  get(token: string): Promise<PendingExecution | null>;
  resolve(token: string): Promise<boolean>;
  listPending(tenantId?: string): Promise<Array<[string, PendingExecution]>>;
  pruneExpired(): Promise<void>;
  flush(): Promise<void>;
}
