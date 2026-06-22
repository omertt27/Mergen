import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseAdrMarkdown, parsePostmortemMarkdown, syncMarkdownFilesFromDisk } from '../intelligence/postmortem-parser.js';
import { adrStore } from '../sensor/adr-store.js';
import { postmortemStore } from '../intelligence/postmortem-store.js';

describe('postmortem-parser', () => {
  it('parseAdrMarkdown parses valid ADR content correctly', () => {
    const content = `# ADR-099: Use Bun for server runtimes

**Date:** 2026-06-22
**Status:** Proposed

## Decision

We will use Bun instead of Node.js for performance.

## Alternatives considered

- **Node.js** — rejected: slower startup time.
- **Deno** — rejected: compatibility issues.

## Rationale

Bun is significantly faster.

## Consequences

Requires updating Dockerfile.
`;
    const adr = parseAdrMarkdown(content);
    expect(adr).not.toBeNull();
    expect(adr?.id).toBe('ADR-099');
    expect(adr?.title).toBe('Use Bun for server runtimes');
    expect(adr?.status).toBe('proposed');
    expect(adr?.date).toBe('2026-06-22');
    expect(adr?.decision).toContain('Bun instead of Node.js');
    expect(adr?.alternatives).toEqual(['**Node.js** — rejected: slower startup time.', '**Deno** — rejected: compatibility issues.']);
    expect(adr?.rationale).toContain('significantly faster');
    expect(adr?.consequences).toContain('updating Dockerfile');
  });

  it('parsePostmortemMarkdown parses valid postmortem content correctly', () => {
    const content = `# Postmortem — oom_kill

**Service:** web-api  |  **Date:** 2026-06-22
**Confidence:** 90%  |  **MTTR:** 5m 30s
**Resolution:** Autonomous (Mergen)
**Branch:** main  |  **SHA:** a1b2c3d4e5f6

## Root Cause

Out of memory crash due to memory leak.

## Fix Applied

\`\`\`
systemctl restart web-api
\`\`\`
`;
    const pm = parsePostmortemMarkdown('oom_kill.md', content);
    expect(pm).not.toBeNull();
    expect(pm?.tag).toBe('infra_oom_kill');
    expect(pm?.service).toBe('web-api');
    expect(pm?.confidence).toBe(0.9);
    expect(pm?.mttrMs).toBe((5 * 60 + 30) * 1000);
    expect(pm?.resolvedAutonomously).toBe(true);
    expect(pm?.gitBranch).toBe('main');
    expect(pm?.gitSha).toBe('a1b2c3d4e5f6');
    expect(pm?.rootCause).toContain('Out of memory');
    expect(pm?.fixCommand).toBe('systemctl restart web-api');
  });

  it('syncMarkdownFilesFromDisk syncs matching files from disk into stores', async () => {
    // Set up mock repository directory
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-repo-test-'));
    const adrDir = path.join(tempRepo, 'docs/adr');
    const pmDir = path.join(tempRepo, 'docs/postmortems');
    fs.mkdirSync(adrDir, { recursive: true });
    fs.mkdirSync(pmDir, { recursive: true });

    // Mock ADR
    const mockAdrContent = `# ADR-101: Web App Architecture

**Date:** 2026-06-22
**Status:** Accepted

## Decision

Use React with Vite.

## Alternatives considered

- **Next.js**

## Rationale

Vite is faster.

## Consequences

None.
`;
    fs.writeFileSync(path.join(adrDir, 'ADR-101-web-app.md'), mockAdrContent);

    // Mock Postmortem
    const mockPmContent = `# Postmortem — slow_query

**Service:** database  |  **Date:** 2026-06-22
**Confidence:** 85%  |  **MTTR:** 120s
**Resolution:** Manual

## Root Cause

Missing database index.
`;
    fs.writeFileSync(path.join(pmDir, 'slow_query.md'), mockPmContent);

    const upsertSpy = vi.spyOn(adrStore, 'upsert');
    const writeSpy = vi.spyOn(postmortemStore, 'write');

    const result = await syncMarkdownFilesFromDisk(tempRepo);

    expect(result.adrsSynced).toBe(1);
    expect(result.postmortemsSynced).toBe(1);

    expect(upsertSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();

    // Clean up
    fs.unlinkSync(path.join(adrDir, 'ADR-101-web-app.md'));
    fs.unlinkSync(path.join(pmDir, 'slow_query.md'));
    fs.rmdirSync(adrDir);
    fs.rmdirSync(pmDir);
    fs.rmdirSync(path.join(tempRepo, 'docs'));
    fs.rmdirSync(tempRepo);
  });
});
