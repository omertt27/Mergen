import { BrowserEvent } from './buffer.js';
import { ReplayEvent, WatchPattern, TimelineEntry } from './extended-buffer.js';
import { randomBytes } from 'crypto';

// ── Layer 2: Better Diagnosis Store ───────────────────────────────────────────

class Layer2Store {
  private eventIndex = new Map<string, BrowserEvent>(); // id → full event
  private watchPatterns = new Map<string, WatchPattern>(); // id → pattern
  private watchListeners = new Map<string, (event: BrowserEvent) => void>();

  /** Store full event with ID for later replay */
  indexEvent(event: BrowserEvent): string {
    const id = randomBytes(8).toString('hex');
    this.eventIndex.set(id, event);

    // Check watch patterns
    for (const [watchId, pattern] of this.watchPatterns) {
      if (this.matchesPattern(event, pattern)) {
        const listener = this.watchListeners.get(watchId);
        if (listener) listener(event);
      }
    }

    return id;
  }

  /** Retrieve full event by ID */
  getEventById(id: string): BrowserEvent | undefined {
    return this.eventIndex.get(id);
  }

  /** Register a watch pattern */
  registerWatch(pattern: string, type: WatchPattern['type']): string {
    const id = randomBytes(8).toString('hex');
    this.watchPatterns.set(id, {
      id,
      pattern,
      type,
      createdAt: Date.now(),
    });
    return id;
  }

  /** Remove a watch pattern */
  removeWatch(id: string): boolean {
    this.watchListeners.delete(id);
    return this.watchPatterns.delete(id);
  }

  /** List all active watch patterns */
  listWatches(): WatchPattern[] {
    return Array.from(this.watchPatterns.values());
  }

  /** Set callback for watch pattern */
  setWatchListener(watchId: string, callback: (event: BrowserEvent) => void): void {
    this.watchListeners.set(watchId, callback);
  }

  /** Build timeline from events */
  buildTimeline(events: BrowserEvent[], from?: number, to?: number): TimelineEntry[] {
    return events
      .filter((e) => {
        if (from !== undefined && e.timestamp < from) return false;
        if (to !== undefined && e.timestamp > to) return false;
        return true;
      })
      .map((e) => ({
        timestamp: e.timestamp,
        type: e.type,
        summary: this.summarizeEvent(e),
        fullEvent: e,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  private matchesPattern(event: BrowserEvent, pattern: WatchPattern): boolean {
    if (pattern.type !== event.type) return false;

    try {
      const regex = new RegExp(pattern.pattern, 'i');

      if (event.type === 'console') {
        const message = event.args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ');
        return regex.test(message);
      }

      if (event.type === 'network') {
        return regex.test(event.url);
      }
    } catch {
      // Invalid regex — treat as literal string match
      if (event.type === 'console') {
        const message = event.args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ');
        return message.includes(pattern.pattern);
      }
      if (event.type === 'network') {
        return event.url.includes(pattern.pattern);
      }
    }

    return false;
  }

  private summarizeEvent(event: BrowserEvent): string {
    if (event.type === 'console') {
      const msg = event.args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
        .slice(0, 100);
      return `[${event.level.toUpperCase()}] ${msg}`;
    }

    if (event.type === 'network') {
      return `${event.method} ${event.url} → ${event.status} (${event.duration}ms)`;
    }

    if (event.type === 'context') {
      return `Context snapshot (${event.trigger}) at ${event.url}`;
    }

    return 'Unknown event';
  }

  /** Clear old indexed events to prevent memory leak (keep last 500) */
  pruneEventIndex(): void {
    const MAX_INDEXED_EVENTS = 500;
    if (this.eventIndex.size > MAX_INDEXED_EVENTS) {
      const sorted = Array.from(this.eventIndex.entries())
        .sort((a, b) => b[1].timestamp - a[1].timestamp);
      this.eventIndex.clear();
      for (const [id, event] of sorted.slice(0, MAX_INDEXED_EVENTS)) {
        this.eventIndex.set(id, event);
      }
    }
  }
}

export const layer2Store = new Layer2Store();
