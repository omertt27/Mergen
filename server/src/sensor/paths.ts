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
