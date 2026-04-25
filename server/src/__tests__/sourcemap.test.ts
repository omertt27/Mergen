import { describe, it, expect } from 'vitest';
import { resolveStackTrace } from '../sourcemap.js';

describe('resolveStackTrace', () => {
  it('returns non-frame lines unchanged', async () => {
    const input = 'Error: something broke';
    const result = await resolveStackTrace(input);
    expect(result).toBe(input);
  });

  it('annotates frames with no sourcemap available', async () => {
    const frame = '    at doSomething (http://localhost:5173/bundle.js:1:999)';
    const result = await resolveStackTrace(frame);
    // No .map file present in test env — should annotate gracefully
    expect(result).toContain('[no sourcemap found]');
  });

  it('handles mixed stacks', async () => {
    const stack = [
      'Error: test error',
      '    at foo (http://localhost/app.js:2:10)',
      '    at bar (http://localhost/app.js:5:20)',
    ].join('\n');
    const result = await resolveStackTrace(stack);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
    // First line is not a frame — should be unchanged
    expect(lines[0]).toBe('Error: test error');
  });
});
