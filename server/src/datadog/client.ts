import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { DATA_DIR } from '../sensor/paths.js';
import { startClientSpan } from './otel-trace.js';

export interface DatadogConfig {
  apiKey: string;
  appKey: string;
  site: string;
}

export interface DdSpan {
  id: string;
  traceId: string;
  service: string;
  resourceName: string;
  durationNs: number;
  status: 'ok' | 'error' | 'warn';
  startNs: number;
  tags: Record<string, string>;
}

export interface DdLog {
  id: string;
  timestamp: string;
  message: string;
  status: string;
  service: string;
  tags: Record<string, string>;
  attributes: Record<string, unknown>;
}

function loadConfig(): DatadogConfig | null {
  if (process.env.DD_API_KEY && process.env.DD_APP_KEY) {
    return {
      apiKey: process.env.DD_API_KEY,
      appKey: process.env.DD_APP_KEY,
      site: process.env.DD_SITE ?? 'datadoghq.com',
    };
  }

  const configPath = path.join(DATA_DIR, 'config.json');
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
        datadog?: { apiKey?: string; appKey?: string; site?: string };
      };
      if (raw.datadog?.apiKey && raw.datadog?.appKey) {
        return {
          apiKey: raw.datadog.apiKey,
          appKey: raw.datadog.appKey,
          site: raw.datadog.site ?? 'datadoghq.com',
        };
      }
    } catch { /* ignore */ }
  }

  return null;
}

async function ddPost<T>(config: DatadogConfig, endpoint: string, body: unknown): Promise<T> {
  const url = `https://api.${config.site}${endpoint}`;
  const span = startClientSpan();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'DD-API-KEY': config.apiKey,
      'DD-APPLICATION-KEY': config.appKey,
      'traceparent': span.traceparent,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Datadog API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

export async function fetchSpans(opts: {
  service?: string;
  from: Date;
  to: Date;
  errorsOnly?: boolean;
  limit?: number;
}): Promise<DdSpan[]> {
  const config = loadConfig();
  if (!config) throw new Error('Datadog not configured. Run: mergen-server init');

  const queryParts: string[] = [];
  if (opts.service) queryParts.push(`service:${opts.service}`);
  if (opts.errorsOnly) queryParts.push('status:error');

  const raw = await ddPost<{
    data?: Array<{
      id: string;
      attributes: {
        service: string;
        resource_name: string;
        duration: number;
        status: string;
        start: number;
        tags: Record<string, string>;
        trace_id: string;
      };
    }>;
  }>(config, '/api/v2/spans', {
    filter: {
      from: opts.from.toISOString(),
      to: opts.to.toISOString(),
      query: queryParts.join(' ') || '*',
    },
    page: { limit: opts.limit ?? 100 },
    sort: '-timestamp',
  });

  return (raw.data ?? []).map((d) => ({
    id: d.id,
    traceId: d.attributes.trace_id,
    service: d.attributes.service,
    resourceName: d.attributes.resource_name,
    durationNs: d.attributes.duration,
    status: d.attributes.status as DdSpan['status'],
    startNs: d.attributes.start,
    tags: d.attributes.tags ?? {},
  }));
}

export async function fetchLogsByTraceId(opts: {
  traceId: string;
  from: Date;
  to: Date;
  errorsOnly?: boolean;
}): Promise<DdLog[]> {
  const config = loadConfig();
  if (!config) throw new Error('Datadog not configured. Run: mergen-server init');

  const queryParts = [`trace_id:${opts.traceId}`];
  if (opts.errorsOnly) queryParts.push('status:error');

  const raw = await ddPost<{
    data?: Array<{
      id: string;
      attributes: {
        timestamp: string;
        message: string;
        status: string;
        service: string;
        tags: string[];
        attributes: Record<string, unknown>;
      };
    }>;
  }>(config, '/api/v2/logs/events/search', {
    filter: {
      from: opts.from.toISOString(),
      to: opts.to.toISOString(),
      query: queryParts.join(' '),
    },
    page: { limit: 50 },
  });

  return (raw.data ?? []).map((d) => ({
    id: d.id,
    timestamp: d.attributes.timestamp,
    message: d.attributes.message,
    status: d.attributes.status,
    service: d.attributes.service,
    tags: Object.fromEntries(
      (d.attributes.tags ?? []).map((t) => {
        const idx = t.indexOf(':');
        return idx === -1 ? [t, ''] : [t.slice(0, idx), t.slice(idx + 1)];
      }),
    ),
    attributes: d.attributes.attributes ?? {},
  }));
}

export async function fetchLatestErrorTrace(
  service: string,
  windowMinutes = 10,
): Promise<{ traceId: string; spans: DdSpan[] } | null> {
  const to = new Date();
  const from = new Date(to.getTime() - windowMinutes * 60 * 1000);

  const errorSpans = await fetchSpans({ service, from, to, errorsOnly: true, limit: 50 });
  if (errorSpans.length === 0) return null;

  // Pick the trace with the most error spans
  const byTrace = new Map<string, number>();
  for (const s of errorSpans) {
    byTrace.set(s.traceId, (byTrace.get(s.traceId) ?? 0) + 1);
  }
  const bestTraceId = [...byTrace.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // Fetch all spans for that trace (not just errors, for full context)
  const allSpans = await fetchSpans({ service, from, to, limit: 200 });
  const traceSpans = allSpans.filter((s) => s.traceId === bestTraceId);

  return { traceId: bestTraceId, spans: traceSpans };
}

/**
 * Count error spans for a service in the last N minutes.
 * Used by the autopilot to validate a fix: if count drops to 0, incident is resolved.
 * Returns null when Datadog is not configured or the query fails.
 */
export async function fetchErrorCountSince(service: string, windowMinutes: number): Promise<number | null> {
  const config = loadConfig();
  if (!config) return null;

  const to = new Date();
  const from = new Date(to.getTime() - windowMinutes * 60_000);

  try {
    const raw = await ddPost<{ data?: unknown[] }>(config, '/api/v2/spans', {
      filter: {
        from: from.toISOString(),
        to: to.toISOString(),
        query: `service:${service} status:error`,
      },
      page: { limit: 1 },
      sort: '-timestamp',
    });
    return raw.data?.length ?? 0;
  } catch {
    return null;
  }
}

export async function testConnection(): Promise<void> {
  const config = loadConfig();
  if (!config) throw new Error('No credentials found');

  // Validate credentials by hitting the validate endpoint
  const res = await fetch(`https://api.${config.site}/api/v1/validate`, {
    headers: { 'DD-API-KEY': config.apiKey, 'DD-APPLICATION-KEY': config.appKey },
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Auth failed (${res.status}): ${body.slice(0, 100)}`);
  }
}

export function isConfigured(): boolean {
  return loadConfig() !== null;
}
