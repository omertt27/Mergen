/**
 * check-arch.ts — CLI script for architectural boundary enforcement.
 *
 * Usage:
 *   npm run check:arch
 *   npm run check:arch -- --srcDir /path/to/src
 *
 * Exits with code 1 if any violations are found (suitable for CI/pre-commit hooks).
 */

import path from 'path';
import { checkBoundaries, formatBoundaryReport } from '../intelligence/arch-boundaries.js';

const args = process.argv.slice(2);
const srcDirFlag = args.indexOf('--srcDir');
const srcDir = srcDirFlag !== -1 && args[srcDirFlag + 1]
  ? args[srcDirFlag + 1]
  : path.resolve(process.cwd(), 'src');

console.log(`\nChecking architectural boundaries in: ${srcDir}\n`);

const result = checkBoundaries({ srcDir });
const report = formatBoundaryReport(result, srcDir);
console.log(report);

if (result.violations.length > 0) {
  console.error(`\n✖ ${result.violations.length} violation(s) found. Fix before committing.\n`);
  process.exit(1);
} else {
  console.log(`\n✔ ${result.filesChecked} files checked. No violations.\n`);
  process.exit(0);
}
