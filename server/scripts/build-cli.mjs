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
