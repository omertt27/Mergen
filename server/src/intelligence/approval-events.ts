import { EventEmitter } from 'events';

/**
 * Narrow shared bus between execution-gate.ts and the Slack notifier.
 * Neither module imports the other — both import this one.
 *
 * Events:
 *   'approval:expired'  (pid: string, text: string)
 */
export const approvalEvents = new EventEmitter();
