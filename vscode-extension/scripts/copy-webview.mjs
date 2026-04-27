#!/usr/bin/env node
/**
 * copy-webview.mjs — Post-tsc build step.
 *
 * `tsc` only emits the .js/.d.ts files declared in tsconfig.json. Anything the
 * extension needs at runtime that *isn't* TypeScript (icons used by the panel,
 * the icon128.png referenced in package.json, walkthrough markdown) has to be
 * copied into a place the published .vsix will include.
 *
 * Why this exists:
 *   • The marketplace icon (`icons/icon128.png`) lives in `extension/icons/`
 *     in the monorepo; we copy it into `vscode-extension/icons/` so the .vsix
 *     ships with it without duplicating the file in git.
 *   • Keeping a tiny copy step (instead of e.g. esbuild) keeps the build
 *     dependency-free and easy to debug from the preflight script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');

function copyIfNewer(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const sStat = fs.statSync(src);
  if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= sStat.mtimeMs) return true;
  fs.copyFileSync(src, dst);
  return true;
}

const tasks = [
  // Marketplace tile icon — required by package.json "icon" field.
  [path.join(REPO, 'extension/icons/icon128.png'), path.join(ROOT, 'icons/icon128.png')],
  // Activity-bar icon (already in repo, kept here for completeness).
  [path.join(ROOT, 'icons/icon16.svg'),            path.join(ROOT, 'icons/icon16.svg')],
];

let copied = 0, missing = [];
for (const [src, dst] of tasks) {
  if (copyIfNewer(src, dst)) copied++;
  else missing.push(src);
}

console.log(`copy-webview: ${copied}/${tasks.length} asset(s) ready`);
if (missing.length) {
  console.warn('  missing sources (skipped):');
  for (const m of missing) console.warn('   - ' + m);
}
