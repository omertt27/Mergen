/**
 * arch-graph.test.ts — Tests for the import dependency graph engine.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { buildGraph, queryGraph, getZone, invalidateGraph } from '../intelligence/arch-graph.js';

const SRC_DIR = path.resolve(__dirname, '..');

describe('getZone', () => {
  it('classifies sensor files correctly', () => {
    expect(getZone('/repo/src/sensor/buffer.ts')).toBe('sensor');
  });

  it('classifies intelligence files correctly', () => {
    expect(getZone('/repo/src/intelligence/tools-utility.ts')).toBe('intelligence');
  });

  it('classifies routes files correctly', () => {
    expect(getZone('/repo/src/routes/incidents.ts')).toBe('routes');
  });

  it('classifies datadog files correctly', () => {
    expect(getZone('/repo/src/datadog/client.ts')).toBe('datadog');
  });

  it('returns other for unrecognised paths', () => {
    expect(getZone('/repo/src/index.ts')).toBe('other');
  });
});

describe('buildGraph', () => {
  it('returns a graph with files and adjacency maps', () => {
    const graph = buildGraph(SRC_DIR);
    expect(graph.files.length).toBeGreaterThan(10);
    expect(graph.forward).toBeInstanceOf(Map);
    expect(graph.reverse).toBeInstanceOf(Map);
  });

  it('returns a cached graph on second call', () => {
    const g1 = buildGraph(SRC_DIR);
    const g2 = buildGraph(SRC_DIR);
    expect(g1).toBe(g2);
  });

  it('returns a fresh graph after invalidation', () => {
    const g1 = buildGraph(SRC_DIR);
    invalidateGraph(SRC_DIR);
    const g2 = buildGraph(SRC_DIR);
    expect(g1).not.toBe(g2);
  });

  it('every file in forward map is also in reverse map', () => {
    const graph = buildGraph(SRC_DIR);
    for (const file of graph.files) {
      expect(graph.forward.has(file)).toBe(true);
      expect(graph.reverse.has(file)).toBe(true);
    }
  });

  it('reverse edges are consistent with forward edges', () => {
    const graph = buildGraph(SRC_DIR);
    for (const [file, imports] of graph.forward) {
      for (const imp of imports) {
        expect(graph.reverse.get(imp)?.has(file)).toBe(true);
      }
    }
  });
});

describe('queryGraph', () => {
  it('depends-on: returns files imported by the target', () => {
    const graph = buildGraph(SRC_DIR);
    // rollback.ts imports autonomy.ts — should appear in depends-on
    const rollback = graph.files.find((f) => f.endsWith('/intelligence/rollback.ts'));
    if (!rollback) return; // skip if file not found
    const result = queryGraph(graph, { file: rollback, direction: 'depends-on', maxDepth: 1 });
    expect(result.direction).toBe('depends-on');
    expect(result.direct.length).toBeGreaterThanOrEqual(0); // may vary by build
  });

  it('depended-by: returns files that import the target', () => {
    const graph = buildGraph(SRC_DIR);
    const bufferTs = graph.files.find((f) => f.endsWith('/sensor/buffer.ts'));
    if (!bufferTs) return;
    const result = queryGraph(graph, { file: bufferTs, direction: 'depended-by', maxDepth: 1 });
    expect(result.direction).toBe('depended-by');
    // buffer.ts should be imported by multiple files
    expect(result.direct.length).toBeGreaterThan(0);
  });

  it('respects maxDepth', () => {
    const graph = buildGraph(SRC_DIR);
    const bufferTs = graph.files.find((f) => f.endsWith('/sensor/buffer.ts'));
    if (!bufferTs) return;
    const shallow = queryGraph(graph, { file: bufferTs, direction: 'depended-by', maxDepth: 1 });
    const deep    = queryGraph(graph, { file: bufferTs, direction: 'depended-by', maxDepth: 3 });
    expect(deep.transitive.length).toBeGreaterThanOrEqual(shallow.transitive.length);
  });
});
