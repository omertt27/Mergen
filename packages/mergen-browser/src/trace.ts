/** Generate a random hex string of `bytes` bytes. Uses crypto.getRandomValues for security. */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  (crypto as Crypto).getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

export function generateTraceId(): string { return randomHex(16); } // 32-char hex
export function generateSpanId(): string  { return randomHex(8);  } // 16-char hex

export function makeTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

/** Current time in nanoseconds as a string (OTLP requires nanosecond timestamps). */
export function nowNano(): string {
  return String(BigInt(Math.round(performance.now() * 1e6)) + BigInt(Date.now()) * 1_000_000n);
}

/** Date.now() in nanoseconds as a string. */
export function msToNano(ms: number): string {
  return String(BigInt(Math.round(ms)) * 1_000_000n);
}
