/**
 * safe-stringify.js
 * Serializes any value to a JSON-safe structure, handling:
 *   - Circular references
 *   - DOM nodes (replaced with [HTMLElement: tagName])
 *   - undefined, Symbol, Function (replaced with descriptive strings)
 *   - Errors (message + stack extracted)
 *   - Depth limit to prevent enormous payloads
 */

const MAX_DEPTH = 6;
const MAX_ARRAY_LENGTH = 50;
const MAX_STRING_LENGTH = 2000;

function safeValue(val, depth, seen) {
  if (depth > MAX_DEPTH) return '[MaxDepth]';

  // Primitives
  if (val === null) return null;
  if (val === undefined) return '[undefined]';

  const t = typeof val;
  if (t === 'boolean' || t === 'number') return val;
  if (t === 'bigint') return val.toString() + 'n';
  if (t === 'symbol') return val.toString();
  if (t === 'function') return `[Function: ${val.name || 'anonymous'}]`;

  if (t === 'string') {
    return val.length > MAX_STRING_LENGTH
      ? val.slice(0, MAX_STRING_LENGTH) + `…(+${val.length - MAX_STRING_LENGTH})`
      : val;
  }

  // Error
  if (val instanceof Error) {
    return { __error__: true, name: val.name, message: val.message, stack: val.stack ?? '' };
  }

  // DOM node
  if (typeof Node !== 'undefined' && val instanceof Node) {
    const tag = val.nodeName ?? 'Node';
    const id = val.id ? `#${val.id}` : '';
    const cls = val.className ? `.${String(val.className).split(' ').filter(Boolean).join('.')}` : '';
    return `[${tag}${id}${cls}]`;
  }

  // Circular reference guard
  if (seen.has(val)) return '[Circular]';
  seen.add(val);

  // Array
  if (Array.isArray(val)) {
    const result = val.slice(0, MAX_ARRAY_LENGTH).map((v) => safeValue(v, depth + 1, seen));
    if (val.length > MAX_ARRAY_LENGTH) result.push(`…(+${val.length - MAX_ARRAY_LENGTH} more)`);
    seen.delete(val);
    return result;
  }

  // Plain object / class instance
  const result = {};
  for (const key of Object.keys(val)) {
    try {
      result[key] = safeValue(val[key], depth + 1, seen);
    } catch {
      result[key] = '[GetterError]';
    }
  }
  seen.delete(val);
  return result;
}

/**
 * @param {unknown[]} args - console argument list
 * @returns {unknown[]} JSON-safe version of the arguments
 */
export function safeArgs(args) {
  const seen = new WeakSet();
  return Array.from(args).map((a) => safeValue(a, 0, seen));
}
