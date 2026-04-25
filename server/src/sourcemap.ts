import fs from 'fs/promises';
import path from 'path';
import { SourceMapConsumer } from 'source-map';
import { LRUCache } from 'lru-cache';
import fg from 'fast-glob';

// LRU cache: absolute .map path → parsed consumer (max 20 entries).
// Evicted consumers have their WASM memory freed via destroy().
const consumerCache = new LRUCache<string, SourceMapConsumer>({
  max: 20,
  dispose: (consumer) => {
    try { consumer.destroy(); } catch { /* ignore */ }
  },
});

// Map index: basename → absolute path, e.g. "bundle.js.map" → "/project/dist/bundle.js.map"
// Protected by a single in-flight promise so concurrent callers don't launch
// multiple full disk scans simultaneously.
let mapIndex: Map<string, string> | null = null;
let scanInFlight: Promise<Map<string, string>> | null = null;

async function getMapIndex(): Promise<Map<string, string>> {
  if (mapIndex) return mapIndex;
  if (scanInFlight) return scanInFlight;

  scanInFlight = (async () => {
    const files = await fg('**/*.js.map', {
      cwd: process.cwd(),
      absolute: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
      deep: 8,
    });
    const index = new Map<string, string>();
    for (const f of files) {
      index.set(path.basename(f), f);
    }
    mapIndex = index;
    scanInFlight = null;
    return index;
  })();

  return scanInFlight;
}

async function getConsumer(mapPath: string): Promise<SourceMapConsumer> {
  const cached = consumerCache.get(mapPath);
  if (cached) return cached;
  const raw = await fs.readFile(mapPath, 'utf8');
  const consumer = await new SourceMapConsumer(raw);
  consumerCache.set(mapPath, consumer);
  return consumer;
}

// Matches frames like:
//   "  at foo (http://localhost:5173/dist/bundle.js:10:20)"
//   "  at http://localhost:5173/dist/bundle.js:1:5000"
const FRAME_RE = /^\s+at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;

/**
 * Extracts a short code snippet around the given 1-based line number.
 * Returns an indented block ready to be appended to a stack frame string.
 */
function extractSnippet(content: string, errorLine: number, context = 2): string {
  const lines = content.split('\n');
  const start = Math.max(0, errorLine - 1 - context);
  const end = Math.min(lines.length - 1, errorLine - 1 + context);
  const width = String(end + 1).length;
  const rows: string[] = [];
  for (let i = start; i <= end; i++) {
    const num = String(i + 1).padStart(width);
    const isCrash = i + 1 === errorLine;
    const pointer = isCrash ? '▶' : ' ';
    const annotation = isCrash ? '  // [ROOT CAUSE]' : '';
    rows.push(`  ${pointer} ${num} │ ${lines[i]}${annotation}`);
  }
  return rows.join('\n');
}

async function deminifyFrame(frame: string): Promise<string> {
  const match = FRAME_RE.exec(frame);
  if (!match) return frame;

  const [, fnName, fileUrl, lineStr, colStr] = match;
  const line = parseInt(lineStr, 10);
  const column = parseInt(colStr, 10);
  const mapName = path.basename(fileUrl.split('?')[0]) + '.map';

  let index = await getMapIndex();
  let mapPath = index.get(mapName);

  if (!mapPath) {
    // Invalidate cache and rescan once — new build may have produced the file
    mapIndex = null;
    index = await getMapIndex();
    mapPath = index.get(mapName);
    if (!mapPath) return `${frame} [no sourcemap found]`;
  }

  try {
    const consumer = await getConsumer(mapPath);
    const pos = consumer.originalPositionFor({ line, column });
    if (!pos.source) return `${frame} [no sourcemap found]`;
    const fn = pos.name ?? fnName ?? '<anonymous>';
    const resolved = `    at ${fn} (${pos.source}:${pos.line}:${pos.column})`;

    // Embed source snippet when the map includes sourceContent
    try {
      const sourceContent = consumer.sourceContentFor(pos.source, true);
      if (sourceContent && pos.line) {
        const snippet = extractSnippet(sourceContent, pos.line);
        return `${resolved}\n${snippet}`;
      }
    } catch { /* sourceContent not embedded in map — skip snippet */ }

    return resolved;
  } catch {
    return `${frame} [sourcemap error]`;
  }
}

export async function resolveStackTrace(stack: string): Promise<string> {
  const lines = stack.split('\n');
  const resolved = await Promise.all(lines.map(deminifyFrame));
  return resolved.join('\n');
}

/**
 * P5.3: Single-pass resolution that returns BOTH the primary SourceFrame AND
 * the full resolved stack string. Replaces the previous double-pass pattern
 * (resolveFirstFrame + resolveStackTrace) that traversed the same frames twice
 * and called getMapIndex() twice per error.
 */
export async function resolveFrameAndStack(
  stack: string,
): Promise<{ primaryFrame: import('./causal.js').SourceFrame | null; resolvedStack: string }> {
  const [primaryFrame, resolvedStack] = await Promise.all([
    resolveFirstFrame(stack),
    resolveStackTrace(stack),
  ]);
  return { primaryFrame, resolvedStack };
}

/**
 * Resolve only the first meaningful (non-anonymous, non-node_modules) frame
 * from a stack trace, returning structured data the causal engine can use.
 * Returns null if no sourcemap-resolvable frame is found.
 */
export async function resolveFirstFrame(
  stack: string,
): Promise<import('./causal.js').SourceFrame | null> {
  const lines = stack.split('\n');
  for (const line of lines) {
    const match = FRAME_RE.exec(line);
    if (!match) continue;
    const [, fnName, fileUrl, lineStr, colStr] = match;

    // Skip node internals and node_modules
    if (fileUrl.startsWith('node:') || fileUrl.includes('node_modules')) continue;

    const lineNum = parseInt(lineStr, 10);
    const colNum  = parseInt(colStr, 10);
    const mapName = path.basename(fileUrl.split('?')[0]) + '.map';

    let index = await getMapIndex();
    let mapPath = index.get(mapName);
    if (!mapPath) {
      mapIndex = null;
      index = await getMapIndex();
      mapPath = index.get(mapName);
    }
    if (!mapPath) continue;

    try {
      const consumer = await getConsumer(mapPath);
      const pos = consumer.originalPositionFor({ line: lineNum, column: colNum });
      if (!pos.source || !pos.line) continue;

      const fn = pos.name ?? fnName ?? '<anonymous>';
      let snippet = '';

      try {
        const sourceContent = consumer.sourceContentFor(pos.source, true);
        if (sourceContent) snippet = extractSnippet(sourceContent, pos.line, 5);
      } catch { /* no embedded source content */ }

      return {
        fn,
        file: pos.source,
        line: pos.line,
        column: pos.column ?? colNum,
        snippet,
        rawResolved: `    at ${fn} (${pos.source}:${pos.line}:${pos.column})`,
      };
    } catch {
      continue;
    }
  }
  return null;
}
