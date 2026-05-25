# Sprint 1: Context Compression — GitHub Issues
**Copy-paste these into GitHub Issues for immediate execution**

---

## Issue #1: Add severity filtering to `get_recent_logs`

**Priority:** P0  
**Effort:** 2 hours  
**Sprint:** Context Compression (Week 1)

### Problem
Current `get_recent_logs` returns all console events, including noisy `console.log` calls from HMR and framework internals. This saturates the LLM context window in long sessions.

Reference: playwright-mcp #1216 shows this is a critical pain point across the MCP ecosystem.

### Solution
Add `min_severity` parameter to filter low-priority logs.

### Acceptance Criteria
- [ ] New param: `min_severity?: 'log' | 'warn' | 'error'` (default: `'warn'`)
- [ ] Only return events >= specified severity
- [ ] Update tool description in MCP schema
- [ ] Add unit tests for filtering logic
- [ ] Update docs: mention this solves token bloat

### Implementation Notes
File: `server/src/intelligence/tools.ts`, line 31–69

Current code:
```typescript
const events = store.getLogs(limit ?? 50, level as LogLevel | undefined, since);
```

Change to:
```typescript
const events = store.getLogs(limit ?? 50, level as LogLevel | undefined, since)
  .filter(e => {
    if (!min_severity) return true;
    const severityOrder = { log: 0, warn: 1, error: 2 };
    return severityOrder[e.level] >= severityOrder[min_severity];
  });
```

Also update inputSchema to include:
```typescript
min_severity: z.enum(['log', 'warn', 'error']).optional()
  .describe('Minimum severity level to return (default: warn)'),
```

### Testing
```bash
# Unit test
npm test -- --grep "get_recent_logs severity filter"

# Manual test
# 1. Generate 50 console.log events
# 2. Call get_recent_logs(min_severity: 'error')
# 3. Verify only errors returned
```

---

## Issue #2: Add pattern-based filtering to console logs

**Priority:** P0  
**Effort:** 3 hours  
**Sprint:** Context Compression (Week 1)

### Problem
Developers running Vite/webpack/Next.js see constant HMR logs like:
```
[HMR] connected
[webpack-dev-server] Hot Module Replacement enabled
```

These are noise during debugging and waste token budget.

### Solution
Add `exclude_patterns` parameter with regex-based filtering.

### Acceptance Criteria
- [ ] New param: `exclude_patterns?: string[]`
- [ ] Each pattern treated as regex (case-insensitive)
- [ ] Filter applied to serialized `args` array (joined as string)
- [ ] Pre-defined common patterns in docs: `["HMR", "webpack", "vite", "\\[Fast Refresh\\]"]`
- [ ] Unit tests with various patterns

### Implementation Notes
File: `server/src/intelligence/tools.ts`, line 31–69

Add to inputSchema:
```typescript
exclude_patterns: z.array(z.string()).optional()
  .describe('Regex patterns to exclude (e.g., ["HMR", "webpack"])'),
```

Add filtering logic after fetching events:
```typescript
if (exclude_patterns && exclude_patterns.length > 0) {
  const regexes = exclude_patterns.map(p => new RegExp(p, 'i'));
  events = events.filter(e => {
    const message = e.args.map(a => 
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ');
    return !regexes.some(re => re.test(message));
  });
}
```

### Testing
```typescript
// test/tools.test.ts
it('filters logs by exclude_patterns', async () => {
  store.addLog({
    type: 'console',
    level: 'log',
    args: ['[HMR] connected'],
    timestamp: Date.now(),
    url: 'http://localhost:3000',
    stack: '',
  });
  store.addLog({
    type: 'console',
    level: 'error',
    args: ['User not found'],
    timestamp: Date.now(),
    url: 'http://localhost:3000',
    stack: '',
  });

  const result = await callTool('get_recent_logs', {
    exclude_patterns: ['HMR'],
  });

  expect(result.logs).toHaveLength(1);
  expect(result.logs[0].args[0]).toBe('User not found');
});
```

---

## Issue #3: Smart DOM context compression

**Priority:** P0  
**Effort:** 4 hours  
**Sprint:** Context Compression (Week 1)

### Problem
`get_dom_context` returns full localStorage and sessionStorage dumps, which can be 5KB+ per snapshot. In a 10-error session, this is 50KB of redundant storage data.

### Solution
1. **Diff-based localStorage**: Only send keys that changed since last snapshot
2. **Limit sessionStorage**: Only 10 most-recently-modified keys
3. **Focused element mode**: New param `focused_element_only` to skip full context

### Acceptance Criteria
- [ ] localStorage diff: Compare to previous snapshot, only include changed keys
- [ ] Mark changed keys: `localStorage (3 keys, 2 changed):`
- [ ] sessionStorage limit: Max 10 keys, sorted by modification time (requires tracking in buffer)
- [ ] New param: `focused_element_only?: boolean` (default: false)
  - If true: only return activeElement + component name (no storage)
- [ ] Backwards compatible: old clients get full dumps
- [ ] Update tool description

### Implementation Notes

#### File: `server/src/sensor/buffer.ts`

Add state tracking:
```typescript
// Track last localStorage snapshot per URL
const lastLocalStorageByUrl = new Map<string, Record<string, string>>();

function getLocalStorageDiff(
  current: Record<string, string>, 
  url: string
): { full: Record<string, string>; changed: Set<string> } {
  const prev = lastLocalStorageByUrl.get(url) || {};
  const changed = new Set<string>();
  
  for (const [key, val] of Object.entries(current)) {
    if (prev[key] !== val) changed.add(key);
  }
  
  lastLocalStorageByUrl.set(url, current);
  return { full: current, changed };
}
```

#### File: `server/src/intelligence/tools.ts`

Update `get_dom_context` tool:
```typescript
async ({ limit, since, focused_element_only }) => {
  const snapshots = store.getContext(limit ?? 10, since);
  
  const lines = snapshots.map((s) => {
    const parts: string[] = [
      `[${new Date(s.timestamp).toISOString()}] ${s.url}`,
      `  Page: ${s.title}`,
    ];
    
    if (s.activeElement) parts.push(`  Focused element: ${s.activeElement}`);
    if (s.component) parts.push(`  Component: ${s.component}`);
    
    if (focused_element_only) {
      return parts.join('\n');
    }
    
    const { full: ls, changed: lsChanged } = store.getLocalStorageDiff(s.localStorage, s.url);
    const lsEntries = Object.entries(ls);
    if (lsEntries.length > 0) {
      parts.push(`  localStorage (${lsEntries.length} keys${lsChanged.size > 0 ? `, ${lsChanged.size} changed` : ''}):`);
      for (const [k, v] of lsEntries) {
        const badge = lsChanged.has(k) ? '🔄 ' : '';
        parts.push(`    ${badge}${k} = ${v}`);
      }
    }
    
    // sessionStorage: only 10 most recent (requires tracking in buffer)
    const ssEntries = Object.entries(s.sessionStorage).slice(0, 10);
    if (ssEntries.length > 0) {
      parts.push(`  sessionStorage (showing ${ssEntries.length} of ${Object.keys(s.sessionStorage).length}):`);
      for (const [k, v] of ssEntries) parts.push(`    ${k} = ${v}`);
    }
    
    return parts.join('\n');
  });
  
  return { content: [{ type: 'text', text: lines.join('\n\n') }] };
}
```

### Testing
```typescript
it('returns only changed localStorage keys', async () => {
  // First snapshot
  store.addContext({
    type: 'context',
    trigger: 'error',
    timestamp: Date.now(),
    url: 'http://localhost:3000',
    localStorage: { token: 'abc123', theme: 'dark' },
    sessionStorage: {},
  });
  
  // Second snapshot (only theme changed)
  store.addContext({
    type: 'context',
    trigger: 'error',
    timestamp: Date.now() + 1000,
    url: 'http://localhost:3000',
    localStorage: { token: 'abc123', theme: 'light' },
    sessionStorage: {},
  });
  
  const result = await callTool('get_dom_context', { limit: 1 });
  expect(result.text).toContain('localStorage (2 keys, 1 changed)');
  expect(result.text).toContain('🔄 theme = light');
  expect(result.text).not.toContain('🔄 token');
});

it('returns only focused element when focused_element_only=true', async () => {
  store.addContext({
    type: 'context',
    trigger: 'error',
    timestamp: Date.now(),
    url: 'http://localhost:3000',
    activeElement: 'button#submit',
    component: 'LoginForm',
    localStorage: { huge: 'x'.repeat(5000) },
    sessionStorage: {},
  });
  
  const result = await callTool('get_dom_context', { 
    limit: 1, 
    focused_element_only: true 
  });
  
  expect(result.text).toContain('button#submit');
  expect(result.text).toContain('LoginForm');
  expect(result.text).not.toContain('localStorage');
});
```

---

## Issue #4: Add token budget soft-limits to all tools

**Priority:** P1  
**Effort:** 2 hours  
**Sprint:** Context Compression (Week 1)

### Problem
Even with filtering, edge cases can still produce huge responses (e.g., 200 network requests in one session).

### Solution
Add optional `max_tokens` parameter to all tools. Truncate responses with a clear footer.

### Acceptance Criteria
- [ ] New param (all tools): `max_tokens?: number`
- [ ] Default: no limit (backwards compatible)
- [ ] Estimate tokens: `text.length / 4` (rough approximation)
- [ ] If response > `max_tokens`, truncate and append:
  ```
  [...truncated, +X more events not shown due to token budget. Call again with higher max_tokens or filter by severity/status.]
  ```
- [ ] Log truncation events to telemetry (for observability)

### Implementation Notes

Create shared helper:
```typescript
// server/src/intelligence/token-budget.ts
export function truncateToTokenBudget(
  items: string[],
  maxTokens?: number
): { result: string; truncated: boolean; omitted: number } {
  if (!maxTokens) return { 
    result: items.join('\n'), 
    truncated: false, 
    omitted: 0 
  };
  
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);
  let total = 0;
  let included = 0;
  
  for (let i = 0; i < items.length; i++) {
    total += estimateTokens(items[i]);
    if (total <= maxTokens) {
      included = i + 1;
    } else {
      break;
    }
  }
  
  const result = items.slice(0, included).join('\n');
  const omitted = items.length - included;
  
  if (omitted > 0) {
    return {
      result: result + `\n\n[...truncated, +${omitted} more events. Increase max_tokens or add filters.]`,
      truncated: true,
      omitted,
    };
  }
  
  return { result, truncated: false, omitted: 0 };
}
```

Apply to `get_recent_logs`:
```typescript
const { result, truncated, omitted } = truncateToTokenBudget(lines, max_tokens);
if (truncated) {
  logger.info({ tool: 'get_recent_logs', omitted }, 'response truncated');
}
return { content: [{ type: 'text', text: header + result }] };
```

### Testing
```typescript
it('truncates response when max_tokens exceeded', async () => {
  // Generate 100 log events
  for (let i = 0; i < 100; i++) {
    store.addLog({
      type: 'console',
      level: 'log',
      args: [`Event ${i}: ${'x'.repeat(100)}`],
      timestamp: Date.now() + i,
      url: 'http://localhost:3000',
      stack: '',
    });
  }
  
  const result = await callTool('get_recent_logs', {
    max_tokens: 500,
  });
  
  expect(result.text).toContain('[...truncated,');
  expect(result.text).toContain('more events');
  
  // Verify actual token count is near 500
  const tokens = Math.ceil(result.text.length / 4);
  expect(tokens).toBeLessThan(600);
});
```

---

## Sprint 1 Checklist

- [ ] Issue #1: Severity filtering
- [ ] Issue #2: Pattern exclusion
- [ ] Issue #3: DOM context compression
- [ ] Issue #4: Token budget limits
- [ ] Update [CLAUDE.md](./CLAUDE.md) with new tool params
- [ ] Update [README.md](./README.md) FAQ: "How do I reduce token usage?"
- [ ] Run full test suite: `npm test`
- [ ] Manual QA: Long debugging session in Cursor (30+ min)
- [ ] Merge to main, tag `v1.1.0`
- [ ] Publish to npm: `npm publish`
- [ ] Announce in Discord/Twitter: "Context compression is here"

---

## Estimated Impact

**Before:**
- Avg. tool response: 3000 tokens
- Max session before context limit: 15 tool calls
- User complaint: "LLM forgets early context"

**After:**
- Avg. tool response: 1200 tokens
- Max session before context limit: 40+ tool calls
- User feedback: "Mergen never saturates my context window"

**Competitive positioning:**
> "Unlike chrome-devtools-mcp, Mergen is token-budget aware and never saturates your LLM's context window."
