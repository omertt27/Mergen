/**
 * workers/autopilot-worker.ts — BullMQ worker for the mergen-autopilot queue.
 *
 * Dequeues autopilot jobs and runs the full incident triage loop inside a
 * durable, retryable worker context instead of the Express request handler.
 */

import { Worker } from 'bullmq';
import { getRedisConnection, type AutopilotJobData } from './queues.js';
import { runIncidentAutopilotLocal } from '../intelligence/incident-autopilot.js';
import logger from '../sensor/logger.js';

export function startAutopilotWorker(): Worker<AutopilotJobData> {
  const worker = new Worker<AutopilotJobData>(
    'mergen-autopilot',
    async (job) => {
      const { service, pid, firedAt, tenantId, cwd } = job.data;
      logger.info({ pid, service }, 'autopilot-worker: processing job');
      await runIncidentAutopilotLocal({ service, pid, firedAt, tenantId, cwd });
    },
    {
      connection: getRedisConnection(),
      concurrency: 3,
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, pid: job.data.pid }, 'autopilot-worker: job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, pid: job?.data.pid, err }, 'autopilot-worker: job failed');
  });

  return worker;
}
