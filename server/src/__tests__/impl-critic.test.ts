/**
 * impl-critic.test.ts — Tests for the post-implementation critic.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { critiqueImplementation, formatCritiqueReport } from '../intelligence/impl-critic.js';

const SRC_DIR = path.resolve(__dirname, '..');

function writeTempFile(content: string, ext = '.ts'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-test-'));
  const file = path.join(dir, `test${ext}`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

describe('critiqueImplementation', () => {
  it('returns a CritiqueReport with correct shape', () => {
    const report = critiqueImplementation({ files: [], srcDir: SRC_DIR });
    expect(Array.isArray(report.findings)).toBe(true);
    expect(typeof report.errors).toBe('number');
    expect(typeof report.warnings).toBe('number');
    expect(typeof report.passed).toBe('boolean');
    expect(typeof report.summary).toBe('string');
  });

  it('passes with no findings for an empty file list', () => {
    const report = critiqueImplementation({ files: [], srcDir: SRC_DIR });
    // Only session-level findings possible
    expect(report.errors).toBe(0);
  });

  it('detects empty catch blocks', () => {
    const file = writeTempFile(`
function doSomething() {
  try {
    riskyOperation();
  } catch (err) {}
}
`);
    const report = critiqueImplementation({ files: [file], srcDir: SRC_DIR });
    const securityFindings = report.findings.filter((f) => f.category === 'security');
    expect(securityFindings.some((f) => f.message.includes('empty catch') || f.message.toLowerCase().includes('silently'))).toBe(true);
  });

  it('detects eval() usage', () => {
    const file = writeTempFile(`
const result = eval(userInput);
`);
    const report = critiqueImplementation({ files: [file], srcDir: SRC_DIR });
    const evalFinding = report.findings.find((f) => f.message.includes('eval()'));
    expect(evalFinding).toBeDefined();
    expect(evalFinding?.severity).toBe('error');
  });

  it('detects innerHTML assignment', () => {
    const file = writeTempFile(`
element.innerHTML = userInput;
`);
    const report = critiqueImplementation({ files: [file], srcDir: SRC_DIR });
    const xssFinding = report.findings.find((f) => f.message.includes('XSS'));
    expect(xssFinding).toBeDefined();
  });

  it('detects ADR-002 violation: Express response in intelligence file', () => {
    const file = writeTempFile(`
// This is in intelligence/
export function foo(res: any) {
  res.json({ ok: true });
}
`);
    // Manually place it in an intelligence path for the check
    const intelligenceFile = path.join(path.dirname(file), 'intelligence', 'test.ts');
    fs.mkdirSync(path.dirname(intelligenceFile), { recursive: true });
    fs.writeFileSync(intelligenceFile, fs.readFileSync(file, 'utf8'));

    const report = critiqueImplementation({ files: [intelligenceFile], srcDir: SRC_DIR });
    const adrFindings = report.findings.filter((f) => f.category === 'adr-violation');
    expect(adrFindings.some((f) => f.message.includes('ADR-002'))).toBe(true);
  });

  it('does not flag hardcoded returns in test files', () => {
    const file = writeTempFile(`
describe('foo', () => {
  it('returns true', () => {
    expect(getResult()).toBe(true);
    return true;
  });
});
`, '.test.ts');
    const report = critiqueImplementation({ files: [file], srcDir: SRC_DIR });
    const hardcoded = report.findings.filter((f) => f.category === 'hardcoded-return');
    expect(hardcoded).toHaveLength(0);
  });
});

describe('formatCritiqueReport', () => {
  it('shows PASS when no errors', () => {
    const report = { files: [], findings: [], errors: 0, warnings: 0, passed: true, summary: 'ok' };
    const text = formatCritiqueReport(report);
    expect(text).toContain('PASS');
  });

  it('shows FAIL when there are errors', () => {
    const report = {
      files: ['foo.ts'],
      findings: [{
        severity: 'error' as const,
        category: 'security' as const,
        file: 'foo.ts',
        message: 'eval() is forbidden',
        suggestion: 'Remove eval()',
      }],
      errors: 1,
      warnings: 0,
      passed: false,
      summary: '1 error',
    };
    const text = formatCritiqueReport(report);
    expect(text).toContain('FAIL');
    expect(text).toContain('eval()');
  });
});
