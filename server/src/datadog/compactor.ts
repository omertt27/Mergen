import { DdSpan, DdLog, fetchLogsByTraceId } from './client.js';
import { matchLines } from './line-matcher.js';

// ── Stage 1: Trace Graph Pruner ────────────────────────────────────────────────
// Keep ERROR spans plus any span whose duration exceeds 5% of the slowest span.
// This typically eliminates 90–95% of successful child spans.
function pruneTrace(spans: DdSpan[]): DdSpan[] {
  if (spans.length === 0) return [];
  const maxDuration = Math.max(...spans.map((s) => s.durationNs));
  const threshold = maxDuration * 0.05;
  return spans.filter((s) => s.status === 'error' || s.durationNs >= threshold);
}

// ── Stage 2: Attribute Strip-Mining ────────────────────────────────────────────
const KEEP_PREFIXES = [
  'error.',
  'exception.',
  'db.',
  'http.status_code',
  'http.url',
  'http.method',
  'http.route',
  'git.commit',
  'net.peer.name',
];
const STRIP_PREFIXES = [
  'container_',
  'k8s.',
  'os.',
  'process.runtime',
  'net.transport',
  'network.',
  'peer.',
  'otel.',
  'http.scheme',
  'http.flavor',
  'messaging.',
];

function stripAttributes(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (STRIP_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (KEEP_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

// ── Stage 3: Log & Exception Inlining ─────────────────────────────────────────
type SpanWithLogs = DdSpan & { inlinedLogs?: DdLog[] };

async function inlineLogs(
  spans: DdSpan[],
  from: Date,
  to: Date,
): Promise<SpanWithLogs[]> {
  const traceIds = [...new Set(spans.map((s) => s.traceId))];
  const logsByTrace = new Map<string, DdLog[]>();

  await Promise.all(
    traceIds.map(async (traceId) => {
      try {
        const logs = await fetchLogsByTraceId({ traceId, from, to, errorsOnly: true });
        if (logs.length > 0) logsByTrace.set(traceId, logs);
      } catch { /* best-effort */ }
    }),
  );

  return spans.map((s) => ({ ...s, inlinedLogs: logsByTrace.get(s.traceId) }));
}

// ── Stage 4: Serialize to Runtime Fact ────────────────────────────────────────
export interface RuntimeFact {
  markdown: string;
  service: string;
  traceId: string;
  endpoint: string;
  errorMessage: string;
  failingFile?: string;
  failingLine?: number;
  deployedSha?: string;
  rawSpanCount: number;
  compactedSpanCount: number;
}

// Parse the first useful file:line from a stack trace string
function parseTopFrame(stack: string): { file: string; line: number } | null {
  // Go-style: "goroutine 1 [running]:\nmain.main()\n\t/app/main.go:42"
  const goMatch = stack.match(/\t([^:\s]+\.go):(\d+)/);
  if (goMatch) return { file: goMatch[1], line: parseInt(goMatch[2], 10) };

  // Node/Java/Python style: "at Something (file.ts:42:8)" or "File.java:42"
  const nodeMatch = stack.match(/at\s+\S+\s+\(([^:)]+):(\d+):\d+\)/);
  if (nodeMatch) return { file: nodeMatch[1], line: parseInt(nodeMatch[2], 10) };

  // Python style: File "foo.py", line 42
  const pyMatch = stack.match(/File "([^"]+)", line (\d+)/);
  if (pyMatch) return { file: pyMatch[1], line: parseInt(pyMatch[2], 10) };

  return null;
}

async function serializeToFact(
  spans: SpanWithLogs[],
  traceId: string,
): Promise<RuntimeFact> {
  const errorSpans = spans.filter((s) => s.status === 'error');
  const root = errorSpans[0] ?? spans[0];
  if (!root) throw new Error('No spans to serialize');

  const service = root.service;
  const endpoint = root.resourceName;
  const errorMsg = root.tags['error.message'] ?? root.tags['error.msg'] ?? 'Unknown error';
  const errorType = root.tags['error.type'] ?? root.tags['exception.type'] ?? '';
  const errorStack = root.tags['error.stack'] ?? root.tags['exception.stacktrace'] ?? '';
  const deployedSha = root.tags['git.commit.sha'] ?? root.tags['git.commit'];
  const durationMs = Math.round(root.durationNs / 1_000_000);

  let failingFile: string | undefined;
  let failingLine: number | undefined;
  let codeContext: string | undefined;

  const frame = errorStack ? parseTopFrame(errorStack) : null;
  if (frame) {
    failingFile = frame.file;
    failingLine = frame.line;
    try {
      codeContext = await matchLines(failingFile, failingLine, deployedSha);
    } catch { /* graceful degradation */ }
  }

  // Collect correlated log messages (de-dup and cap)
  const seen = new Set<string>();
  const logLines: string[] = [];
  for (const s of spans) {
    for (const l of s.inlinedLogs ?? []) {
      const key = l.message.slice(0, 80);
      if (!seen.has(key)) { seen.add(key); logLines.push(l.message.slice(0, 200)); }
      if (logLines.length >= 5) break;
    }
  }

  const lines: string[] = [
    '## MERGEN RUNTIME FACT',
    '',
    `**Failure Endpoint:** \`${endpoint}\` (Service: \`${service}\`)`,
    `**Trace ID:** \`${traceId}\``,
    `**Duration:** ${durationMs}ms`,
    '',
    errorType
      ? `**Exception:** \`${errorType}: ${errorMsg}\``
      : `**Error:** ${errorMsg}`,
  ];

  const dbStatement = root.tags['db.statement'];
  if (dbStatement) {
    lines.push('', '**Failing Query:**', '```sql', dbStatement.slice(0, 500), '```');
  }

  const httpStatus = root.tags['http.status_code'];
  if (httpStatus) lines.push('', `**HTTP Status:** ${httpStatus}`);

  if (errorStack) {
    const topFrames = errorStack.split('\n').slice(0, 8).join('\n');
    lines.push('', '**Stack Trace (top frames):**', '```', topFrames, '```');
  }

  if (codeContext && failingFile && failingLine) {
    lines.push(
      '',
      `**Local Code Context** (\`${failingFile}:${failingLine}\`):`,
      '```',
      codeContext,
      '```',
    );
  } else if (failingFile && failingLine) {
    lines.push('', `**Failing Location:** \`${failingFile}:${failingLine}\` *(local workspace not matched)*`);
  }

  if (logLines.length > 0) {
    lines.push('', '**Correlated Error Logs:**');
    for (const l of logLines) lines.push(`- ${l}`);
  }

  if (deployedSha) {
    lines.push(
      '',
      `**Deployed Commit:** \`${deployedSha.slice(0, 7)}\``,
      `*Run \`git show ${deployedSha.slice(0, 7)}\` to see what changed.*`,
    );
  }

  const rawKb = Math.round(JSON.stringify(spans).length / 1024);
  const factKb = Math.max(1, Math.round(lines.join('\n').length / 1024));
  lines.push(
    '',
    '---',
    `*Compacted ${rawKb}KB raw trace (${spans.length} spans) → ${factKb}KB Runtime Fact*`,
  );

  return {
    markdown: lines.join('\n'),
    service,
    traceId,
    endpoint,
    errorMessage: errorMsg,
    failingFile,
    failingLine,
    deployedSha,
    rawSpanCount: spans.length,
    compactedSpanCount: errorSpans.length,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────
export interface CompactorInput {
  spans: DdSpan[];
  traceId: string;
  timeWindow: { from: Date; to: Date };
}

export async function compact(input: CompactorInput): Promise<{ fact: RuntimeFact }> {
  const pruned = pruneTrace(input.spans);
  const stripped = pruned.map((s) => ({ ...s, tags: stripAttributes(s.tags) }));
  const withLogs = await inlineLogs(stripped, input.timeWindow.from, input.timeWindow.to);
  const fact = await serializeToFact(withLogs, input.traceId);
  return { fact };
}
