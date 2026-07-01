/**
 * workers/queues.ts — Central BullMQ queue definitions.
 *
 * Imported by both the API layer (to enqueue) and the worker layer (to consume).
 * Queue instances are created lazily so that the module can be imported without
 * a Redis connection in local / non-BullMQ mode.
 */

import { Redis } from 'ioredis';
import { Queue, type ConnectionOptions } from 'bullmq';

// BullMQ bundles its own ioredis typings; the top-level ioredis instance is a
// valid runtime connection but its *type* identity differs across that version
// boundary. Cast the live instance to BullMQ's ConnectionOptions at the seam.
export function bullConnection(): ConnectionOptions {
  return getRedisConnection() as unknown as ConnectionOptions;
}

let _connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!_connection) {
    const url = process.env.MERGEN_REDIS_URL;
    if (!url) throw new Error('MERGEN_REDIS_URL is not set');
    _connection = new Redis(url, { maxRetriesPerRequest: null });
  }
  return _connection;
}

export function closeRedisConnection(): Promise<void> {
  if (_connection) {
    const c = _connection;
    _connection = null;
    return c.quit().then(() => undefined);
  }
  return Promise.resolve();
}

// ── Job data types ─────────────────────────────────────────────────────────────

export interface AutopilotJobData {
  service: string;
  pid: string;
  firedAt: number;
  tenantId?: string;
  cwd?: string;
}

export interface NotificationJobData {
  pid: string;
  text: string;
  /** When set, post as a thread reply (looked up by pid). */
  threadTs?: string;
  /**
   * For thread replies: the Slack channel the thread lives in.
   * For webhook notifications: the service name used for webhook routing.
   */
  channel?: string;
}

export interface ValidationJobData {
  service: string;
  pid: string;
  command: string;
  firedAt: number;
  beforeCount: number;
  fixAppliedAt: number;
  tenantId?: string;
}

// ── Queue instances (created lazily when MERGEN_REDIS_URL is set) ──────────────

let _autopilotQueue: Queue<AutopilotJobData> | null = null;
let _notificationQueue: Queue<NotificationJobData> | null = null;
let _validationQueue: Queue<ValidationJobData> | null = null;

export function getAutopilotQueue(): Queue<AutopilotJobData> {
  if (!_autopilotQueue) {
    _autopilotQueue = new Queue<AutopilotJobData>('mergen-autopilot', {
      connection: bullConnection(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 1000, age: 86400 },
        removeOnFail: { count: 500 },
      },
    }) as Queue<AutopilotJobData>;
  }
  return _autopilotQueue;
}

export function getNotificationQueue(): Queue<NotificationJobData> {
  if (!_notificationQueue) {
    _notificationQueue = new Queue<NotificationJobData>('mergen-notifications', {
      connection: bullConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 200 },
      },
    }) as Queue<NotificationJobData>;
  }
  return _notificationQueue;
}

export function getValidationQueue(): Queue<ValidationJobData> {
  if (!_validationQueue) {
    _validationQueue = new Queue<ValidationJobData>('mergen-validation', {
      connection: bullConnection(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 200 },
      },
    }) as Queue<ValidationJobData>;
  }
  return _validationQueue;
}
