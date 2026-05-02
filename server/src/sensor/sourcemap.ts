import fs from 'fs/promises';
import path from 'path';
import { SourceMapConsumer } from 'source-map';
import { LRUCache } from 'lru-cache';
import fg from 'fast-glob';

// ── Exported type ─────────────────────────────────────────────────────────────
// Defined here (sensor layer) so sourcemap.ts is self-contained.
// causal.ts imports this from here rather than defining it itself.
export interface SourceFrame {
  fn: string;
  file: string;
  line: number;
  column: number;
  snippet: string;
  rawResolved: string;
}

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
// TTL-based invalidation: index expires after 30 s so new builds are picked up.
const MAP_INDEX_TTL_MS = 30_000;
let mapIndex: Map<string, string> | null = null;
let mapIndexCreatedAt = 0;
let scanInFlight: Promise<Map<string, string>> | null = null;

async function getMapIndex(): Promise<Map<string, string>> {
  if (mapIndex && Date.now() - mapIndexCreatedAt < MAP_INDEX_TTL_MS) return mapIndex;
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
    mapIndexCreatedAt = Date.now();
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
 * P5.3: True single-pass resolution that returns BOTH the primary SourceFrame
 * AND the full resolved stack string. Iterates frames once, resolves each,
 * captures the first meaningful frame as primaryFrame along the way.
 */
export async function resolveFrameAndStack(
  stack: string,
): Promise<{ primaryFrame: SourceFrame | null; resolvedStack: string }> {
  const lines = stack.split('\n');
  let primaryFrame: SourceFrame | null = null;

  const resolvedLines = await Promise.all(
    lines.map(async (line) => {
      const match = FRAME_RE.exec(line);
      if (!match) return line;

      const [, fnName, fileUrl, lineStr, colStr] = match;
      const lineNum = parseInt(lineStr, 10);
      const colNum = parseInt(colStr, 10);
      const mapName = path.basename(fileUrl.split('?')[0]) + '.map';

      let index = await getMapIndex();
      let mapPath = index.get(mapName);
      if (!mapPath) {
        mapIndex = null;
        index = await getMapIndex();
        mapPath = index.get(mapName);
        if (!mapPath) return `${line} [no sourcemap found]`;
      }

      try {
        const consumer = await getConsumer(mapPath);
        const pos = consumer.originalPositionFor({ line: lineNum, column: colNum });
        if (!pos.source) return `${line} [no sourcemap found]`;
        const fn = pos.name ?? fnName ?? '<anonymous>';
        const resolved = `    at ${fn} (${pos.source}:${pos.line}:${pos.column})`;

        let snippet = '';
        try {
          const sourceContent = consumer.sourceContentFor(pos.source, true);
          if (sourceContent && pos.line) {
            snippet = extractSnippet(sourceContent, pos.line);
          }
        } catch { /* sourceContent not embedded in map — skip snippet */ }

        return snippet ? `${resolved}\n${snippet}` : resolved;
      } catch {
        return `${line} [sourcemap error]`;
      }
    }),
  );

  // Find the primary frame from the resolved results (first non-internal, non-node_modules)
  for (let i = 0; i < lines.length; i++) {
    if (primaryFrame) break;
    const match = FRAME_RE.exec(lines[i]);
    if (!match) continue;
    const [, fnName, fileUrl, lineStr, colStr] = match;
    if (fileUrl.startsWith('node:') || fileUrl.includes('node_modules')) continue;

    const lineNum = parseInt(lineStr, 10);
    const colNum = parseInt(colStr, 10);
    const mapName = path.basename(fileUrl.split('?')[0]) + '.map';
    const index = await getMapIndex();
    const mapPath = index.get(mapName);
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

      primaryFrame = {
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

  return { primaryFrame, resolvedStack: resolvedLines.join('\n') };
}

/**
 * Resolve only the first meaningful (non-anonymous, non-node_modules) frame
 * from a stack trace, returning structured data the causal engine can use.
 * Returns null if no sourcemap-resolvable frame is found.
 */
export async function resolveFirstFrame(
  stack: string,
): Promise<SourceFrame | null> {
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
