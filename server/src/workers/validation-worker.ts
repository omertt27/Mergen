/**
 * workers/validation-worker.ts — BullMQ worker for the mergen-validation queue.
 *
 * Runs post-fix validation after the autopilot applies a remediation command.
 * Separated from the autopilot job so validation failures don't trigger a
 * retry of the full triage loop.
 */

import { Worker } from 'bullmq';
import { bullConnection, type ValidationJobData } from './queues.js';
import logger from '../sensor/logger.js';

export function startValidationWorker(): Worker<ValidationJobData> {
  const worker = new Worker<ValidationJobData>(
    'mergen-validation',
    async (job) => {
      const { service, pid, command, beforeCount, fixAppliedAt, tenantId } = job.data;
      const { runPostFixValidation } = await import('../intelligence/incident-autopilot.js');
      await runPostFixValidation({ service, pid, command, beforeCount, fixAppliedAt, tenantId });
    },
    {
      connection: bullConnection(),
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, pid: job?.data.pid, err }, 'validation-worker: job failed');
  });

  return worker;
}
