/**
 * detector-plugins.ts — Custom detector plugin loader.
 *
 * Loads user-defined detector functions from ~/.mergen/detectors/*.js and
 * runs them alongside the built-in infra detectors in the causal pipeline.
 *
 * Plugin contract:
 *   - File extension: .js (ESM, Node 18+)
 *   - Must export a named `detect` function OR a default function
 *   - Signature: (events: InfraEvent[]) => Hypothesis | null
 *   - Errors are caught per-plugin — one broken plugin won't crash the pipeline
 *
 * Example plugin (~/.mergen/detectors/stripe-timeout.js):
 *
 *   export function detect(events) {
 *     const stripeErrors = events.filter(
 *       e => e.attributes.endpoint?.includes('stripe.com') && e.kind === 'upstream_error'
 *     );
 *     if (stripeErrors.length < 2) return null;
 *     return {
 *       tag: 'payment_gateway_timeout',
 *       summary: 'Stripe API timing out — check Stripe status page and API key validity',
 *       confidence: 'HIGH',
 *       confidenceScore: 0.85,
 *       evidence: [`${stripeErrors.length} Stripe errors in window`],
 *       causalPath: ['Stripe API unresponsive', 'Payment requests failing', 'Checkout broken'],
 *       fixHint: 'Check https://status.stripe.com — if up, verify STRIPE_SECRET_KEY is not expired',
 *     };
 *   }
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { DATA_DIR } from '../sensor/paths.js';
import logger from '../sensor/logger.js';
import type { InfraEvent } from '../sensor/infra-normalizer.js';
import type { Hypothesis } from './causal.js';
import type { InfraDetector } from './infra-detectors.js';

const PLUGINS_DIR = path.join(DATA_DIR, 'detectors');

let _plugins: InfraDetector[] = [];
let _loaded = false;

interface PluginModule {
  detect?: (events: InfraEvent[]) => Hypothesis | null;
  default?: (events: InfraEvent[]) => Hypothesis | null;
}

/**
 * Load plugins from ~/.mergen/detectors/*.js.
 * Safe to call multiple times — only loads once per process.
 * Call await loadPlugins() at startup.
 */
export async function loadPlugins(): Promise<void> {
  if (_loaded) return;
  _loaded = true;

  if (!fs.existsSync(PLUGINS_DIR)) {
    try { fs.mkdirSync(PLUGINS_DIR, { recursive: true, mode: 0o700 }); } catch {}
    return;
  }

  let files: string[];
  try {
    files = fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith('.js'));
  } catch (err) {
    logger.warn({ err }, 'detector-plugins: could not read detectors directory');
    return;
  }

  for (const file of files) {
    const filePath = path.join(PLUGINS_DIR, file);
    try {
      const url = pathToFileURL(filePath).href;
      const mod = await import(url) as PluginModule;
      const fn = mod.detect ?? mod.default;

      if (typeof fn !== 'function') {
        logger.warn({ file }, 'detector-plugins: no detect function exported — skipping');
        continue;
      }

      // Wrap in a named function so error logs show the plugin filename
      const pluginName = path.basename(file, '.js');
      const wrapped: InfraDetector = Object.assign(
        (events: InfraEvent[]) => fn(events),
        { name: `plugin:${pluginName}` },
      );

      _plugins.push(wrapped);
      logger.info({ plugin: pluginName }, 'detector-plugins: loaded');
    } catch (err) {
      logger.warn({ err, file }, 'detector-plugins: failed to load plugin — skipping');
    }
  }

  if (_plugins.length > 0) {
    logger.info({ count: _plugins.length, dir: PLUGINS_DIR }, 'detector-plugins: plugins ready');
  }
}

/** Returns the currently loaded plugin detectors. */
export function getPluginDetectors(): InfraDetector[] {
  return _plugins;
}

/** Run all plugins against the given events, catching errors per-plugin. */
export function runPlugins(events: InfraEvent[]): Hypothesis[] {
  const results: Hypothesis[] = [];
  for (const plugin of _plugins) {
    try {
      const h = plugin(events);
      if (h) results.push(h);
    } catch (err) {
      logger.warn({ err, plugin: plugin.name ?? 'unknown' }, 'detector-plugins: plugin threw');
    }
  }
  return results;
}
