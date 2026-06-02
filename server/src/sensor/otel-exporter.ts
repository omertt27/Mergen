/**
 * otel-exporter.ts — OpenTelemetry log export for Mergen events.
 *
 * When configured (via POST /otel-config), each ingested BrowserEvent is
 * forwarded to an OTLP-compatible collector (Jaeger, Grafana Loki, Honeycomb,
 * Datadog OTLP endpoint, etc.).
 *
 * Architecture:
 *   - Zero-overhead when not configured (early return on unconfigured state).
 *   - One LoggerProvider per configuration; destroyed and recreated on re-config.
 *   - Gated behind Solo Pro / Team plan.
 *
 * Usage:
 *   POST /otel-config { endpoint, headers?, serviceName? }
 *   DELETE /otel-config   → disable
 *   GET /otel-config      → current state
 */

import type { BrowserEvent } from './buffer.js';
import logger from './logger.js';

// ── Config types ─────────────────────────────────────────────────────────────

export interface OtelConfig {
  endpoint: string;           // OTLP HTTP endpoint, e.g. "http://localhost:4318/v1/logs"
  headers?: Record<string, string>;
  serviceName?: string;
  enabled: boolean;
  configuredAt: string;
}

let _config: OtelConfig | null = null;

// Lazy-loaded OTel instances (avoid import overhead when not used)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _loggerProvider: any | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _otelLogger: any | null = null;

export function getOtelConfig(): OtelConfig | null { return _config; }

export function isOtelEnabled(): boolean { return _config?.enabled === true; }

// ── Provider lifecycle ────────────────────────────────────────────────────────

async function createProvider(cfg: OtelConfig): Promise<void> {
  // Tear down existing provider before creating a new one
  if (_loggerProvider) {
    await _loggerProvider.shutdown().catch(() => { /* ignore */ });
    _loggerProvider = null;
    _otelLogger = null;
  }

  const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http');
  const { LoggerProvider, SimpleLogRecordProcessor } = await import('@opentelemetry/sdk-logs');
  const resourcesModule = await import('@opentelemetry/resources');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Resource = (resourcesModule as any).Resource;

  const exporter = new OTLPLogExporter({
    url: cfg.endpoint,
    headers: cfg.headers ?? {},
  });

  const resource = Resource ? new Resource({
    'service.name': cfg.serviceName ?? 'mergen',
    'service.version': '1.0.0',
    'deployment.environment': 'development',
  }) : undefined;

  _loggerProvider = new LoggerProvider({ resource }) as any;
  (_loggerProvider as any).addLogRecordProcessor(new SimpleLogRecordProcessor(exporter));

  const { logs } = await import('@opentelemetry/api-logs');
  logs.setGlobalLoggerProvider(_loggerProvider);
  _otelLogger = _loggerProvider.getLogger('mergen.browser');
  logger.info({ endpoint: cfg.endpoint, service: cfg.serviceName ?? 'mergen' }, 'OTel log exporter configured');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function configureOtel(cfg: OtelConfig): Promise<void> {
  _config = cfg;
  if (cfg.enabled) {
    await createProvider(cfg);
  }
}

export async function disableOtel(): Promise<void> {
  _config = null;
  if (_loggerProvider) {
    await _loggerProvider.shutdown().catch(() => { /* ignore */ });
    _loggerProvider = null;
    _otelLogger = null;
  }
  logger.info('OTel log exporter disabled');
}

/**
 * Export a single BrowserEvent as an OTLP log record.
 * No-op when OTel is not configured.
 */
export function exportToOtel(event: BrowserEvent): void {
  if (!_otelLogger || !_config?.enabled) return;

  try {
    // Import is already done at provider creation; safe to access SeverityNumber directly
    const severityMap: Record<string, number> = {
      error: 16, // SeverityNumber.ERROR
      warn:  13, // SeverityNumber.WARN
      log:   9,  // SeverityNumber.INFO
      info:  9,  // SeverityNumber.INFO
      debug: 5,  // SeverityNumber.DEBUG
    };

    const isNetwork = event.type === 'network';
    const isConsole = event.type === 'console';
    const eventUrl = 'url' in event ? event.url : undefined;

    const severityText = isConsole ? ((event as any).level ?? 'log') : 'info';
    const severityNumber = isConsole
      ? (severityMap[(event as any).level ?? 'log'] ?? 9)
      : 9;

    const body = isConsole
      ? (event as any).args.map((a: unknown) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
      : isNetwork
        ? `${(event as any).method} ${event.url} → ${(event as any).status}`
        : event.type === 'context'
          ? `context: ${event.url}`
          : event.type === 'diagnostic'
            ? `${event.source} ${event.file}:${event.line}:${event.column} ${event.message}`
            : event.type === 'terminal'
              ? `${event.terminalName}: ${event.data}`
              : event.type === 'test_result'
                ? `${event.runner} ${event.status} ${event.name}`
                : event.type === 'process_exit'
                  ? `${event.process} exited (${event.reason})`
                  : `${event.type} event`;

    _otelLogger.emit({
      severityNumber,
      severityText,
      body,
      timestamp: new Date(event.timestamp),
      attributes: {
        ...(eventUrl ? { 'browser.url': eventUrl } : {}),
        'mergen.event_type': event.type,
        ...(isConsole && (event as any).stack ? { 'exception.stacktrace': (event as any).stack } : {}),
        ...(isNetwork ? {
          'http.method': (event as any).method,
          'http.url': event.url,
          'http.status_code': (event as any).status,
        } : {}),
      },
    });
  } catch (err) {
    // Non-fatal — OTel export errors should never affect the main ingest path
    logger.warn({ err }, 'OTel export failed');
  }
}
