/**
 * paths.ts — Single source of truth for all persisted file paths.
 *
 * Previously each module independently constructed these paths, risking drift.
 * Import from here; never re-derive os.homedir() + '.mergen' elsewhere.
 */

import path from 'path';
import os from 'os';

export const DATA_DIR     = path.join(os.homedir(), '.mergen');
export const LICENSE_FILE = path.join(DATA_DIR, 'license.json');
export const USAGE_FILE   = path.join(DATA_DIR, 'usage.json');
export const TEAM_FILE    = path.join(DATA_DIR, 'team.json');
export const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry.json');
/** Shared secret written on first start; read by the VS Code extension
 *  to authenticate requests to mutating endpoints. */
export const SECRET_FILE  = path.join(DATA_DIR, 'secret');

/** SQLite database for 1-hour event history (beyond the 200-event ring buffer). */
export const HISTORY_DB   = path.join(DATA_DIR, 'history.db');

/** In-memory ring buffer snapshot — survives restarts within SESSION_MAX_AGE_MS. */
export const SESSION_FILE = path.join(DATA_DIR, 'session.json');

/** Directory of timestamped session archives for replay ("what happened at 3pm?"). */
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

/** Append-only audit log for enterprise compliance (JSONL, rolls at 10 MB). */
export const AUDIT_LOG = path.join(DATA_DIR, 'audit.log');

/** Persistent service dependency graph — built from backend spans and traceId joins. */
export const TOPOLOGY_FILE = path.join(DATA_DIR, 'topology.json');

/** Mergen configuration file — stores integration credentials (Datadog, etc.). */
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/** RBAC role assignments — who can execute fixes vs. view-only. */
export const RBAC_FILE = path.join(DATA_DIR, 'rbac.json');

/** Structured record of every time an engineer overrode Mergen's recommendation.
 *  Includes categorical reason + outcome. Queried before autonomous execution. */
export const OVERRIDE_CORPUS_FILE = path.join(DATA_DIR, 'override-corpus.json');

/** Shadow mode log — every recommendation Mergen would have executed but didn't.
 *  Human verdicts on these entries feed back into the override corpus. */
export const SHADOW_LOG_FILE = path.join(DATA_DIR, 'shadow-log.json');
