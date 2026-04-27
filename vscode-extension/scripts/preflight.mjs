#!/usr/bin/env node
/**
 * preflight.mjs — Run BEFORE `npm run publish:all`.
 *
 * Catches the issues that turn a 30-second publish into a 30-minute
 * debugging session: wrong placeholders, missing artifacts, missing
 * tokens, README that still mentions `your-org`.
 *
 * Exits 1 on any blocking issue, 0 if good to ship.
 *
 * Why this exists:
 *   • `vsce publish` and `ovsx publish` both reject silently or with
 *     opaque errors when the package is malformed.
 *   • Marketplace listings are *very* hard to update once shipped — better
 *     to spend 5 seconds on a check than 24 h on a "v1.0.1 typo fix".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const fails = [];
const warns = [];
const ok    = [];

function check(label, cond, hint) {
  if (cond) ok.push(label);
  else fails.push({ label, hint });
}
function warn(label, cond, hint) {
  if (!cond) warns.push({ label, hint });
}

// ── 1. package.json sanity ───────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

check('publisher is set',           pkg.publisher && pkg.publisher !== 'your-publisher', 'set "publisher" in package.json');
check('repository.url is set',      pkg.repository?.url, 'add { repository: { type: "git", url: "..." } }');
check('homepage is set',            !!pkg.homepage, 'add "homepage" to package.json');
check('bugs.url is set',            !!pkg.bugs?.url, 'add "bugs": { "url": "..." }');
check('license field is set',       !!pkg.license, 'add "license": "MIT"');
check('icon file exists',           pkg.icon && fs.existsSync(path.join(ROOT, pkg.icon)), `icon path "${pkg.icon}" not found`);
check('engines.vscode is set',      !!pkg.engines?.vscode, 'add { engines: { vscode: "^1.85.0" } }');

// Open VSX requires `categories`; both registries strongly recommend `keywords`.
check('categories non-empty',       Array.isArray(pkg.categories) && pkg.categories.length > 0, 'add "categories": ["Debuggers", ...]');
check('keywords non-empty',         Array.isArray(pkg.keywords)  && pkg.keywords.length  > 0, 'add "keywords": [...]');

// ── 2. Required files in the .vsix ───────────────────────────────────────────
const REQUIRED = ['README.md', 'CHANGELOG.md', 'dist/extension.js'];
for (const rel of REQUIRED) {
  check(`${rel} present`, fs.existsSync(path.join(ROOT, rel)), `run \`npm run build\` first`);
}
// LICENSE — vsce just warns, but Open VSX rejects publishes without one.
const repoLicense = fs.existsSync(path.join(ROOT, 'LICENSE')) || fs.existsSync(path.join(ROOT, '..', 'LICENSE'));
check('LICENSE present (here or repo root)', repoLicense, 'add a LICENSE file at the repo root');

// ── 3. Walkthrough media files referenced exist ──────────────────────────────
const wt = pkg.contributes?.walkthroughs ?? [];
for (const w of wt) {
  for (const step of w.steps ?? []) {
    const md = step.media?.markdown;
    if (md) {
      check(`walkthrough media: ${md}`, fs.existsSync(path.join(ROOT, md)), `missing media file "${md}"`);
    }
  }
}

// ── 4. Placeholders that would embarrass us in production ────────────────────
const README = fs.existsSync(path.join(ROOT, 'README.md'))
  ? fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  : '';
warn('README.md does not contain "your-org"',  !README.includes('your-org'),  'replace `your-org` with the real GitHub org slug before publishing');
warn('package.json does not contain "your-org"',
     !JSON.stringify(pkg).includes('your-org'),
     'replace `your-org` placeholders in repository / homepage / bugs');

// ── 5. Tokens in the environment (informational only) ────────────────────────
warn('VSCE_PAT env var present (Microsoft Marketplace)',
     !!process.env.VSCE_PAT,
     'export VSCE_PAT=<azure devops token>  — or use `vsce login mergen`');
warn('OVSX_PAT env var present (Open VSX / Eclipse)',
     !!process.env.OVSX_PAT,
     'export OVSX_PAT=<open-vsx token>  — get it at https://open-vsx.org/user-settings/tokens');

// ── 6. Version not already published ────────────────────────────────────────
warn('version > 0.0.0', pkg.version && pkg.version !== '0.0.0', 'bump version before publishing');

// ── Render report ────────────────────────────────────────────────────────────
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red   = (s) => `\x1b[31m${s}\x1b[0m`;
const yel   = (s) => `\x1b[33m${s}\x1b[0m`;
const bold  = (s) => `\x1b[1m${s}\x1b[0m`;

console.log('');
console.log(bold('Mergen publish pre-flight'));
console.log('');
for (const k of ok)    console.log(`  ${green('✓')} ${k}`);
for (const w of warns) console.log(`  ${yel('!')} ${w.label}\n      ${dim(w.hint)}`);
for (const f of fails) console.log(`  ${red('✗')} ${f.label}\n      ${dim(f.hint)}`);
console.log('');

if (fails.length > 0) {
  console.log(red(`Pre-flight FAILED — ${fails.length} blocking issue(s).`));
  process.exit(1);
}
if (warns.length > 0) {
  console.log(yel(`Pre-flight passed with ${warns.length} warning(s).`));
  console.log(dim('  Fix warnings before publishing if you want a clean v1.0.0.'));
}
console.log(green('Ready to publish.'));
console.log(dim('  Microsoft Marketplace: npm run publish:vscode'));
console.log(dim('  Open VSX:              npm run publish:openvsx'));
console.log(dim('  Both at once:          npm run publish:all'));
console.log('');
