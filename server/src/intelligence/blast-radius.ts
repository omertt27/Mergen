/**
 * blast-radius.ts — Structured impact model for every command Mergen considers.
 *
 * Why this exists:
 *   A FAANG SRE's first question before approving an automated fix is not
 *   "what will it do" but "what's the worst case if it goes wrong, and how
 *   quickly can we recover?" The 3-tier (restart/deploy/full) regex model
 *   answers the first question. This module answers the second.
 *
 *   computeBlastRadius() maps a command string to a structured BlastRadius
 *   object that tells the approver:
 *     - What scope is affected (pod, deployment, cluster, data)
 *     - Estimated downtime during rollout
 *     - Whether it's reversible and how long rollback takes
 *     - Whether data is at risk
 *     - How confident the model is in its assessment
 *
 * GET /blast-radius?command=<encoded> surfaces this via the API so orgs
 * can script their own pre-execution gates.
 */

import { deriveRollback } from './rollback.js';

export type ImpactScope =
  | 'pod'               // single container restart, recovers in seconds
  | 'deployment'        // all replicas of a service, brief rolling restart
  | 'namespace'         // multiple services affected
  | 'cluster'           // cluster-wide impact
  | 'config-change'     // dependency pin / env var — rolling restart triggered
  | 'data-write'        // SQL UPDATE/INSERT — reversible if backed up
  | 'data-destructive'  // DROP TABLE / TRUNCATE — not reversible
  | 'unknown';

export interface BlastRadius {
  command: string;
  scope: ImpactScope;
  affectedResources: string[];
  estimatedDowntimeMs: number | null;
  reversible: boolean;
  rollbackCommand: string | null;
  rollbackLatencyMs: number | null;
  dataAtRisk: boolean;
  modelConfidence: 'high' | 'medium' | 'low';
  summary: string;
}

interface BlastRule {
  pattern: RegExp;
  scope: ImpactScope;
  estimatedDowntimeMs: number | null;
  reversible: boolean;
  rollbackLatencyMs: number | null;
  dataAtRisk: boolean;
  modelConfidence: 'high' | 'medium' | 'low';
  extractResources?: (match: RegExpMatchArray) => string[];
}

const RULES: BlastRule[] = [
  // kubectl rollout restart deploy/<name>
  {
    pattern: /kubectl\s+rollout\s+restart\s+(?:deploy(?:ment)?\/(\S+)|deploy(?:ment)?\s+(\S+))/i,
    scope: 'deployment',
    estimatedDowntimeMs: 30_000,
    reversible: true,
    rollbackLatencyMs: 60_000,
    dataAtRisk: false,
    modelConfidence: 'high',
    extractResources: (m) => [`deploy/${m[1] ?? m[2] ?? 'unknown'}`],
  },
  // kubectl set image deploy/<name>
  {
    pattern: /kubectl\s+set\s+image\s+(?:deploy(?:ment)?\/(\S+)|deploy(?:ment)?\s+(\S+))/i,
    scope: 'deployment',
    estimatedDowntimeMs: 30_000,
    reversible: true,
    rollbackLatencyMs: 60_000,
    dataAtRisk: false,
    modelConfidence: 'high',
    extractResources: (m) => [`deploy/${m[1] ?? m[2] ?? 'unknown'}`],
  },
  // kubectl set env deploy/<name>
  {
    pattern: /kubectl\s+set\s+env\s+(?:deploy(?:ment)?\/(\S+)|deploy(?:ment)?\s+(\S+))/i,
    scope: 'config-change',
    estimatedDowntimeMs: 30_000,
    reversible: true,
    rollbackLatencyMs: 60_000,
    dataAtRisk: false,
    modelConfidence: 'high',
    extractResources: (m) => [`deploy/${m[1] ?? m[2] ?? 'unknown'}`],
  },
  // kubectl delete deployment/<name>
  {
    pattern: /kubectl\s+delete\s+deploy(?:ment)?(?:\/(\S+)|\s+(\S+))/i,
    scope: 'deployment',
    estimatedDowntimeMs: null,
    reversible: false,
    rollbackLatencyMs: null,
    dataAtRisk: false,
    modelConfidence: 'high',
    extractResources: (m) => [`deploy/${m[1] ?? m[2] ?? 'unknown'}`],
  },
  // kubectl delete pod
  {
    pattern: /kubectl\s+delete\s+pod/i,
    scope: 'pod',
    estimatedDowntimeMs: 5_000,
    reversible: true,
    rollbackLatencyMs: 10_000,
    dataAtRisk: false,
    modelConfidence: 'high',
  },
  // helm upgrade <release>
  {
    pattern: /helm\s+upgrade\s+(\S+)/i,
    scope: 'deployment',
    estimatedDowntimeMs: 60_000,
    reversible: true,
    rollbackLatencyMs: 120_000,
    dataAtRisk: false,
    modelConfidence: 'high',
    extractResources: (m) => [`helm-release/${m[1]}`],
  },
  // helm rollback <release>
  {
    pattern: /helm\s+rollback\s+(\S+)/i,
    scope: 'deployment',
    estimatedDowntimeMs: 30_000,
    reversible: true,
    rollbackLatencyMs: 60_000,
    dataAtRisk: false,
    modelConfidence: 'high',
    extractResources: (m) => [`helm-release/${m[1]}`],
  },
  // npm install pkg@ver
  {
    pattern: /npm\s+install\s+(\S+@\S+)/i,
    scope: 'config-change',
    estimatedDowntimeMs: 120_000,
    reversible: true,
    rollbackLatencyMs: 300_000,
    dataAtRisk: false,
    modelConfidence: 'medium',
    extractResources: (m) => [`npm:${m[1]}`],
  },
  // pip install pkg==ver
  {
    pattern: /pip\s+install\s+(\S+==[^\s]+)/i,
    scope: 'config-change',
    estimatedDowntimeMs: 120_000,
    reversible: true,
    rollbackLatencyMs: 300_000,
    dataAtRisk: false,
    modelConfidence: 'medium',
    extractResources: (m) => [`pip:${m[1]}`],
  },
  // yarn add pkg@ver
  {
    pattern: /yarn\s+add\s+(\S+@\S+)/i,
    scope: 'config-change',
    estimatedDowntimeMs: 120_000,
    reversible: true,
    rollbackLatencyMs: 300_000,
    dataAtRisk: false,
    modelConfidence: 'medium',
    extractResources: (m) => [`yarn:${m[1]}`],
  },
  // pm2 / systemctl / service restart
  {
    pattern: /(?:pm2\s+(?:restart|reload)\s+(\S+)|systemctl\s+(?:restart|reload)\s+(\S+)|service\s+(\S+)\s+(?:restart|reload))/i,
    scope: 'pod',
    estimatedDowntimeMs: 5_000,
    reversible: true,
    rollbackLatencyMs: 10_000,
    dataAtRisk: false,
    modelConfidence: 'high',
    extractResources: (m) => [`service/${m[1] ?? m[2] ?? m[3] ?? 'unknown'}`],
  },
  // docker restart <container>
  {
    pattern: /docker\s+restart\s+(\S+)/i,
    scope: 'pod',
    estimatedDowntimeMs: 5_000,
    reversible: true,
    rollbackLatencyMs: 10_000,
    dataAtRisk: false,
    modelConfidence: 'high',
    extractResources: (m) => [`container/${m[1]}`],
  },
  // SQL DROP / TRUNCATE
  {
    pattern: /(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE(?:\s+TABLE)?)\s+(\S+)?/i,
    scope: 'data-destructive',
    estimatedDowntimeMs: 0,
    reversible: false,
    rollbackLatencyMs: null,
    dataAtRisk: true,
    modelConfidence: 'high',
    extractResources: (m) => m[1] ? [`table/${m[1]}`] : [],
  },
  // SQL UPDATE / INSERT
  {
    pattern: /(?:UPDATE|INSERT\s+INTO)\s+(\S+)/i,
    scope: 'data-write',
    estimatedDowntimeMs: 0,
    reversible: true,
    rollbackLatencyMs: null,
    dataAtRisk: true,
    modelConfidence: 'medium',
    extractResources: (m) => [`table/${m[1]}`],
  },
];

function buildSummary(scope: ImpactScope, estimatedDowntimeMs: number | null, reversible: boolean, dataAtRisk: boolean): string {
  const dt = estimatedDowntimeMs !== null
    ? `~${Math.round(estimatedDowntimeMs / 1000)}s downtime`
    : 'unpredictable downtime';
  const rev = reversible ? 'reversible' : 'irreversible';
  const data = dataAtRisk ? ', data at risk' : '';
  return `${scope} scope, ${dt}, ${rev}${data}.`;
}

export function computeBlastRadius(
  command: string,
  context?: { service?: string; namespace?: string; environment?: string },
): BlastRadius {
  for (const rule of RULES) {
    const match = command.match(rule.pattern);
    if (!match) continue;

    const resources = rule.extractResources ? rule.extractResources(match) : [];
    if (resources.length === 0 && context?.service) resources.push(context.service);

    const rollbackStrategy = deriveRollback(command, '');
    const rollbackCommand = rollbackStrategy.type === 'command' ? rollbackStrategy.command : null;

    return {
      command,
      scope:               rule.scope,
      affectedResources:   resources,
      estimatedDowntimeMs: rule.estimatedDowntimeMs,
      reversible:          rule.reversible,
      rollbackCommand,
      rollbackLatencyMs:   rule.rollbackLatencyMs,
      dataAtRisk:          rule.dataAtRisk,
      modelConfidence:     rule.modelConfidence,
      summary:             buildSummary(rule.scope, rule.estimatedDowntimeMs, rule.reversible, rule.dataAtRisk),
    };
  }

  // Unrecognized command — use deriveRollback to check reversibility
  const rollbackStrategy = deriveRollback(command, '');
  const rollbackCommand = rollbackStrategy.type === 'command' ? rollbackStrategy.command : null;
  return {
    command,
    scope:               'unknown',
    affectedResources:   context?.service ? [context.service] : [],
    estimatedDowntimeMs: null,
    reversible:          rollbackCommand !== null,
    rollbackCommand,
    rollbackLatencyMs:   null,
    dataAtRisk:          false,
    modelConfidence:     'low',
    summary:             buildSummary('unknown', null, rollbackCommand !== null, false),
  };
}
