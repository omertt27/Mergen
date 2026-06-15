/**
 * arch-graph.ts — File-level import dependency graph for a TypeScript codebase.
 *
 * Builds two adjacency maps from source files:
 *   forward:  file → files it imports  ("what does X depend on?")
 *   reverse:  file → files that import it  ("what depends on X?")
 *
 * Used by:
 *   - arch-boundaries.ts  (boundary violation detection)
 *   - change-risk.ts      (test coverage and blast radius)
 *   - tools-arch.ts       (query_arch_graph MCP tool)
 *
 * The scan is lazy and cached per root directory. Call invalidate() to force
 * a rescan after file changes.
 */

import fs from 'fs';
import path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ArchGraph {
  /** Absolute path of the scanned root. */
  root: string;
  /** file → Set of files it imports (resolved, .ts extension). */
  forward: Map<string, Set<string>>;
  /** file → Set of files that import it. */
  reverse: Map<string, Set<string>>;
  /** Sorted list of all discovered source files. */
  files: string[];
  /** Timestamp of last build. */
  builtAt: number;
}

export interface GraphQuery {
  /** Absolute path of the file to query. */
  file: string;
  /** 'depends-on': what does this file import (transitively)?
   *  'depended-by': what files import this file (transitively)? */
  direction: 'depends-on' | 'depended-by';
  /** Maximum traversal depth (default 3). */
  maxDepth?: number;
}

export interface GraphQueryResult {
  file: string;
  direction: GraphQuery['direction'];
  direct: string[];
  transitive: string[];
  depth: number;
}

// ── Import extractor ──────────────────────────────────────────────────────────

const IMPORT_RE = /(?:import|export)(?:[\s\S]*?\bfrom\b)?\s+['"]([^'"]+)['"]/g;

function extractImports(source: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

/** Resolve a raw import specifier to an absolute file path (.ts). Returns null for package imports. */
function resolveImport(rawPath: string, importerDir: string): string | null {
  if (!rawPath.startsWith('.')) return null; // package import — skip
  const withoutExt = rawPath.replace(/\.(js|ts|mjs)$/, '');
  const candidates = [
    path.resolve(importerDir, withoutExt + '.ts'),
    path.resolve(importerDir, withoutExt, 'index.ts'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ── Scanner ───────────────────────────────────────────────────────────────────

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip dist, node_modules, __stubs__, test fixtures
      if (['dist', 'node_modules', '__stubs__', 'evals'].includes(entry.name)) continue;
      collectTsFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const _cache = new Map<string, ArchGraph>();

/** Build (or return cached) the import graph for a source directory. */
export function buildGraph(srcDir: string): ArchGraph {
  const cached = _cache.get(srcDir);
  // Cache valid for 60 s — short enough to pick up file changes during dev
  if (cached && Date.now() - cached.builtAt < 60_000) return cached;

  const files = collectTsFiles(srcDir).sort();
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();

  for (const file of files) {
    forward.set(file, new Set());
    reverse.set(file, new Set());
  }

  for (const file of files) {
    let source: string;
    try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const imports = extractImports(source);
    for (const raw of imports) {
      const resolved = resolveImport(raw, path.dirname(file));
      if (!resolved || !forward.has(resolved)) continue;
      forward.get(file)!.add(resolved);
      reverse.get(resolved)!.add(file);
    }
  }

  const graph: ArchGraph = { root: srcDir, forward, reverse, files, builtAt: Date.now() };
  _cache.set(srcDir, graph);
  return graph;
}

/** Force a rescan on next call to buildGraph(). */
export function invalidateGraph(srcDir: string): void {
  _cache.delete(srcDir);
}

// ── Query ─────────────────────────────────────────────────────────────────────

export function queryGraph(graph: ArchGraph, query: GraphQuery): GraphQueryResult {
  const { file, direction, maxDepth = 3 } = query;
  const adjacency = direction === 'depends-on' ? graph.forward : graph.reverse;

  const direct = [...(adjacency.get(file) ?? [])];
  const visited = new Set<string>([file]);
  const frontier = [...direct];
  const transitive: string[] = [];
  let depth = 1;

  while (frontier.length > 0 && depth < maxDepth) {
    depth++;
    const next: string[] = [];
    for (const f of frontier) {
      if (visited.has(f)) continue;
      visited.add(f);
      transitive.push(f);
      const neighbors = adjacency.get(f) ?? new Set();
      for (const n of neighbors) {
        if (!visited.has(n)) next.push(n);
      }
    }
    frontier.length = 0;
    frontier.push(...next);
  }

  return { file, direction, direct, transitive, depth };
}

// ── Zone helpers (shared with boundary checker and risk scorer) ───────────────

export type ArchZone = 'sensor' | 'intelligence' | 'routes' | 'datadog' | 'other';

export function getZone(filePath: string): ArchZone {
  const p = filePath.replace(/\\/g, '/');
  if (p.includes('/sensor/'))      return 'sensor';
  if (p.includes('/intelligence/')) return 'intelligence';
  if (p.includes('/routes/'))      return 'routes';
  if (p.includes('/datadog/'))     return 'datadog';
  return 'other';
}

export const ZONE_DISPLAY: Record<ArchZone, string> = {
  sensor:       'Sensor (data ingestion / storage)',
  intelligence: 'Intelligence (MCP tools / analysis)',
  routes:       'Routes (Express handlers)',
  datadog:      'Datadog (external integration)',
  other:        'Other',
};
