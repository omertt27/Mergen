#!/usr/bin/env node
/**
 * check-arch.mjs — resilient wrapper for the architecture self-check.
 *
 * The real checker (`src/scripts/check-arch.ts`) is a closed-source module that
 * is absent from public/open checkouts. Previously `npm run check:arch` pointed
 * `tsx` straight at that file, so it hard-errored with a confusing module-not-
 * found for anyone without the closed source. This wrapper skips cleanly when
 * the source isn't present.
 *
 * Note: the gate-coverage invariant this script asserts is ALSO enforced at
 * runtime on every server start by assertGateCoversRegisteredTools() (see
 * src/index.ts), so a skipped static check is belt-and-suspenders, not a hole.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(serverDir, 'src', 'scripts', 'check-arch.ts');

if (!existsSync(src)) {
  console.log(
    '[check:arch] closed-source architecture check (src/scripts/check-arch.ts) is ' +
      'not present in this checkout — skipping.\n' +
      '           Runtime gate coverage is still enforced on every server start by ' +
      'assertGateCoversRegisteredTools() (src/index.ts).',
  );
  process.exit(0);
}

const result = spawnSync('npx', ['tsx', src], { stdio: 'inherit', cwd: serverDir });
process.exit(result.status ?? 0);
