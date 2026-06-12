/**
 * tool-manifest.test.ts — Keeps tool-manifest.ts and tools-state.ts in sync.
 *
 * Two contracts enforced:
 *   1. Every tool in tool-manifest.ts appears in KNOWN_TOOLS (tools-state.ts).
 *      Prevents manifest listing tools that are never tracked.
 *   2. Every tool in KNOWN_TOOLS appears in tool-manifest.ts.
 *      Prevents tools being registered silently without an audit entry.
 *
 * KNOWN_TOOLS is imported directly from tools-state.ts — no duplicate to maintain.
 * Run this whenever you add or remove an MCP tool.
 */

import { describe, it, expect } from 'vitest';
import { ALL_TOOL_NAMES } from '../intelligence/tool-manifest.js';
import { KNOWN_TOOLS } from '../intelligence/tools-state.js';

describe('tool-manifest consistency', () => {
  it('every tool in tool-manifest.ts is tracked in KNOWN_TOOLS', () => {
    // Tools in the manifest that are NOT in KNOWN_TOOLS need to be added to
    // tools-state.ts so their call counts are tracked in telemetry.
    const manifestOnly = ALL_TOOL_NAMES.filter((name) => !KNOWN_TOOLS.has(name));
    expect(manifestOnly, `tools in manifest but missing from KNOWN_TOOLS: ${manifestOnly.join(', ')}`).toHaveLength(0);
  });

  it('every tool in KNOWN_TOOLS is documented in tool-manifest.ts', () => {
    const manifestSet = new Set(ALL_TOOL_NAMES);
    const knownOnly = [...KNOWN_TOOLS].filter((name) => !manifestSet.has(name));
    expect(knownOnly, `tools in KNOWN_TOOLS but missing from tool-manifest.ts: ${knownOnly.join(', ')}`).toHaveLength(0);
  });

  it('tool-manifest.ts has no duplicate names', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const name of ALL_TOOL_NAMES) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    expect(dupes, `duplicate tool names in manifest: ${dupes.join(', ')}`).toHaveLength(0);
  });
});