#!/usr/bin/env node
/**
 * build-fast.mjs — esbuild-based TypeScript transpilation (no type checking).
 *
 * Use this when tsc runs out of memory (e.g. on machines with <12 GB free RAM).
 * Type correctness is still enforced by `npm test` (vitest). This script only
 * transpiles; it does NOT verify types. Run `tsc --noEmit` separately if you
 * want a full type-check without emitting.
 *
 * Usage: node scripts/build-fast.mjs
 * Or:    npm run build:fast
 */
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC  = path.resolve(__dirname, '..', 'src');
const DIST = path.resolve(__dirname, '..', 'dist');

function findTsFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findTsFiles(full, files);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      files.push(full);
    }
  }
  return files;
}

const entryPoints = findTsFiles(SRC);
console.log(`build-fast: transpiling ${entryPoints.length} TypeScript files...`);

await esbuild.build({
  entryPoints,
  outdir: DIST,
  outbase: SRC,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  bundle: false,
  sourcemap: false,
  logLevel: 'warning',
});

console.log(`build-fast: done → ${DIST}`);
