/**
 * workers/notification-worker.ts — BullMQ worker for the mergen-notifications queue.
 *
 * Sends Slack thread replies and webhook notifications with up to 3 retries
 * using exponential back-off. Decouples Slack I/O from the hot path.
 */

import { Worker } from 'bullmq';
import { getRedisConnection, type NotificationJobData } from './queues.js';
import logger from '../sensor/logger.js';

export function startNotificationWorker(): Worker<NotificationJobData> {
  const worker = new Worker<NotificationJobData>(
    'mergen-notifications',
    async (job) => {
      const { pid, text, threadTs, channel } = job.data;
      // Dynamic import avoids circular dependencies at module load time.
      const { postThreadReply, postSimpleWebhookNotification } = await import('../intelligence/slack.js');
      if (threadTs) {
        // postThreadReply looks up the Slack thread by pid internally.
        await postThreadReply(pid, text);
      } else {
        // channel is used as the service name for webhook routing.
        await postSimpleWebhookNotification(channel ?? pid, text);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 10,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, pid: job?.data.pid, err }, 'notification-worker: job failed');
  });

  return worker;
}
