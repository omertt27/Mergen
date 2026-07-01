/**
 * workers/worker-registry.ts — Lifecycle management for all BullMQ workers.
 *
 * Call startWorkers() once after the HTTP server is ready.
 * Call stopWorkers() in the graceful shutdown handler before closing the HTTP server.
 */

import type { Worker } from 'bullmq';
import { startAutopilotWorker } from './autopilot-worker.js';
import { startNotificationWorker } from './notification-worker.js';
import { startValidationWorker } from './validation-worker.js';
import logger from '../sensor/logger.js';

const _workers: Worker[] = [];

export async function startWorkers(): Promise<void> {
  _workers.push(startAutopilotWorker());
  _workers.push(startNotificationWorker());
  _workers.push(startValidationWorker());
  logger.info({ count: _workers.length }, 'workers: all BullMQ workers started');
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(_workers.map((w) => w.close()));
  _workers.length = 0;
  logger.info('workers: all BullMQ workers stopped');
}
