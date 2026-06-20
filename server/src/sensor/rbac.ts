/**
 * rbac.ts — Role-based access control for fix execution.
 *
 * Roles (least → most privileged):
 *   viewer    — read-only: dashboards, logs, timelines
 *   responder — can execute fixes, acknowledge and resolve incidents
 *   admin     — everything + manage RBAC membership
 *
 * If the RBAC file is absent or empty, all actors are implicitly treated as
 * admin (backwards-compatible default for self-hosted single-engineer installs).
 *
 * Actor identity is resolved from the x-mergen-member request header.
 * Autopilot fixes are tagged with the synthetic actor "autopilot" (admin role).
 *
 * Storage: ~/.mergen/rbac.json  (managed via GET/POST/PUT/DELETE /rbac/members)
 */

import fs from 'fs';
import { RBAC_FILE, DATA_DIR } from './paths.js';
import logger from './logger.js';

export type Role = 'viewer' | 'responder' | 'admin';

export interface RbacMember {
  id: string;   // email or username
  role: Role;
}

interface RbacStore {
  members: RbacMember[];
}

// Role hierarchy: higher index = more permissions
const ROLE_RANK: Record<Role, number> = { viewer: 0, responder: 1, admin: 2 };

// Tracks whether the last load attempt failed due to a corrupt/unreadable file
// (as opposed to the file simply not existing). Used to fail closed.
let _loadFailed = false;

function load(): RbacStore {
  if (!fs.existsSync(RBAC_FILE)) {
    _loadFailed = false;
    return { members: [] }; // no RBAC configured → open by design
  }
  try {
    const raw = fs.readFileSync(RBAC_FILE, 'utf8');
    _loadFailed = false;
    return JSON.parse(raw) as RbacStore;
  } catch (err) {
    _loadFailed = true;
    logger.error({ err }, 'rbac: RBAC file is unreadable — failing closed (all actors restricted to viewer)');
    return { members: [] };
  }
}

function save(store: RbacStore): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RBAC_FILE, JSON.stringify(store, null, 2), 'utf8');
    _loadFailed = false; // successful write → file is now readable again
  } catch (err) {
    logger.warn({ err }, 'rbac: failed to write rbac.json');
  }
}

export function listMembers(): RbacMember[] {
  return load().members;
}

export function upsertMember(id: string, role: Role): RbacMember {
  const store = load();
  const existing = store.members.find((m) => m.id === id);
  if (existing) {
    existing.role = role;
  } else {
    store.members.push({ id, role });
  }
  save(store);
  logger.info({ id, role }, 'rbac: member upserted');
  return { id, role };
}

export function removeMember(id: string): boolean {
  const store = load();
  const before = store.members.length;
  store.members = store.members.filter((m) => m.id !== id);
  if (store.members.length < before) {
    save(store);
    logger.info({ id }, 'rbac: member removed');
    return true;
  }
  return false;
}

/**
 * Resolve an actor's role.
 * - 'autopilot' always maps to admin (synthetic actor for autonomous execution).
 * - When RBAC is unconfigured (no members, file absent) all actors get admin
 *   — backwards-compatible default for single-user installs.
 * - When the RBAC file exists but is unreadable/corrupt, fails CLOSED:
 *   all actors get 'viewer' until the file is repaired.
 */
export function resolveRole(actor: string): Role {
  if (actor === 'autopilot') return 'admin';
  const store = load();
  if (_loadFailed) return 'viewer'; // corrupt file → fail closed
  if (store.members.length === 0) return 'admin'; // unconfigured → open
  const member = store.members.find((m) => m.id === actor);
  return member?.role ?? 'viewer'; // unknown actor → least privilege
}

/**
 * Returns true if the actor has at least the required role.
 */
export function hasPermission(actor: string, required: Role): boolean {
  const actual = resolveRole(actor);
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** Reset module state between tests. Not for production use. */
export function _resetForTesting(): void {
  _loadFailed = false;
}
