/**
 * rbac.test.ts — Unit tests for RBAC role resolution and permission checks.
 *
 * Uses a temp file for RBAC_FILE so tests are isolated from any real
 * ~/.mergen/rbac.json on the developer's machine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Module-level setup: redirect RBAC_FILE to a temp path ────────────────────
// We must mock the paths module before the rbac module is imported so the
// module-level `load()` call in resolveRole reads from our temp file.

const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-rbac-test-'));
const RBAC_TEMP = path.join(tmpDir, 'rbac.json');

vi.mock('../sensor/paths.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../sensor/paths.js')>();
  return { ...orig, RBAC_FILE: RBAC_TEMP };
});

// Import after mock is registered
const { resolveRole, hasPermission, _resetForTesting } =
  await import('../sensor/rbac.js');

// Force module re-evaluation between tests by clearing the temp file
function writeRbac(members: Array<{ id: string; role: string }>): void {
  fs.writeFileSync(RBAC_TEMP, JSON.stringify({ members }), 'utf8');
}

function clearRbac(): void {
  if (fs.existsSync(RBAC_TEMP)) fs.unlinkSync(RBAC_TEMP);
}

beforeEach(() => {
  _resetForTesting(); // clear _loadFailed so corrupt-file tests don't bleed into subsequent ones
});

afterEach(() => {
  clearRbac();
});

// ── resolveRole ───────────────────────────────────────────────────────────────

describe('resolveRole', () => {
  it('autopilot actor always returns admin regardless of RBAC config', () => {
    writeRbac([{ id: 'alice', role: 'viewer' }]);
    expect(resolveRole('autopilot')).toBe('admin');
  });

  it('returns admin when RBAC file is absent (open by design)', () => {
    clearRbac();
    expect(resolveRole('anyone')).toBe('admin');
  });

  it('returns admin when RBAC file exists but members array is empty', () => {
    writeRbac([]);
    expect(resolveRole('anyone')).toBe('admin');
  });

  it('returns the configured role for a known member', () => {
    writeRbac([{ id: 'alice', role: 'responder' }]);
    expect(resolveRole('alice')).toBe('responder');
  });

  it('returns viewer for an unknown actor when RBAC is configured', () => {
    writeRbac([{ id: 'alice', role: 'admin' }]);
    expect(resolveRole('unknown-actor')).toBe('viewer');
  });

  it('returns viewer for all non-autopilot actors when RBAC file is corrupt (fail-closed)', () => {
    fs.writeFileSync(RBAC_TEMP, '{ invalid json !!!', 'utf8');
    expect(resolveRole('alice')).toBe('viewer');
    expect(resolveRole('admin-user')).toBe('viewer');
    expect(resolveRole('bob')).toBe('viewer');
  });

  it('autopilot still returns admin even when RBAC file is corrupt', () => {
    fs.writeFileSync(RBAC_TEMP, '{ invalid json !!!', 'utf8');
    expect(resolveRole('autopilot')).toBe('admin');
  });
});

// ── hasPermission ─────────────────────────────────────────────────────────────

describe('hasPermission', () => {
  beforeEach(() => {
    writeRbac([
      { id: 'viewer-user',    role: 'viewer' },
      { id: 'responder-user', role: 'responder' },
      { id: 'admin-user',     role: 'admin' },
    ]);
  });

  it('viewer cannot execute fixes (responder role required)', () => {
    expect(hasPermission('viewer-user', 'responder')).toBe(false);
  });

  it('viewer cannot manage RBAC (admin role required)', () => {
    expect(hasPermission('viewer-user', 'admin')).toBe(false);
  });

  it('responder can execute fixes', () => {
    expect(hasPermission('responder-user', 'responder')).toBe(true);
  });

  it('responder cannot manage RBAC', () => {
    expect(hasPermission('responder-user', 'admin')).toBe(false);
  });

  it('admin can do everything', () => {
    expect(hasPermission('admin-user', 'viewer')).toBe(true);
    expect(hasPermission('admin-user', 'responder')).toBe(true);
    expect(hasPermission('admin-user', 'admin')).toBe(true);
  });

  it('autopilot is always permitted regardless of required role', () => {
    expect(hasPermission('autopilot', 'admin')).toBe(true);
    expect(hasPermission('autopilot', 'responder')).toBe(true);
  });

  it('unknown actor is denied responder access when RBAC is configured', () => {
    expect(hasPermission('mystery-user', 'responder')).toBe(false);
  });
});

// ── RBAC fail-closed integration with executeRemediation ─────────────────────

describe('RBAC blocks execution for viewer role', () => {
  it('executeRemediation returns blocked=true for a viewer actor', async () => {
    writeRbac([{ id: 'viewer-user', role: 'viewer' }]);
    const { executeRemediation } = await import('../intelligence/autonomy.js');
    const result = await executeRemediation('npm install', { actor: 'viewer-user' });
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toMatch(/viewer-user.*responder/i);
  });

  it('executeRemediation succeeds for a responder actor', async () => {
    writeRbac([{ id: 'responder-user', role: 'responder' }]);
    const { executeRemediation } = await import('../intelligence/autonomy.js');
    const result = await executeRemediation('npm install', { dryRun: true, actor: 'responder-user' });
    expect(result.blocked).toBe(false);
  });
});
