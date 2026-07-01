/**
 * sqlite-incident-store.ts — IIncidentStore backed by the existing IncidentStore singleton.
 *
 * All methods are thin async wrappers around the synchronous (or already-async)
 * calls on incidentStore. tenantId params are accepted for interface conformance
 * but ignored — SQLite is single-tenant.
 */

import { incidentStore } from '../../sensor/incident-store.js';
import type { Incident, IncidentStatus, ServiceEdge } from '../../sensor/incident-store.js';
import type { IIncidentStore } from '../interfaces.js';

export class SqliteIncidentStore implements IIncidentStore {
  /** Delegates to incidentStore.init() which is already async (sql.js WASM load). */
  async init(): Promise<void> {
    return incidentStore.init();
  }

  async upsert(
    pid: string,
    fields: Partial<Omit<Incident, 'pid' | 'createdAt' | 'updatedAt'>>,
    _tenantId?: string,
  ): Promise<Incident> {
    return Promise.resolve(incidentStore.upsert(pid, fields));
  }

  async get(pid: string, _tenantId?: string): Promise<Incident | null> {
    return Promise.resolve(incidentStore.get(pid));
  }

  async list(
    status?: IncidentStatus,
    limit?: number,
    _tenantId?: string,
  ): Promise<Incident[]> {
    return Promise.resolve(incidentStore.list(status, limit));
  }

  async addNote(
    pid: string,
    note: string,
    author?: string,
    _tenantId?: string,
  ): Promise<Incident | null> {
    return Promise.resolve(incidentStore.addNote(pid, note, author));
  }

  async markContextViewed(pid: string, _tenantId?: string): Promise<void> {
    return Promise.resolve(incidentStore.markContextViewed(pid));
  }

  async coOccurringServices(
    service: string,
    windowMs?: number,
    limit?: number,
    _tenantId?: string,
  ): Promise<Array<{ service: string; count: number }>> {
    return Promise.resolve(incidentStore.coOccurringServices(service, windowMs, limit));
  }

  async updateServiceEdges(
    service: string,
    at: number,
    windowMs?: number,
    _tenantId?: string,
  ): Promise<void> {
    return Promise.resolve(incidentStore.updateServiceEdges(service, at, windowMs));
  }

  async getInteractionGraph(service?: string, _tenantId?: string): Promise<ServiceEdge[]> {
    return Promise.resolve(incidentStore.getInteractionGraph(service));
  }
}
