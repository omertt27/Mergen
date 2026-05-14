# Mergen: 90-Day Improvement Plan
**Plan Date:** 2026-05-14  
**Target:** Close critical gaps to reach $50k ARR  
**Status:** Ready for execution

---

## Executive Summary

This plan transforms Mergen from a **technical demo** to a **revenue-generating product** in 90 days by addressing the three critical gaps identified in the strategic analysis:

1. **Distribution** — One-click install vs. manual setup
2. **Detection coverage** — Silent failures, not just crashes  
3. **ROI proof** — Time-saved metrics for enterprise justification

**Expected outcomes:**
- **1,000 weekly active users** (20× current)
- **$5,000 MRR** from 50 paying customers
- **15% free-to-paid conversion**
- **75% avg detector accuracy** (calibration-validated)

---

## Prioritization Matrix

| Initiative | Impact | Effort | Priority | Revenue Unlock |
|-----------|--------|--------|----------|----------------|
| **npm + Chrome Web Store publish** | 🔥 Critical | 2 weeks | **P0** | 10× distribution |
| **Silent failure detectors (×7)** | 🔥 Critical | 4 weeks | **P0** | Differentiation |
| **ROI tracking (/roi endpoint)** | 🔥 Critical | 2 weeks | **P0** | Enterprise justification |
| **Visual context (DOM styles)** | 🟡 High | 3 weeks | **P1** | "Can't see browser" claim |
| **Team sync MVP** | 🟡 High | 4 weeks | **P1** | 13× revenue/cohort |
| **Demo video** | 🟢 Medium | 1 week | **P2** | Viral growth |
| **MCP marketplace listing** | 🟢 Medium | 1 week | **P2** | Legitimacy |

---

## Month 1: Critical Infrastructure (Weeks 1–4)

### Week 1: Distribution Foundation

#### Task 1.1: Publish to npm as standalone binary ⏱️ 3 days

**Goal:** `npx mergen-server` works without git clone

**Implementation:**
```bash
cd server

# 1. Update package.json
npm install --save-dev @vercel/ncc  # bundle dependencies
```

```json
// server/package.json - ADD these fields
{
  "name": "mergen-server",
  "version": "1.0.0",
  "bin": {
    "mergen-server": "./dist/index.js"
  },
  "files": [
    "dist/**/*.js",
    "!dist/**/*.test.js"
  ],
  "scripts": {
    "build": "tsc && ncc build dist/index.js -o standalone",
    "prepublishOnly": "npm run build && npm test"
  }
}
```

**Testing:**
```bash
# Build and test locally
npm link
mergen-server  # should start without errors

# Test installation
cd /tmp
npx mergen-server@latest  # should download and run
```

**Acceptance criteria:**
- [ ] `npx mergen-server` starts HTTP server on port 3000
- [ ] No `node_modules/` required (bundled with ncc)
- [ ] Works on macOS, Linux, Windows (test in CI)
- [ ] `npm install -g mergen-server` registers global bin

**Files to modify:**
- `server/package.json` (bin, files, scripts)
- `server/scripts/build-cli.mjs` (already exists, update for ncc)
- `.github/workflows/publish.yml` (NEW - npm publish on tag)

---

#### Task 1.2: Chrome Web Store submission ⏱️ 4 days

**Goal:** One-click install, auto-updates, no Developer Mode

**Implementation:**

**Step 1: Prepare assets**
```bash
cd extension

# 1. Create promotional images (required by Web Store)
#    - 1280×800 screenshot (main dashboard)
#    - 440×280 small tile
#    - 128×128 icon (already exists in icons/)

# 2. Write store listing copy
```

Create `extension/STORE_LISTING.md`:
```markdown
# Short description (132 chars max)
Stream live browser telemetry to AI assistants. Debug faster with causally-linked console logs, network calls, and DOM state.

# Detailed description
Mergen bridges your Chrome browser and AI IDEs (Cursor, Claude Code, Copilot) with live runtime telemetry. No cloud, no tracking — all data stays on localhost.

**Features:**
• Console log streaming (error/warn/log)
• Network interception (fetch + XHR)
• DOM snapshots at crash time
• localStorage/sessionStorage capture
• Hot-reload detection (Vite, webpack, Next.js)

**How it works:**
1. Install this extension
2. Run `npx mergen-server` in your terminal
3. Ask your AI assistant: "What just broke?"

**Privacy-first:**
• All traffic to 127.0.0.1 only
• Zero external servers
• Open source: github.com/omertt27/Mergen
```

**Step 2: Update manifest for Web Store compliance**
```json
// extension/manifest.json - ENSURE these fields are correct
{
  "name": "Mergen DevTools Bridge",
  "description": "Stream live browser telemetry to AI assistants for faster debugging",
  "version": "1.0.0",
  "permissions": [
    "storage",  // ✓ justified: store port config
    "tabs"      // ✓ justified: detect active tab for mute
  ],
  "host_permissions": [
    "http://127.0.0.1/*"  // ✓ justified: local ingest only
  ],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

**Step 3: Submit**
1. Create Chrome Web Store developer account ($5 one-time fee)
2. Upload ZIP of `extension/` folder
3. Fill in privacy policy URL: `https://mergen.dev/privacy`
4. Submit for review (typical approval: 1–3 days)

**Acceptance criteria:**
- [ ] Published to Chrome Web Store with public URL
- [ ] Extension auto-updates on new version
- [ ] No "Developer Mode" warning in chrome://extensions
- [ ] Privacy policy covers data handling (localhost only)

**Files to create:**
- `extension/STORE_LISTING.md`
- `extension/screenshots/` (3 PNGs for Web Store)
- `docs/PRIVACY_POLICY.md` (host at mergen.dev/privacy)

---

#### Task 1.3: MCP marketplace submission ⏱️ 2 days

**Goal:** Appear in `claude mcp search observability`

**Implementation:**

**Step 1: Create MCP registry PR**
```bash
# Clone the MCP registry (hypothetical — adjust to actual Anthropic repo)
git clone https://github.com/anthropics/mcp-registry
cd mcp-registry

# Add Mergen entry
cat > servers/mergen.json <<EOF
{
  "name": "mergen",
  "description": "Local-first browser observability for AI-assisted debugging. Streams console logs, network calls, and DOM state from your actual Chrome tab into any MCP-compatible IDE.",
  "author": {
    "name": "omertt27",
    "url": "https://github.com/omertt27"
  },
  "repository": "https://github.com/omertt27/Mergen",
  "license": "MIT",
  "categories": ["debugging", "observability", "browser"],
  "install": {
    "npm": "mergen-server"
  },
  "config": {
    "command": "npx",
    "args": ["mergen-server"],
    "transport": "stdio"
  },
  "tools": [
    {
      "name": "quick_check",
      "description": "Instant buffer pulse — errors, warnings, network failures. FREE, no credit cost.",
      "cost": "free"
    },
    {
      "name": "analyze_runtime",
      "description": "Full causal diagnosis: resolves stack frames, traces event dependencies, produces fix hint. Costs 1 credit.",
      "cost": "paid"
    },
    {
      "name": "explain_warning",
      "description": "Explains the most recent console warning before it escalates. FREE.",
      "cost": "free"
    }
  ],
  "links": {
    "homepage": "https://github.com/omertt27/Mergen",
    "documentation": "https://github.com/omertt27/Mergen/blob/main/CLAUDE.md",
    "pricing": "https://mergen.dev/pricing"
  }
}
EOF

git checkout -b add-mergen-server
git add servers/mergen.json
git commit -m "Add Mergen — local-first browser observability"
git push origin add-mergen-server
# Open PR to anthropics/mcp-registry
```

**Acceptance criteria:**
- [ ] PR merged to MCP registry
- [ ] `claude mcp install mergen` works from CLI
- [ ] Appears in MCP marketplace search results
- [ ] Documentation link goes to CLAUDE.md

**Dependencies:**
- Task 1.1 (npm package must exist)
- Anthropic partnership form (if required for marketplace)

---

### Week 2: ROI Metrics Foundation

#### Task 2.1: Time-to-resolution tracking ⏱️ 5 days

**Goal:** Prove "3.2 hours saved per developer per month"

**Implementation:**

**Step 1: Add outcome tracking to usage.ts**
```typescript
// server/src/intelligence/usage.ts - ADD after existing exports

export interface AnalysisOutcome {
  /** Stable ID linking to the analysis that was run */
  analysisId: string;
  /** When analyze_runtime was called (ms since epoch) */
  startedAt: number;
  /** When the user committed a fix (inferred from git) */
  resolvedAt?: number;
  /** resolvedAt - startedAt, in seconds */
  ttrSeconds?: number;
  /** Top hypothesis tag that was shown */
  topHypothesisTag: string;
  /** User verdict (if provided via /feedback) */
  verdict?: 'correct' | 'wrong' | 'partial';
  /** Which file was changed (inferred from git diff) */
  fixedFiles?: string[];
}

const OUTCOMES_FILE = path.join(DATA_DIR, 'outcomes.json');
const MAX_OUTCOMES = 500;  // same ring pattern as calibration.json

interface OutcomesFile {
  version: 1;
  outcomes: AnalysisOutcome[];
}

let _outcomes: AnalysisOutcome[] = [];
let _outcomesLoaded = false;

function loadOutcomes(): void {
  if (_outcomesLoaded) return;
  try {
    if (!fs.existsSync(OUTCOMES_FILE)) { _outcomesLoaded = true; return; }
    const raw = fs.readFileSync(OUTCOMES_FILE, 'utf8');
    const parsed = JSON.parse(raw) as OutcomesFile;
    if (parsed?.version === 1 && Array.isArray(parsed.outcomes)) {
      _outcomes = parsed.slice(-MAX_OUTCOMES);
    }
    _outcomesLoaded = true;
  } catch (err) {
    logger.warn({ err }, 'outcomes: failed to load');
    _outcomes = [];
    _outcomesLoaded = true;
  }
}

function persistOutcomes(): boolean {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload: OutcomesFile = { version: 1, outcomes: _outcomes };
    const tmp = OUTCOMES_FILE + `.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, OUTCOMES_FILE);
    return true;
  } catch (err) {
    logger.warn({ err }, 'outcomes: failed to persist');
    return false;
  }
}

/** Called from tools.ts when analyze_runtime starts */
export function recordAnalysisStart(topHypothesisTag: string): string {
  loadOutcomes();
  const analysisId = randomUUID();
  _outcomes.push({
    analysisId,
    startedAt: Date.now(),
    topHypothesisTag,
  });
  if (_outcomes.length > MAX_OUTCOMES) _outcomes.shift();
  persistOutcomes();
  return analysisId;
}

/** Called from git hook or /resolved endpoint when user commits fix */
export function recordAnalysisResolution(
  analysisId: string,
  fixedFiles: string[],
): boolean {
  loadOutcomes();
  const outcome = _outcomes.find((o) => o.analysisId === analysisId);
  if (!outcome) return false;
  
  outcome.resolvedAt = Date.now();
  outcome.ttrSeconds = Math.floor((outcome.resolvedAt - outcome.startedAt) / 1000);
  outcome.fixedFiles = fixedFiles;
  
  persistOutcomes();
  return true;
}

/** Compute weekly ROI stats for /roi endpoint */
export function getROISnapshot(): {
  weeklyOutcomes: number;
  avgTtrSeconds: number;
  medianTtrSeconds: number;
  accuracyRate: number;
  timeSavedEstimate: number;
} {
  loadOutcomes();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - WEEK_MS;
  
  const recentOutcomes = _outcomes.filter(
    (o) => o.startedAt >= cutoff && o.resolvedAt != null
  );
  
  if (recentOutcomes.length === 0) {
    return {
      weeklyOutcomes: 0,
      avgTtrSeconds: 0,
      medianTtrSeconds: 0,
      accuracyRate: 0,
      timeSavedEstimate: 0,
    };
  }
  
  const ttrs = recentOutcomes.map((o) => o.ttrSeconds!).sort((a, b) => a - b);
  const avgTtr = ttrs.reduce((sum, t) => sum + t, 0) / ttrs.length;
  const medianTtr = ttrs[Math.floor(ttrs.length / 2)];
  
  // Accuracy: what % had verdict === 'correct' or 'partial'
  const withVerdict = recentOutcomes.filter((o) => o.verdict);
  const correctCount = withVerdict.filter(
    (o) => o.verdict === 'correct' || o.verdict === 'partial'
  ).length;
  const accuracyRate = withVerdict.length > 0 ? correctCount / withVerdict.length : 0;
  
  // Time saved: industry avg (15 min) - Mergen avg
  const INDUSTRY_AVG_SECONDS = 15 * 60;
  const savedPerBug = Math.max(0, INDUSTRY_AVG_SECONDS - avgTtr);
  const timeSavedEstimate = savedPerBug * recentOutcomes.length;
  
  return {
    weeklyOutcomes: recentOutcomes.length,
    avgTtrSeconds: Math.round(avgTtr),
    medianTtrSeconds: medianTtr,
    accuracyRate: Math.round(accuracyRate * 100) / 100,
    timeSavedEstimate: Math.round(timeSavedEstimate),
  };
}
```

**Step 2: Add /roi HTTP endpoint**
```typescript
// server/src/routes/roi.ts - NEW FILE

import type { Request, Response } from 'express';
import { getROISnapshot } from '../intelligence/usage.js';

export function handleROI(_req: Request, res: Response): void {
  const roi = getROISnapshot();
  
  const hoursPerWeek = Math.round((roi.timeSavedEstimate / 3600) * 10) / 10;
  const hoursPerMonth = Math.round((hoursPerWeek * 4.33) * 10) / 10;
  
  res.json({
    period: 'last-7-days',
    outcomes: roi.weeklyOutcomes,
    avgTtrSeconds: roi.avgTtrSeconds,
    medianTtrSeconds: roi.medianTtrSeconds,
    accuracyRate: roi.accuracyRate,
    timeSavedSeconds: roi.timeSavedEstimate,
    timeSavedHoursPerWeek: hoursPerWeek,
    timeSavedHoursPerMonth: hoursPerMonth,
    message:
      hoursPerMonth >= 3.2
        ? `✅ You saved ${hoursPerMonth} hours this month — justifies a $${Math.round(hoursPerMonth * 100)}/mo tool cost.`
        : `⏱️ ${roi.weeklyOutcomes} bugs fixed this week. Keep using Mergen to see ROI trends.`,
  });
}
```

**Step 3: Register route in app.ts**
```typescript
// server/src/app.ts - ADD after existing routes

import { handleROI } from './routes/roi.js';

export function createApp(opts: CreateAppOptions): Express {
  const app = express();
  
  // ... existing routes ...
  
  app.get('/roi', handleROI);
  
  return app;
}
```

**Step 4: Infer resolution from git commits**
```typescript
// server/src/sensor/git-watcher.ts - NEW FILE

import fs from 'fs';
import path from 'path';
import { recordAnalysisResolution } from '../intelligence/usage.js';
import logger from './logger.js';

const GIT_REFLOG = path.join(process.cwd(), '.git/logs/HEAD');

let _lastCommitSha: string | null = null;
let _watchInterval: ReturnType<typeof setInterval> | null = null;
let _pendingAnalysisId: string | null = null;

/** Called from tools.ts after analyze_runtime returns */
export function setPendingAnalysis(analysisId: string): void {
  _pendingAnalysisId = analysisId;
}

export function startGitWatcher(): void {
  if (!fs.existsSync(GIT_REFLOG)) {
    logger.info('git reflog not found — TTR tracking disabled (not in a git repo)');
    return;
  }
  
  _watchInterval = setInterval(() => {
    try {
      const lines = fs.readFileSync(GIT_REFLOG, 'utf8').trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) return;
      
      const sha = lastLine.split(' ')[1];
      if (sha === _lastCommitSha) return;  // no new commit
      
      _lastCommitSha = sha;
      
      // If there's a pending analysis, mark it resolved
      if (_pendingAnalysisId) {
        const fixedFiles = extractChangedFiles(sha);
        const resolved = recordAnalysisResolution(_pendingAnalysisId, fixedFiles);
        if (resolved) {
          logger.info({ analysisId: _pendingAnalysisId, sha }, 'TTR: analysis resolved by commit');
        }
        _pendingAnalysisId = null;
      }
    } catch (err) {
      logger.warn({ err }, 'git watcher tick failed');
    }
  }, 2000);
  
  if (typeof _watchInterval.unref === 'function') _watchInterval.unref();
  logger.info('git watcher started (TTR tracking enabled)');
}

export function stopGitWatcher(): void {
  if (_watchInterval) {
    clearInterval(_watchInterval);
    _watchInterval = null;
  }
}

function extractChangedFiles(sha: string): string[] {
  try {
    const { execSync } = require('child_process');
    const output = execSync(`git diff-tree --no-commit-id --name-only -r ${sha}`, {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
```

**Step 5: Wire up in index.ts**
```typescript
// server/src/index.ts - ADD after startWatcher()

import { startGitWatcher } from './sensor/git-watcher.js';

async function main() {
  // ... existing setup ...
  
  startWatcher();
  startGitWatcher();  // ← NEW
  
  // ... shutdown handlers ...
}
```

**Step 6: Update tools.ts to record analysis start**
```typescript
// server/src/intelligence/tools.ts - MODIFY analyze_runtime

import { recordAnalysisStart } from './usage.js';
import { setPendingAnalysis } from '../sensor/git-watcher.js';

server.registerTool('analyze_runtime', { /* ... */ }, async ({ focus, since }) => {
  // ... existing credit gate ...
  
  const causal = await buildCausalChain(logs, network, contexts, since);
  
  const topTag = causal.hypotheses[0]?.tag ?? 'no_hypothesis';
  const analysisId = recordAnalysisStart(topTag);
  setPendingAnalysis(analysisId);  // mark as pending for git watcher
  
  return { content: [{ type: 'text', text: causal.contextPack + usageFooter }] };
});
```

**Acceptance criteria:**
- [ ] `/roi` endpoint returns JSON with time saved estimate
- [ ] Git commits auto-resolve pending analyses (TTR captured)
- [ ] `outcomes.json` persists in `~/.mergen/` (bounded ring, 500 max)
- [ ] ROI message shows "✅ You saved X hours" when X >= 3.2

**Testing:**
```bash
# Start server
npm start

# In another terminal, run analyze_runtime via MCP
claude mcp call mergen analyze_runtime

# Make a code fix and commit
git add src/fix.ts
git commit -m "fix: auth token persistence"

# Check ROI
curl -s http://127.0.0.1:3000/roi | jq
# Should show ttrSeconds for the analysis
```

---

### Weeks 3–4: Silent Failure Detectors

#### Task 3.1: Implement 7 new detectors ⏱️ 10 days

**Goal:** Catch runtime issues that don't throw errors

**Detector 1: `infinite_loop_ui_freeze`**
```typescript
// server/src/intelligence/detectors.ts - ADD after existing detectors

/**
 * Detector H: Infinite loop or unthrottled state updates causing UI freeze.
 * 
 * Signature: no new events in buffer for 5+ seconds, but the tab is still
 * active (last event timestamp is recent). Combined with watcher seeing no
 * activity despite the page being "running".
 * 
 * Common causes:
 *   - while(true) loop in JS
 *   - React setState called in render (infinite render loop)
 *   - Recursive component nesting
 * 
 * Note: This detector only fires on baseline diagnostics (primaryErr === null)
 * because by definition an infinite loop prevents errors from being logged.
 */
export function detectInfiniteLoopUIFreeze(d: DetectorInput): Hypothesis | null {
  // Only fire on baseline runs (pageload, periodic, etc.)
  if (d.primaryErr !== null) return null;
  
  // Check: has there been any console activity in the last 30 seconds?
  const now = Date.now();
  const recentLogs = d.chain.filter((ev) => now - ev.ts < 30_000);
  if (recentLogs.length > 0) return null;  // still active
  
  // Check: are there repeated identical log messages (sign of loop)?
  const logMessages = d.chain
    .filter((ev) => ev.kind === 'log' || ev.kind === 'warn')
    .map((ev) => ev.summary);
  
  const counts = new Map<string, number>();
  for (const msg of logMessages) {
    counts.set(msg, (counts.get(msg) ?? 0) + 1);
  }
  
  const maxRepeats = Math.max(...counts.values());
  if (maxRepeats < 10) return null;  // threshold: 10+ identical logs
  
  const repeatedMsg = [...counts.entries()].find(([, count]) => count === maxRepeats)?.[0];
  
  let score = 0.40;
  if (maxRepeats > 50) score += 0.20;  // very high repeat count
  const confidence = scoreToConfidence(score);
  if (confidence === 'INSUFFICIENT') return null;
  
  return {
    tag: 'infinite_loop_ui_freeze',
    summary: `UI may be frozen by an infinite loop — "${repeatedMsg}" logged ${maxRepeats}× in rapid succession.`,
    confidence,
    confidenceScore: score,
    evidence: [
      `Console log "${repeatedMsg}" repeated ${maxRepeats} times.`,
      `No new events in the last 30 seconds despite page being active.`,
    ],
    causalPath: [
      `Code path logs "${repeatedMsg}" on every iteration`,
      `Loop has no exit condition or setState is called in render`,
      `Browser event loop is blocked — UI freezes, no errors thrown`,
    ],
    fixHint: `Add a counter guard: \`if (++iterations > 100) throw new Error('loop runaway')\` or move setState out of the render path.`,
  };
}
```

**Detector 2: `promise_swallowed`**
```typescript
/**
 * Detector I: Promise rejection swallowed by empty catch.
 * 
 * Signature: Network call failed (4xx/5xx) but no corresponding error event
 * was logged. Common when developers write `.catch(() => {})` or forget to
 * attach a rejection handler.
 * 
 * Result: Button does nothing, API call fails silently.
 */
export function detectPromiseSwallowed(d: DetectorInput): Hypothesis | null {
  // Can fire on both error and baseline runs
  const failedCalls = d.correlatedNetwork.filter(
    (n) => n.status >= 400 || n.status === 0 || !!n.error
  );
  if (failedCalls.length === 0) return null;
  
  // Check: did any of these failed calls result in a logged error?
  for (const call of failedCalls) {
    const hasErrorLog = d.chain.some((ev) => {
      if (ev.kind !== 'error') return false;
      // Heuristic: error message contains the failed URL or status code
      return ev.summary.includes(call.url) || ev.summary.includes(String(call.status));
    });
    
    if (!hasErrorLog) {
      // Found a failed call with no corresponding error — likely swallowed
      let score = 0.45;
      if (call.status >= 500) score += 0.15;  // server errors should always be logged
      const confidence = scoreToConfidence(score);
      if (confidence === 'INSUFFICIENT') return null;
      
      return {
        tag: 'promise_swallowed',
        summary: `\`${call.method} ${call.url}\` failed with ${call.status} but no error was logged — promise rejection may be swallowed.`,
        confidence,
        confidenceScore: score,
        evidence: [
          `\`${call.method} ${call.url}\` → ${call.status} ${call.statusText}`,
          `No console.error logged for this failed request.`,
          `Likely cause: \`.catch(() => {})\` or missing rejection handler.`,
        ],
        causalPath: [
          `${call.method} ${call.url} → ${call.status}`,
          `Promise is rejected but no .catch() or async/await try/catch`,
          `Rejection is swallowed by empty catch block or ignored`,
          `User sees "button does nothing" — no visible error`,
        ],
        fixHint: `Add explicit error handling: \`fetch('${call.url}').catch(err => console.error('Fetch failed:', err))\` or use \`try/catch\` in async functions.`,
      };
    }
  }
  
  return null;
}
```

**Detector 3: `cors_blocked_silent`**
```typescript
/**
 * Detector J: CORS preflight failure (silent in console).
 * 
 * Signature: Network call has status 0 (network error) and error message
 * contains "CORS" or "preflight", OR we see an OPTIONS request immediately
 * before a failed POST/PUT/DELETE.
 */
export function detectCORSBlockedSilent(d: DetectorInput): Hypothesis | null {
  const networkErrors = d.correlatedNetwork.filter((n) => n.status === 0 && n.error);
  
  for (const call of networkErrors) {
    const isCORS =
      call.error?.toLowerCase().includes('cors') ||
      call.error?.toLowerCase().includes('preflight') ||
      call.error?.toLowerCase().includes('access-control');
    
    if (isCORS) {
      let score = 0.55;
      const confidence = scoreToConfidence(score);
      if (confidence === 'INSUFFICIENT') return null;
      
      return {
        tag: 'cors_blocked_silent',
        summary: `\`${call.method} ${call.url}\` blocked by CORS policy — server did not return correct Access-Control headers.`,
        confidence,
        confidenceScore: score,
        evidence: [
          `Network error: "${call.error}"`,
          `Status 0 indicates CORS preflight failure.`,
        ],
        causalPath: [
          `Browser sends OPTIONS preflight to ${call.url}`,
          `Server does not respond with Access-Control-Allow-Origin`,
          `Browser blocks the actual ${call.method} request`,
          `Fetch fails with status 0, often no console error`,
        ],
        fixHint: `On the server, add CORS headers: \`Access-Control-Allow-Origin: *\` (or specific origin) and \`Access-Control-Allow-Methods: ${call.method}\`.`,
      };
    }
  }
  
  return null;
}
```

**Detector 4: `stale_closure_state`**
```typescript
/**
 * Detector K: Stale closure capturing old state (React useState).
 * 
 * Signature: Console log shows a state variable's value is stale (common in
 * useEffect or event handlers that close over the initial render's state).
 * 
 * Heuristic: Look for log messages like "count: 0" repeated multiple times
 * when the user expects it to increment. This is weak signal but worth
 * surfacing at LOW confidence.
 */
export function detectStaleClosureState(d: DetectorInput): Hypothesis | null {
  // Only fire when there's an error or warning
  if (!d.primaryErr && d.chain.every((ev) => ev.kind !== 'warn')) return null;
  
  // Check: are there console.log messages showing the same value repeatedly?
  const logValues = d.chain
    .filter((ev) => ev.kind === 'log')
    .map((ev) => ev.summary);
  
  const repeatedValues = logValues.filter(
    (val, idx) => idx > 0 && val === logValues[idx - 1]
  );
  
  if (repeatedValues.length < 3) return null;  // need at least 3 consecutive identical logs
  
  const score = 0.30;  // low confidence — this is a heuristic
  const confidence = scoreToConfidence(score);
  if (confidence === 'INSUFFICIENT') return null;
  
  return {
    tag: 'stale_closure_state',
    summary: `State variable may be stale due to closure capture — same value "${repeatedValues[0]}" logged multiple times.`,
    confidence,
    confidenceScore: score,
    evidence: [
      `Console logs show repeated value: "${repeatedValues[0]}"`,
      `Common in React useEffect or event handlers that close over initial state.`,
    ],
    causalPath: [
      `useEffect or event handler is defined with state variable in dependency array`,
      `State updates but the closure still references the old value from first render`,
      `Code reads stale value, leading to unexpected behavior`,
    ],
    fixHint: `Use functional setState: \`setCount(prev => prev + 1)\` instead of \`setCount(count + 1)\`, or add the state var to the dependency array.`,
  };
}
```

**Detector 5: `hydration_mismatch`**
```typescript
/**
 * Detector L: SSR/CSR hydration mismatch (React/Next.js).
 * 
 * Signature: Console warning contains "hydration" or "did not match".
 */
export function detectHydrationMismatch(d: DetectorInput): Hypothesis | null {
  const warnings = d.chain.filter((ev) => ev.kind === 'warn');
  
  for (const warn of warnings) {
    const msg = warn.summary.toLowerCase();
    const isHydration =
      msg.includes('hydration') ||
      msg.includes('did not match') ||
      msg.includes('server html');
    
    if (isHydration) {
      let score = 0.60;
      const confidence = scoreToConfidence(score);
      
      return {
        tag: 'hydration_mismatch',
        summary: `SSR/CSR hydration mismatch detected — server-rendered HTML differs from client render.`,
        confidence,
        confidenceScore: score,
        evidence: [
          `Console warning: "${warn.summary}"`,
          `Common in Next.js/React when Date.now() or random values are used during SSR.`,
        ],
        causalPath: [
          `Component renders on server with dynamic value (timestamp, random, etc.)`,
          `Client re-renders with different value`,
          `React detects mismatch and warns`,
          `User sees flash of wrong content or layout shift`,
        ],
        fixHint: `Move dynamic values to useEffect (client-only): \`useEffect(() => setTimestamp(Date.now()), [])\` or use suppressHydrationWarning prop.`,
      };
    }
  }
  
  return null;
}
```

**Detector 6: `duplicate_render_cascade`**
```typescript
/**
 * Detector M: Component renders 50+ times in 1 second (render cascade).
 * 
 * Signature: High volume of console.log calls in a short time, OR the
 * watcher sees >100 events ingested in <1 second.
 */
export function detectDuplicateRenderCascade(d: DetectorInput): Hypothesis | null {
  // Count events in the last 1 second
  const now = Date.now();
  const WINDOW_MS = 1000;
  const recentEvents = d.chain.filter((ev) => now - ev.ts < WINDOW_MS);
  
  if (recentEvents.length < 50) return null;
  
  let score = 0.45;
  if (recentEvents.length > 100) score += 0.15;
  const confidence = scoreToConfidence(score);
  if (confidence === 'INSUFFICIENT') return null;
  
  return {
    tag: 'duplicate_render_cascade',
    summary: `${recentEvents.length} events fired in 1 second — likely render cascade from state updates triggering re-renders.`,
    confidence,
    confidenceScore: score,
    evidence: [
      `${recentEvents.length} console events in the last second.`,
      `Common when setState is called during render or in useEffect without deps.`,
    ],
    causalPath: [
      `Component calls setState during render`,
      `Triggers re-render, which calls setState again`,
      `Infinite or near-infinite loop until React bails out`,
      `CPU spike, sluggish UI, potential crash`,
    ],
    fixHint: `Move setState to an event handler or useEffect with proper dependencies. Check for \`setState()\` calls in the render body.`,
  };
}
```

**Detector 7: `memory_leak_component`**
```typescript
/**
 * Detector N: Memory leak from unmounted component still subscribed.
 * 
 * Signature: Console warning "Can't perform a React state update on an
 * unmounted component" (React 17+) or similar. This is a weak signal but
 * worth surfacing.
 */
export function detectMemoryLeakComponent(d: DetectorInput): Hypothesis | null {
  const warnings = d.chain.filter((ev) => ev.kind === 'warn');
  
  for (const warn of warnings) {
    const msg = warn.summary.toLowerCase();
    const isMemoryLeak =
      msg.includes('unmounted component') ||
      msg.includes('memory leak') ||
      msg.includes('state update on unmounted');
    
    if (isMemoryLeak) {
      const score = 0.50;
      const confidence = scoreToConfidence(score);
      
      return {
        tag: 'memory_leak_component',
        summary: `Memory leak detected — component is unmounted but still has active subscriptions or timers.`,
        confidence,
        confidenceScore: score,
        evidence: [
          `Console warning: "${warn.summary}"`,
          `Common when useEffect cleanup function is missing.`,
        ],
        causalPath: [
          `Component mounts and subscribes to event/timer/websocket`,
          `Component unmounts but subscription is not cleaned up`,
          `Event fires, tries to call setState on unmounted component`,
          `Memory leak: component stays in memory, multiple instances accumulate`,
        ],
        fixHint: `Add cleanup in useEffect: \`useEffect(() => { const sub = subscribe(); return () => sub.unsubscribe(); }, [])\`.`,
      };
    }
  }
  
  return null;
}
```

**Step 2: Register new detectors**
```typescript
// server/src/intelligence/detectors.ts - UPDATE ALL_DETECTORS array

export const ALL_DETECTORS = [
  detectAuthTokenNotPersisted,
  detectTokenOverwrite,
  detectFailedRequestCausedCrash,
  detectNullStorageKey,
  detectWarningBeforeError,
  detectSlowApiSilent,
  detectEmptyResponseSilent,
  // NEW silent-failure detectors
  detectInfiniteLoopUIFreeze,
  detectPromiseSwallowed,
  detectCORSBlockedSilent,
  detectStaleClosureState,
  detectHydrationMismatch,
  detectDuplicateRenderCascade,
  detectMemoryLeakComponent,
] as const;
```

**Acceptance criteria:**
- [ ] 7 new detectors added to `detectors.ts`
- [ ] ALL_DETECTORS array updated
- [ ] Each detector has unit test in `detectors.test.ts`
- [ ] Calibration system tracks accuracy for all 14 detectors

**Testing:**
```typescript
// server/src/intelligence/__tests__/silent-detectors.test.ts

import { describe, it, expect } from 'vitest';
import {
  detectInfiniteLoopUIFreeze,
  detectPromiseSwallowed,
  detectCORSBlockedSilent,
  type DetectorInput,
} from '../detectors.js';

describe('Silent failure detectors', () => {
  it('detectInfiniteLoopUIFreeze: repeated logs', () => {
    const input: DetectorInput = {
      primaryErr: null,  // baseline run
      stateAtError: null,
      correlatedNetwork: [],
      chain: Array(50).fill(null).map((_, i) => ({
        ts: Date.now() - (50 - i) * 100,
        isoTs: new Date().toISOString(),
        kind: 'log' as const,
        summary: 'Fetching user data...',  // same message 50 times
      })),
    };
    
    const hyp = detectInfiniteLoopUIFreeze(input);
    expect(hyp).not.toBeNull();
    expect(hyp?.tag).toBe('infinite_loop_ui_freeze');
    expect(hyp?.confidence).toBeOneOf(['MEDIUM', 'HIGH']);
  });
  
  it('detectPromiseSwallowed: network fail, no error log', () => {
    const input: DetectorInput = {
      primaryErr: null,
      stateAtError: null,
      correlatedNetwork: [{
        method: 'POST',
        url: '/api/login',
        status: 401,
        statusText: 'Unauthorized',
        durationMs: 234,
        requestBody: {},
        requestHeaders: {},
        responseBody: { error: 'Invalid credentials' },
        responseHeaders: {},
        error: null,
        msBeforeError: null,
        isoTs: new Date().toISOString(),
      }],
      chain: [],  // No error event logged
    };
    
    const hyp = detectPromiseSwallowed(input);
    expect(hyp).not.toBeNull();
    expect(hyp?.tag).toBe('promise_swallowed');
    expect(hyp?.summary).toContain('no error was logged');
  });
});
```

---

## Month 2: Visual Context & User Experience (Weeks 5–8)

### Week 5: DOM Visual State

#### Task 4.1: Capture computed styles ⏱️ 3 days

**Implementation:**
```javascript
// extension/src/content.js - MODIFY captureStorage()

function captureVisualContext() {
  try {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      return { activeElement: null };
    }
    
    const computed = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    
    // Extract key style properties that affect visibility
    const relevantStyles = {
      display: computed.display,
      visibility: computed.visibility,
      opacity: computed.opacity,
      position: computed.position,
      zIndex: computed.zIndex,
      width: computed.width,
      height: computed.height,
    };
    
    const isVisible =
      computed.display !== 'none' &&
      computed.visibility !== 'hidden' &&
      parseFloat(computed.opacity) > 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0;
    
    return {
      activeElement: {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        className: el.className || null,
        text: el.textContent?.slice(0, 50) || null,
        styles: relevantStyles,
        boundingBox: {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        isVisible,
        inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    };
  } catch (err) {
    return { activeElement: null, error: 'capture failed' };
  }
}

// UPDATE postContext() to use new function
function postContext(trigger) {
  try {
    const visual = captureVisualContext();
    post({
      type: 'context',
      trigger: trigger,
      timestamp: Date.now(),
      url: window.location.href,
      title: document.title,
      ...visual,  // spread activeElement and viewport
      component: detectComponent(),
      localStorage: captureStorage(window.localStorage),
      sessionStorage: captureStorage(window.sessionStorage),
    });
  } catch { /* never break the page */ }
}
```

**Update server types:**
```typescript
// server/src/sensor/buffer.ts - MODIFY ContextSnapshot interface

export interface ContextSnapshot {
  type: 'context';
  trigger: string;
  timestamp: number;
  url: string;
  title: string;
  activeElement: {
    tag: string;
    id: string | null;
    className: string | null;
    text: string | null;
    styles: {
      display: string;
      visibility: string;
      opacity: string;
      position: string;
      zIndex: string;
      width: string;
      height: string;
    };
    boundingBox: {
      top: number;
      left: number;
      width: number;
      height: number;
    };
    isVisible: boolean;
    inViewport: boolean;
  } | null;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  component?: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}
```

**Acceptance criteria:**
- [ ] Context snapshots include `activeElement.styles`
- [ ] `isVisible` flag correctly detects hidden elements
- [ ] Context Pack S5 shows "Element is off-screen" when not in viewport

---

### Week 6: Screenshot capture (Phase 2)

#### Task 4.2: Capture screenshots on error ⏱️ 4 days

**Implementation:**

**Step 1: Add screenshot capture to background.js**
```javascript
// extension/src/background.js - ADD screenshot handler

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_SCREENSHOT') {
    chrome.tabs.captureVisibleTab(
      sender.tab.windowId,
      { format: 'png', quality: 80 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ dataUrl });
        }
      }
    );
    return true;  // async response
  }
});
```

**Step 2: Trigger screenshot on error in content.js**
```javascript
// extension/src/content.js - MODIFY patchConsole('error')

function patchConsole(level) {
  const orig = _origConsole[level];
  console[level] = function mergenConsole() {
    orig.apply(console, arguments);
    try {
      const stack = (new Error().stack || '').split('\n').slice(2).join('\n');
      
      // Post the error event first
      post({
        type: 'console',
        level: level,
        args: safeArgs(arguments),
        stack: stack,
        url: window.location.href,
        timestamp: Date.now(),
      });
      
      // NEW: Capture screenshot on error (async, fire-and-forget)
      if (level === 'error') {
        chrome.runtime.sendMessage(
          { type: 'CAPTURE_SCREENSHOT' },
          (response) => {
            if (response?.dataUrl) {
              // Post screenshot as separate event
              post({
                type: 'screenshot',
                timestamp: Date.now(),
                dataUrl: response.dataUrl,  // base64 PNG
              });
            }
          }
        );
        postContext('error');
      }
      // ... rest of existing code
    } catch { /* never break the page */ }
  };
}
```

**Step 3: Store screenshots in buffer**
```typescript
// server/src/sensor/buffer.ts - ADD screenshot event type

export interface ScreenshotEvent {
  type: 'screenshot';
  timestamp: number;
  dataUrl: string;  // base64-encoded PNG
}

export type IngestEvent =
  | ConsoleEvent
  | NetworkEvent
  | ContextSnapshot
  | ScreenshotEvent;  // ← NEW

// MODIFY RingBuffer to store last screenshot
class RingBuffer {
  // ... existing code ...
  
  private _lastScreenshot: ScreenshotEvent | null = null;
  
  add(event: IngestEvent): void {
    if (event.type === 'screenshot') {
      this._lastScreenshot = event;  // don't add to main ring, store separately
      return;
    }
    // ... existing ring logic
  }
  
  getLastScreenshot(): ScreenshotEvent | null {
    return this._lastScreenshot;
  }
  
  clear(): void {
    // ... existing clear
    this._lastScreenshot = null;
  }
}
```

**Step 4: Include screenshot in Context Pack**
```typescript
// server/src/intelligence/format-context-pack.ts - MODIFY S5 DOM Trace section

// ADD after existing DOM Trace section
if (c.screenshot) {
  lines.push('');
  lines.push('**Screenshot at crash time:**');
  lines.push('');
  lines.push(`![Screenshot](${c.screenshot.dataUrl})`);
  lines.push('');
  lines.push('> 💡 Claude can read this image. Ask: "Why is my button invisible in this screenshot?"');
}
```

**Step 5: Update CausalChain type**
```typescript
// server/src/intelligence/causal.ts - MODIFY CausalChain interface

export interface CausalChain {
  // ... existing fields
  screenshot: ScreenshotEvent | null;  // ← NEW
}

// MODIFY buildCausalChain to fetch screenshot
export async function buildCausalChain(
  logs: ConsoleEvent[],
  network: NetworkEvent[],
  contexts: ContextSnapshot[],
  since?: number
): Promise<CausalChain> {
  // ... existing code
  
  const screenshot = store.getLastScreenshot();
  
  return {
    capturedAt: isoTs(Date.now()),
    totalEvents: store.size(),
    errors: errorBlocks,
    chain,
    stateAtError,
    correlatedNetwork,
    hypotheses: active,
    suppressedHypotheses: suppressed.map(/* ... */),
    screenshot,  // ← NEW
    contextPack: formatContextPack({ /* ... */, screenshot }),
  };
}
```

**Acceptance criteria:**
- [ ] Screenshots captured on console.error (max 1 per error)
- [ ] Base64 PNG embedded in Context Pack markdown
- [ ] Claude Code can view the image when calling `analyze_runtime`
- [ ] Screenshot cleared on buffer clear

**Testing:**
```javascript
// In browser console, trigger error
console.error('Test error');

// Check server buffer
fetch('http://127.0.0.1:3000/roi').then(r => r.json()).then(console.log);
// Should include screenshot dataUrl
```

---

### Week 7–8: User Feedback Loop

#### Task 5.1: Auto-prompt for feedback in Context Pack ⏱️ 3 days

**Goal:** Close the calibration loop by prompting users to rate hypotheses

**Implementation:**

**Step 1: Add feedback prompt to Context Pack**
```typescript
// server/src/intelligence/format-context-pack.ts - ADD after S7

// ── S8 FEEDBACK PROMPT (after diagnosis)
if (c.hypotheses.length > 0) {
  const topHyp = c.hypotheses[0];
  if (topHyp.pid) {  // only if calibration is tracking this
    lines.push('');
    lines.push('---');
    lines.push('#### S8 · Rate This Diagnosis');
    lines.push('');
    lines.push(`> **Was this diagnosis helpful?**`);
    lines.push(`> The system learns from your feedback to improve future diagnoses.`);
    lines.push('');
    lines.push('**To rate this hypothesis:**');
    lines.push('```bash');
    lines.push(`curl -X POST http://127.0.0.1:3000/feedback \\`);
    lines.push(`  -H 'Content-Type: application/json' \\`);
    lines.push(`  -d '{"pid": "${topHyp.pid}", "verdict": "correct"}'`);
    lines.push('```');
    lines.push('');
    lines.push('**Verdict options:** `correct` | `wrong` | `partial`');
    lines.push('');
    lines.push('**Optional note (if wrong):**');
    lines.push('```bash');
    lines.push(`curl -X POST http://127.0.0.1:3000/feedback \\`);
    lines.push(`  -H 'Content-Type: application/json' \\`);
    lines.push(`  -d '{"pid": "${topHyp.pid}", "verdict": "wrong", "note": "URL was incorrect"}'`);
    lines.push('```');
  }
}
```

**Step 2: Build feedback UI in popup.html**
```html
<!-- extension/popup.html - ADD feedback section -->

<div id="feedback-section" style="display: none;">
  <h3>Rate Recent Diagnosis</h3>
  <div id="pending-feedback"></div>
</div>

<script>
// Fetch pending feedback from server
fetch('http://127.0.0.1:3000/calibration/pending')
  .then(r => r.json())
  .then(data => {
    if (data.pending.length === 0) {
      document.getElementById('feedback-section').style.display = 'none';
      return;
    }
    
    document.getElementById('feedback-section').style.display = 'block';
    const container = document.getElementById('pending-feedback');
    
    data.pending.forEach(p => {
      const div = document.createElement('div');
      div.className = 'feedback-card';
      div.innerHTML = `
        <p><strong>${p.tag}</strong></p>
        <p>${new Date(p.predictedAt).toLocaleString()}</p>
        <button onclick="rateDiagnosis('${p.pid}', 'correct')">✅ Correct</button>
        <button onclick="rateDiagnosis('${p.pid}', 'partial')">🟡 Partially</button>
        <button onclick="rateDiagnosis('${p.pid}', 'wrong')">❌ Wrong</button>
      `;
      container.appendChild(div);
    });
  });

window.rateDiagnosis = (pid, verdict) => {
  fetch('http://127.0.0.1:3000/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid, verdict }),
  })
  .then(() => {
    alert('Thanks for the feedback!');
    location.reload();  // refresh to show next pending
  });
};
</script>
```

**Step 3: Add /calibration/pending endpoint**
```typescript
// server/src/routes/calibration.ts - ADD pending endpoint

import { getPendingFeedback } from '../intelligence/calibration.js';

export function handleCalibrationPending(_req: Request, res: Response): void {
  const pending = getPendingFeedback(20);
  res.json({ pending });
}

// Register in app.ts
app.get('/calibration/pending', handleCalibrationPending);
```

**Acceptance criteria:**
- [ ] Context Pack includes feedback instructions (S8)
- [ ] Extension popup shows pending diagnoses
- [ ] One-click feedback buttons work
- [ ] Calibration stats update after feedback

---

## Month 3: Team Features MVP (Weeks 9–12)

### Week 9–10: Shared Calibration

#### Task 6.1: Team sync backend ⏱️ 6 days

**Goal:** Aggregate calibration data across team members

**Implementation:**

**Step 1: Create S3 upload function**
```typescript
// server/src/intelligence/team.ts - REPLACE stub with real implementation

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../sensor/paths.js';
import { getRecords, exportCsv } from './calibration.js';
import logger from '../sensor/logger.js';

const TEAM_SYNC_FILE = path.join(DATA_DIR, 'team-sync.json');

interface TeamSyncConfig {
  enabled: boolean;
  licenseKey: string;
  lastSyncAt: number;
}

let _teamConfig: TeamSyncConfig | null = null;

export async function initTeam(): Promise<void> {
  try {
    if (!fs.existsSync(TEAM_SYNC_FILE)) return;
    const raw = fs.readFileSync(TEAM_SYNC_FILE, 'utf8');
    _teamConfig = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err }, 'team: failed to load config');
  }
}

export function isTeamSyncEnabled(): boolean {
  return _teamConfig?.enabled ?? false;
}

/**
 * Upload local calibration.json to team bucket.
 * Called from a background interval (every 5 minutes) when team sync is enabled.
 */
export async function syncCalibrationToTeam(): Promise<void> {
  if (!isTeamSyncEnabled()) return;
  
  try {
    const records = getRecords();
    const licenseKey = _teamConfig!.licenseKey;
    
    // POST to mergen.dev/api/team/calibration
    const response = await fetch('https://mergen.dev/api/team/calibration', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${licenseKey}`,
      },
      body: JSON.stringify({
        records,
        uploadedAt: Date.now(),
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status}`);
    }
    
    _teamConfig!.lastSyncAt = Date.now();
    fs.writeFileSync(TEAM_SYNC_FILE, JSON.stringify(_teamConfig), 'utf8');
    
    logger.info('team: calibration synced to team bucket');
  } catch (err) {
    logger.warn({ err }, 'team: calibration sync failed');
  }
}

/**
 * Download aggregated calibration stats from team bucket.
 * Merges remote stats with local stats (remote takes precedence when
 * sample size is larger).
 */
export async function fetchTeamCalibration(): Promise<any> {
  if (!isTeamSyncEnabled()) return null;
  
  try {
    const licenseKey = _teamConfig!.licenseKey;
    const response = await fetch('https://mergen.dev/api/team/calibration', {
      headers: { 'Authorization': `Bearer ${licenseKey}` },
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data.aggregatedStats;  // TagStats[] from all team members
  } catch (err) {
    logger.warn({ err }, 'team: fetch failed');
    return null;
  }
}
```

**Step 2: Merge team stats into local calibration**
```typescript
// server/src/intelligence/calibration.ts - MODIFY getStats()

import { fetchTeamCalibration } from './team.js';

export function getStats(): TagStats[] {
  load();
  if (_statsCache) return _statsCache;
  
  const localStats = computeLocalStats();  // existing logic extracted to helper
  
  // If team sync is enabled, merge remote stats
  const teamStats = fetchTeamCalibration();
  if (teamStats) {
    const merged = mergeStats(localStats, teamStats);
    _statsCache = merged;
    return merged;
  }
  
  _statsCache = localStats;
  return localStats;
}

function mergeStats(local: TagStats[], remote: TagStats[]): TagStats[] {
  const byTag = new Map<string, TagStats>();
  
  // Start with local stats
  for (const s of local) byTag.set(s.tag, s);
  
  // Merge remote stats (prefer remote if it has more verdicts)
  for (const r of remote) {
    const l = byTag.get(r.tag);
    if (!l || r.verdicts > l.verdicts) {
      byTag.set(r.tag, r);  // remote has more data, use it
    }
  }
  
  return [...byTag.values()].sort((a, b) => b.predictions - a.predictions);
}
```

**Step 3: Start sync interval in index.ts**
```typescript
// server/src/index.ts - ADD team sync interval

import { syncCalibrationToTeam, isTeamSyncEnabled } from './intelligence/team.js';

async function main() {
  // ... existing setup ...
  
  // Team sync: upload calibration every 5 minutes (if enabled)
  if (isTeamSyncEnabled()) {
    setInterval(() => {
      syncCalibrationToTeam().catch((err) =>
        logger.warn({ err}, 'team sync failed')
      );
    }, 5 * 60 * 1000).unref();
  }
  
  // ... rest of main
}
```

**Acceptance criteria:**
- [ ] Team sync uploads calibration.json every 5 min (if enabled)
- [ ] `getStats()` returns merged local + remote stats
- [ ] Remote stats take precedence when verdict count is higher
- [ ] Sync is opt-in (enabled via license activation)

---

### Week 11–12: Team Insights Dashboard

#### Task 6.2: Build /team/insights endpoint ⏱️ 5 days

**Implementation:**

```typescript
// server/src/routes/team-insights.ts - NEW FILE

import type { Request, Response } from 'express';
import { getStats, getRecords } from '../intelligence/calibration.js';
import { getROISnapshot } from '../intelligence/usage.js';
import { isTeamSyncEnabled } from '../intelligence/team.js';

export function handleTeamInsights(_req: Request, res: Response): void {
  if (!isTeamSyncEnabled()) {
    res.status(403).json({ error: 'Team insights require a Team plan' });
    return;
  }
  
  const stats = getStats();  // merged local + remote
  const records = getRecords();
  const roi = getROISnapshot();
  
  // Top detectors by accuracy (trusted only)
  const topDetectors = stats
    .filter((s) => s.trusted)
    .sort((a, b) => b.accuracy - a.accuracy)
    .slice(0, 10)
    .map((s) => ({
      tag: s.tag,
      accuracy: Math.round(s.accuracy * 100),
      predictions: s.predictions,
      verdicts: s.verdicts,
    }));
  
  // Common failure modes across all detectors
  const allFailureModes = stats.flatMap((s) => s.commonFailureModes);
  const failureCounts = new Map<string, number>();
  for (const fm of allFailureModes) {
    failureCounts.set(fm.note, (failureCounts.get(fm.note) ?? 0) + fm.count);
  }
  const topFailures = [...failureCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([note, count]) => ({ pattern: note, count }));
  
  // Team-wide TTR average (from ROI endpoint)
  const avgTtrMinutes = Math.round(roi.avgTtrSeconds / 60 * 10) / 10;
  
  res.json({
    teamPlan: true,
    topDetectors,
    commonFailures: topFailures,
    avgTtrMinutes,
    totalPredictions: stats.reduce((sum, s) => sum + s.predictions, 0),
    totalVerdicts: stats.reduce((sum, s) => sum + s.verdicts, 0),
    overallAccuracy: Math.round(
      stats.reduce((sum, s) => sum + s.accuracy * s.verdicts, 0) /
      stats.reduce((sum, s) => sum + s.verdicts, 0) * 100
    ),
  });
}
```

**Register in app.ts:**
```typescript
import { handleTeamInsights } from './routes/team-insights.js';

app.get('/team/insights', handleTeamInsights);
```

**Acceptance criteria:**
- [ ] `/team/insights` returns JSON with top detectors
- [ ] Common failure modes aggregated across team
- [ ] Team-wide TTR average displayed
- [ ] Requires Team plan license (403 on free/solo)

---

## Metrics Dashboard (Track Weekly)

**Primary KPIs:**

```typescript
// Example weekly report format (automate via cron or GitHub Actions)

Weekly Report — Week of 2026-05-20
═══════════════════════════════════

Distribution:
  • npm downloads:          127 (↑ 45% vs. last week)
  • Chrome Web Store users:  89 (↑ 62%)
  • Active users (telemetry): 156

Conversion:
  • Free tier:     142 users
  • Paid users:     14 (9.9% conversion)
  • MRR:           $432 ($15 avg per user)

Product:
  • Avg credits/user:        67 calls/month
  • ROI (avg TTR):           6.2 min/bug
  • Detector accuracy:       68% (↑ 3% vs. last week)
  • Top detector:            auth_token_not_persisted (84%)
  • Most common failure:     "localStorage.token is null" (42 instances)

Churn:
  • Cancellations:  1 user
  • Churn reason:   "Not using Claude Code anymore"
```

**Tracking script:**
```bash
# scripts/weekly-metrics.sh

#!/bin/bash
echo "Fetching metrics from server..."

# Assuming server is running locally
curl -s http://127.0.0.1:3000/roi > /tmp/roi.json
curl -s http://127.0.0.1:3000/calibration/stats > /tmp/cal.json

# Parse and format (requires jq)
echo "Weekly Report — Week of $(date +'%Y-%m-%d')"
echo "═══════════════════════════════════"
echo ""
echo "ROI:"
jq -r '"  • Avg TTR: \(.avgTtrSeconds)s"' /tmp/roi.json
jq -r '"  • Weekly outcomes: \(.weeklyOutcomes)"' /tmp/roi.json

echo ""
echo "Calibration:"
jq -r '.stats | sort_by(-.accuracy) | .[0] | "  • Top detector: \(.tag) (\(.accuracy * 100 | floor)%)"' /tmp/cal.json
```

---

## Risk Mitigation

### Technical Risks

**Risk 1: Sourcemap CDNs block localhost requests**

**Mitigation:**
- Document workaround: `inlineSources: true` in webpack/vite config
- Add detection: if sourcemap fetch fails 3×, log warning and disable for that file
- Fallback: show raw stack trace with "[no sourcemap]" annotation

**Risk 2: Chrome extension breaks on manifest v3 updates**

**Status:** Already on manifest v3 ✅  
**Monitoring:** Subscribe to Chrome Extensions Group for breaking change announcements

**Risk 3: MCP SDK breaking changes**

**Mitigation:**
- Pin exact version in package.json: `"@modelcontextprotocol/sdk": "1.29.0"`
- Set up CI to test against latest SDK weekly (alert on failures)
- Maintain compatibility layer if SDK changes

---

## Success Criteria (90-Day Checkpoint)

**Must achieve (or plan fails):**
- [ ] **1,000 weekly active users** (20× current estimate)
- [ ] **$5,000 MRR** (50 paying customers at $100 avg)
- [ ] **15% free-to-paid conversion**

**Should achieve (or revise pricing):**
- [ ] **Avg 150 credits/user/month** (proves engagement)
- [ ] **75% avg detector accuracy** (calibration working)

**Nice to have (growth indicators):**
- [ ] **500+ GitHub stars** (2× current)
- [ ] **3 team customers** ($39/seat × 5 seats avg = $585 MRR)
- [ ] **First enterprise inbound** (>100 seats, proof of demand)

---

## Next Actions (This Week)

1. **Day 1:** Publish to npm as `mergen-server`
2. **Day 2:** Prepare Chrome Web Store assets (screenshots, privacy policy)
3. **Day 3:** Submit extension to Web Store
4. **Day 4-5:** Implement ROI tracking (`outcomes.json`, git watcher)
5. **Weekend:** Write first 3 silent-failure detectors (infinite loop, promise swallowed, CORS)

**Weekly standup questions:**
- How many new users this week?
- What's the free-to-paid conversion rate?
- Which detector has the highest accuracy?
- Any blockers on distribution?

---

**End of Plan**

**Last updated:** 2026-05-14  
**Next review:** 2026-06-01 (Month 1 checkpoint)
