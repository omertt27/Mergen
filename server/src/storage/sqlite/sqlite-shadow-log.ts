/**
 * sqlite-shadow-log.ts — IShadowLog backed by the existing file-based singleton.
 *
 * Thin async wrappers. tenantId params are accepted for interface conformance
 * but ignored — the JSON-file shadow log is single-tenant.
 */

import {
  recordShadow,
  recordShadowVerdict,
  updateShadowReasonByPid,
  getShadowLog,
  getShadowReport,
  getShadowSlackDigest,
  exportShadowCsv,
} from '../../intelligence/shadow-log.js';
import type { ShadowEntry, ShadowSkipReason, HumanVerdict, ShadowReport } from '../../intelligence/shadow-log.js';
import type { OverrideReason } from '../../intelligence/override-corpus.js';
import type { IShadowLog } from '../interfaces.js';

export class SqliteShadowLog implements IShadowLog {
  async recordShadow(
    input: Omit<ShadowEntry, 'id' | 'recordedAt'> & { id?: string },
    _tenantId?: string,
  ): Promise<ShadowEntry> {
    return Promise.resolve(recordShadow(input));
  }

  async recordShadowVerdict(
    id: string,
    verdict: HumanVerdict,
    opts: { note?: string; overrideReason?: OverrideReason; manualAction?: string; actor?: string },
    _tenantId?: string,
  ): Promise<{ found: false } | { found: true; entry: ShadowEntry; overrideId?: string }> {
    return Promise.resolve(recordShadowVerdict(id, verdict, opts));
  }

  async updateShadowReasonByPid(
    pid: string,
    skipReason: ShadowSkipReason,
    _tenantId?: string,
  ): Promise<void> {
    updateShadowReasonByPid(pid, skipReason);
    return Promise.resolve();
  }

  async getShadowEntries(_tenantId?: string): Promise<readonly ShadowEntry[]> {
    return Promise.resolve(getShadowLog());
  }

  async getShadowReport(windowDays = 30, _tenantId?: string): Promise<ShadowReport> {
    return Promise.resolve(getShadowReport(windowDays));
  }

  async getShadowSlackDigest(windowDays = 7, _tenantId?: string): Promise<object> {
    return Promise.resolve(getShadowSlackDigest(windowDays));
  }

  async exportShadowCsv(_tenantId?: string): Promise<string> {
    return Promise.resolve(exportShadowCsv());
  }
}
