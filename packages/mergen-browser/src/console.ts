import { OtlpExporter } from './exporter.js';

type Level = 'log' | 'warn' | 'error';

const LEVELS: Level[] = ['log', 'warn', 'error'];

function serialize(args: unknown[]): string {
  return args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

export function patchConsole(exporter: OtlpExporter): () => void {
  const originals = {} as Record<Level, (...args: unknown[]) => void>;

  for (const level of LEVELS) {
    originals[level] = console[level].bind(console);

    console[level] = (...args: unknown[]): void => {
      // Always call original first — Mergen must never suppress output.
      originals[level](...args);

      try {
        const body  = serialize(args);
        // Skip Mergen's own OTLP fetch logs to prevent feedback loops.
        if (body.includes('/v1/logs') || body.includes('/v1/traces')) return;

        const stack = level === 'error' && args[0] instanceof Error
          ? args[0].stack
          : new Error().stack?.split('\n').slice(2).join('\n');

        exporter.sendLog({
          timestampMs: Date.now(),
          level,
          body,
          stack: stack?.slice(0, 2000),
          url: location.href,
        });
      } catch { /* never crash the host page */ }
    };
  }

  return (): void => {
    for (const level of LEVELS) console[level] = originals[level];
  };
}
