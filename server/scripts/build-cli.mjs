#!/usr/bin/env node
/**
 * build-cli.mjs — post-tsc step for the npm-published MCP server.
 *
 * Why this exists:
 *   • `tsc` strips file mode bits, so even though the source has a
 *     shebang, the emitted `dist/index.js` isn't executable.
 *   • npm publishes file modes as-of-pack time. If the file isn't
 *     `+x` here, then `npx -y mergen-server` and direct `bin`
 *     invocations fail with "Permission denied" on Unix.
 *
 * It also double-checks that the shebang made it through the build —
 * if a future refactor drops it from `src/index.ts`, this fails loudly
 * instead of shipping a broken CLI to npm.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(__dirname, '..', 'dist', 'index.js');

if (!fs.existsSync(ENTRY)) {
  console.error(`build-cli: ${ENTRY} not found — run \`tsc\` first.`);
  process.exit(1);
}

const head = fs.readFileSync(ENTRY, 'utf8').slice(0, 64);
if (!head.startsWith('#!')) {
  console.error('build-cli: dist/index.js is missing its shebang. Re-add `#!/usr/bin/env node` to src/index.ts.');
  process.exit(1);
}

fs.chmodSync(ENTRY, 0o755);
console.log('build-cli: dist/index.js → 0755, shebang OK');

// ── Inject stub proxy files for closed-source intelligence modules ─────────────
// Each .d.ts in src/intelligence/ that has no corresponding .ts is a closed-source
// module. At runtime (dist/) it needs a real .js file — we proxy to the stubs that
// vitest already uses. This mirrors the closedSourceStubs() Vite plugin in
// vitest.config.ts, but for the production ESM runtime.
const INTEL_SRC  = path.resolve(__dirname, '..', 'src', 'intelligence');
const INTEL_DIST = path.resolve(__dirname, '..', 'dist', 'intelligence');

const SPECIFIC_STUBS = new Set(['causal', 'calibration']);
const CLOSED_SOURCE_STUB = '../__stubs__/closed-source.js';

const dtsFiles = fs.readdirSync(INTEL_SRC)
  .filter(f => f.endsWith('.d.ts'))
  .map(f => f.replace('.d.ts', ''));

let injected = 0;
for (const mod of dtsFiles) {
  const tsSource  = path.join(INTEL_SRC, `${mod}.ts`);
  const distProxy = path.join(INTEL_DIST, `${mod}.js`);

  // Skip if a real compiled .ts exists (open-source module)
  if (fs.existsSync(tsSource)) continue;
  // Skip if the production .js was already installed (paid build)
  if (fs.existsSync(distProxy)) continue;

  const stubPath = SPECIFIC_STUBS.has(mod)
    ? `../__stubs__/${mod}.js`
    : CLOSED_SOURCE_STUB;

  fs.writeFileSync(distProxy, `export * from '${stubPath}';\n`, 'utf8');
  injected++;
}

if (injected > 0) {
  console.log(`build-cli: injected ${injected} stub proxy file(s) in dist/intelligence/`);
}
