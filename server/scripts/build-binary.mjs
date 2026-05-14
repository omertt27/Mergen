#!/usr/bin/env node
/**
 * build-binary.mjs — Build standalone binaries using @vercel/ncc
 *
 * Creates single-file executables for:
 * - macOS (arm64, x64)
 * - Linux (x64)
 * - Windows (x64)
 */

import { exec } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { promisify } from 'util';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const OUTPUT_DIR = resolve(ROOT, 'binaries');

console.log('📦 Building Mergen binaries...\n');

// Create output directory
if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Check if @vercel/ncc is installed
try {
  await execAsync('npx @vercel/ncc --version');
} catch {
  console.log('Installing @vercel/ncc...');
  await execAsync('npm install -D @vercel/ncc');
}

// Build with ncc (bundles all dependencies)
console.log('Building server bundle...');
const { stdout, stderr } = await execAsync(
  'npx @vercel/ncc build dist/index.js -o ../binaries/bundle --minify',
  { cwd: resolve(ROOT, 'server') }
);

if (stderr) console.error(stderr);
if (stdout) console.log(stdout);

console.log('✓ Bundle created at binaries/bundle/index.js');
console.log('');
console.log('To create platform-specific binaries, install pkg:');
console.log('  npm install -g pkg');
console.log('  pkg binaries/bundle/index.js --targets node20-macos-arm64,node20-macos-x64,node20-linux-x64,node20-win-x64');
console.log('');
console.log('Or use the GitHub Actions workflow for automated builds.');
