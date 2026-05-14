#!/usr/bin/env node
/**
 * build-cli.mjs — Post-build script to prepare CLI for npm
 */

import { readFileSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, '../dist/cli.js');

try {
  if (!existsSync(CLI_PATH)) {
    console.log('⚠ CLI not built yet (normal during initial compile)');
    process.exit(0);
  }

  let content = readFileSync(CLI_PATH, 'utf8');

  // Add shebang if not present
  if (!content.startsWith('#!/usr/bin/env node')) {
    content = '#!/usr/bin/env node\n' + content;
    writeFileSync(CLI_PATH, content, 'utf8');
  }

  // Make executable
  chmodSync(CLI_PATH, 0o755);

  console.log('✓ CLI prepared for npm');
} catch (err) {
  console.error('✗ CLI build failed:', err.message);
  process.exit(1);
}
