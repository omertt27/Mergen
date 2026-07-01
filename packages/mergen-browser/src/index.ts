/**
 * @mergen/browser — Zero-extension browser observability for AI-assisted debugging.
 *
 * Instruments console and network without a browser extension.
 * Posts standard OTLP JSON to the Mergen server (or any OTel-compatible backend).
 *
 * Usage:
 *   import { init } from '@mergen/browser';
 *   init(); // defaults: endpoint=http://localhost:3000, service=window.location.hostname
 *
 * Or via CDN:
 *   <script src="https://unpkg.com/@mergen/browser/dist/mergen-browser.umd.js"></script>
 *   <script>Mergen.init();</script>
 */

import { OtlpExporter }  from './exporter.js';
import { patchConsole }  from './console.js';
import { patchFetch, patchXHR } from './network.js';

export interface MergenConfig {
  /** OTLP endpoint base URL. Default: http://localhost:3000 */
  endpoint?: string;
  /** Service name. Default: window.location.hostname */
  service?: string;
  /**
   * License key used to attribute this browser service to a plan. Sent as the
   * `x-mergen-license` header so the server can enforce per-plan limits. Use a
   * public/browser-scoped key — never a secret admin key in client-side code.
   */
  licenseKey?: string;
  /** Intercept console.log/warn/error. Default: true */
  captureConsole?: boolean;
  /** Intercept fetch and XMLHttpRequest. Default: true */
  captureNetwork?: boolean;
}

let _teardown: (() => void) | null = null;

export function init(config: MergenConfig = {}): void {
  // Idempotent — calling init() twice is a no-op.
  if (_teardown) return;

  const endpoint       = config.endpoint ?? 'http://localhost:3000';
  const service        = config.service  ?? (typeof location !== 'undefined' ? location.hostname : 'browser');
  const captureConsole = config.captureConsole !== false;
  const captureNetwork = config.captureNetwork !== false;

  const exporter = new OtlpExporter({ endpoint, service, licenseKey: config.licenseKey });

  const teardowns: Array<() => void> = [];
  if (captureConsole) teardowns.push(patchConsole(exporter));
  if (captureNetwork) {
    teardowns.push(patchFetch(exporter));
    teardowns.push(patchXHR(exporter));
  }

  _teardown = (): void => { teardowns.forEach(fn => fn()); _teardown = null; };
}

/** Remove all patches and stop sending telemetry. */
export function shutdown(): void {
  _teardown?.();
}

export type { MergenConfig as Config };
