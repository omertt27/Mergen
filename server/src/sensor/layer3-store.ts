import { Breakpoint, MockResponse, InjectedLog } from './extended-buffer.js';
import { randomBytes } from 'crypto';

// ── Layer 3: Better Action Store ──────────────────────────────────────────────

class Layer3Store {
  private breakpoints = new Map<string, Breakpoint>();
  private mocks = new Map<string, MockResponse>();
  private injectedLogs = new Map<string, InjectedLog>();
  private pendingCommands = new Map<string, any>(); // Commands to send to extension

  /** Set a conditional breakpoint */
  setBreakpoint(condition: string, eventType: Breakpoint['eventType'], pattern: string): string {
    const id = randomBytes(8).toString('hex');
    this.breakpoints.set(id, {
      id,
      condition,
      eventType,
      pattern,
      createdAt: Date.now(),
      hitCount: 0,
    });
    return id;
  }

  /** Remove a breakpoint */
  removeBreakpoint(id: string): boolean {
    return this.breakpoints.delete(id);
  }

  /** List all active breakpoints */
  listBreakpoints(): Breakpoint[] {
    return Array.from(this.breakpoints.values());
  }

  /** Check if event matches any breakpoint */
  checkBreakpoint(event: any): Breakpoint | null {
    for (const bp of this.breakpoints.values()) {
      if (this.matchesBreakpoint(event, bp)) {
        bp.hitCount++;
        return bp;
      }
    }
    return null;
  }

  /** Register a mock response */
  setMock(url: string, method: string, status: number, body: any, headers?: Record<string, string>): string {
    const id = randomBytes(8).toString('hex');
    this.mocks.set(id, {
      id,
      url,
      method: method.toUpperCase(),
      status,
      body,
      headers,
      createdAt: Date.now(),
      hitCount: 0,
    });

    // Queue command to extension
    this.queueCommand('SET_MOCK', { id, url, method, status, body, headers });

    return id;
  }

  /** Remove a mock */
  removeMock(id: string): boolean {
    const mock = this.mocks.get(id);
    if (mock) {
      this.queueCommand('REMOVE_MOCK', { id });
      return this.mocks.delete(id);
    }
    return false;
  }

  /** List all active mocks */
  listMocks(): MockResponse[] {
    return Array.from(this.mocks.values());
  }

  /** Check if request should be mocked */
  getMock(url: string, method: string): MockResponse | null {
    for (const mock of this.mocks.values()) {
      if (this.urlMatches(url, mock.url) && method.toUpperCase() === mock.method) {
        mock.hitCount++;
        return mock;
      }
    }
    return null;
  }

  /** Inject a temporary log */
  injectLog(selector: string, event: string, expression: string): string {
    const id = randomBytes(8).toString('hex');
    this.injectedLogs.set(id, {
      id,
      selector,
      event,
      expression,
      createdAt: Date.now(),
      captured: [],
    });

    // Queue command to extension
    this.queueCommand('INJECT_LOG', { id, selector, event, expression });

    return id;
  }

  /** Remove an injected log */
  removeInjectedLog(id: string): boolean {
    const log = this.injectedLogs.get(id);
    if (log) {
      this.queueCommand('REMOVE_LOG', { id });
      return this.injectedLogs.delete(id);
    }
    return false;
  }

  /** List all injected logs */
  listInjectedLogs(): InjectedLog[] {
    return Array.from(this.injectedLogs.values());
  }

  /** Store captured data from injected log */
  captureLogData(id: string, data: any): void {
    const log = this.injectedLogs.get(id);
    if (log) {
      log.captured.push({ timestamp: Date.now(), data });
      // Auto-remove after first capture
      if (log.captured.length >= 1) {
        this.removeInjectedLog(id);
      }
    }
  }

  /** Queue a command to be sent to extension */
  private queueCommand(type: string, payload: any): void {
    const id = randomBytes(8).toString('hex');
    this.pendingCommands.set(id, { type, payload, queuedAt: Date.now() });
  }

  /** Get and clear pending commands for extension polling */
  getPendingCommands(): any[] {
    const commands = Array.from(this.pendingCommands.values());
    this.pendingCommands.clear();
    return commands;
  }

  private matchesBreakpoint(event: any, bp: Breakpoint): boolean {
    if (event.type !== bp.eventType) return false;

    try {
      const regex = new RegExp(bp.pattern, 'i');

      if (event.type === 'console') {
        const message = event.args
          ?.map((a: any) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ') || '';
        if (!regex.test(message)) return false;
      }

      if (event.type === 'network') {
        if (!regex.test(event.url)) return false;
      }

      // Evaluate condition
      if (bp.condition) {
        // Simple condition evaluation (extend as needed)
        return this.evaluateCondition(bp.condition, event);
      }

      return true;
    } catch {
      return false;
    }
  }

  private evaluateCondition(condition: string, event: any): boolean {
    // Simple condition evaluator
    // Supports: status === 401, level === 'error', duration > 1000, etc.
    try {
      const match = condition.match(/(\w+)\s*(===|!==|>|<|>=|<=)\s*(.+)/);
      if (!match) return true;

      const [, key, op, value] = match;
      const actualValue = (event as any)[key];

      let expectedValue: any = value.trim();
      if (expectedValue.startsWith("'") || expectedValue.startsWith('"')) {
        expectedValue = expectedValue.slice(1, -1);
      } else if (!isNaN(Number(expectedValue))) {
        expectedValue = Number(expectedValue);
      }

      switch (op) {
        case '===': return actualValue === expectedValue;
        case '!==': return actualValue !== expectedValue;
        case '>': return actualValue > expectedValue;
        case '<': return actualValue < expectedValue;
        case '>=': return actualValue >= expectedValue;
        case '<=': return actualValue <= expectedValue;
        default: return true;
      }
    } catch {
      return true;
    }
  }

  private urlMatches(url: string, pattern: string): boolean {
    // Support glob-style patterns
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i'
    );
    return regex.test(url);
  }

  /** Clear old commands to prevent memory leak */
  pruneOldCommands(): void {
    const MAX_AGE_MS = 60_000; // 1 minute
    const now = Date.now();
    for (const [id, cmd] of this.pendingCommands) {
      if (now - cmd.queuedAt > MAX_AGE_MS) {
        this.pendingCommands.delete(id);
      }
    }
  }
}

export const layer3Store = new Layer3Store();
