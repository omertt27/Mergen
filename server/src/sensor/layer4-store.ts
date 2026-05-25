import { ErrorHistoryEntry, FixLink } from './extended-buffer.js';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Layer 4: Better Memory Store ──────────────────────────────────────────────

const ERROR_INDEX_PATH = join(homedir(), '.mergen', 'error-index.json');
const MAX_ERROR_ENTRIES = 1000;

class Layer4Store {
  private errorIndex = new Map<string, ErrorHistoryEntry>();

  constructor() {
    this.load();
  }

  /** Generate fingerprint from error message and stack */
  private fingerprint(message: string, stack?: string): string {
    const stackLines = stack?.split('\n').slice(0, 3).join('\n') || '';
    const input = `${message}\n${stackLines}`;
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }

  /** Record an error occurrence */
  recordError(message: string, stack?: string): string {
    const fp = this.fingerprint(message, stack);
    const existing = this.errorIndex.get(fp);

    if (existing) {
      existing.count++;
      existing.lastSeen = Date.now();
    } else {
      this.errorIndex.set(fp, {
        fingerprint: fp,
        message: message.slice(0, 500),
        stack: stack?.slice(0, 2000),
        count: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        fixes: [],
      });
    }

    this.persist();
    return fp;
  }

  /** Link a fix to an error */
  linkFix(fingerprint: string, commitSha: string, description: string, verdict: FixLink['verdict'] = 'correct'): boolean {
    const entry = this.errorIndex.get(fingerprint);
    if (!entry) return false;

    // Check if this commit is already linked
    const existing = entry.fixes.find((f) => f.commitSha === commitSha);
    if (existing) {
      existing.verdict = verdict;
      existing.confidence = this.calculateConfidence(verdict);
    } else {
      entry.fixes.push({
        commitSha,
        description: description.slice(0, 500),
        linkedAt: Date.now(),
        verdict,
        confidence: this.calculateConfidence(verdict),
      });
    }

    this.persist();
    return true;
  }

  /** Get error history for a fingerprint */
  getError(fingerprint: string): ErrorHistoryEntry | undefined {
    return this.errorIndex.get(fingerprint);
  }

  /** Search for similar errors */
  searchErrors(query: string, limit = 10): ErrorHistoryEntry[] {
    const results: Array<{ entry: ErrorHistoryEntry; score: number }> = [];
    const queryLower = query.toLowerCase();

    for (const entry of this.errorIndex.values()) {
      const messageLower = entry.message.toLowerCase();
      if (messageLower.includes(queryLower)) {
        // Simple relevance scoring: exact match = 1.0, substring = 0.5
        const score = messageLower === queryLower ? 1.0 : 0.5;
        results.push({ entry, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score || b.entry.count - a.entry.count)
      .slice(0, limit)
      .map((r) => r.entry);
  }

  /** Get top fix for an error */
  getTopFix(fingerprint: string): FixLink | undefined {
    const entry = this.errorIndex.get(fingerprint);
    if (!entry || entry.fixes.length === 0) return undefined;

    // Sort by confidence (correct > partial > wrong)
    return entry.fixes.sort((a, b) => b.confidence - a.confidence)[0];
  }

  /** List all errors, sorted by most recent */
  listErrors(limit = 50): ErrorHistoryEntry[] {
    return Array.from(this.errorIndex.values())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, limit);
  }

  /** Load from disk */
  private load(): void {
    try {
      if (!existsSync(ERROR_INDEX_PATH)) return;
      const data = JSON.parse(readFileSync(ERROR_INDEX_PATH, 'utf-8'));
      if (Array.isArray(data)) {
        for (const entry of data) {
          this.errorIndex.set(entry.fingerprint, entry);
        }
      }
    } catch (err) {
      console.error('[layer4] Failed to load error index:', err);
    }
  }

  /** Persist to disk */
  private persist(): void {
    try {
      // Ensure directory exists
      const dir = join(homedir(), '.mergen');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Prune to MAX_ERROR_ENTRIES (LRU)
      if (this.errorIndex.size > MAX_ERROR_ENTRIES) {
        const sorted = Array.from(this.errorIndex.values())
          .sort((a, b) => b.lastSeen - a.lastSeen)
          .slice(0, MAX_ERROR_ENTRIES);
        this.errorIndex.clear();
        for (const entry of sorted) {
          this.errorIndex.set(entry.fingerprint, entry);
        }
      }

      const data = Array.from(this.errorIndex.values());
      writeFileSync(ERROR_INDEX_PATH, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[layer4] Failed to persist error index:', err);
    }
  }

  private calculateConfidence(verdict: FixLink['verdict']): number {
    switch (verdict) {
      case 'correct': return 1.0;
      case 'partial': return 0.6;
      case 'wrong': return 0.2;
      default: return 0.5;
    }
  }

  /** Get statistics */
  getStats(): { totalErrors: number; totalFixes: number; avgFixesPerError: number } {
    const totalErrors = this.errorIndex.size;
    const totalFixes = Array.from(this.errorIndex.values()).reduce(
      (sum, e) => sum + e.fixes.length,
      0
    );
    const avgFixesPerError = totalErrors > 0 ? totalFixes / totalErrors : 0;

    return { totalErrors, totalFixes, avgFixesPerError };
  }
}

export const layer4Store = new Layer4Store();
