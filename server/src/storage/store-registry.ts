/**
 * store-registry.ts — Module-level singleton registry for the active Stores bundle.
 *
 * Usage:
 *   // In index.ts (boot):
 *   import { createStores } from './storage/store-factory.js';
 *   import { setStores } from './storage/store-registry.js';
 *   setStores(createStores());
 *
 *   // Anywhere else:
 *   import { getStores } from './storage/store-registry.js';
 *   const { events, incidents, overrides, approvals } = getStores();
 */

import type { Stores } from './store-factory.js';

let _stores: Stores | null = null;

export function setStores(s: Stores): void {
  _stores = s;
}

export function getStores(): Stores {
  if (!_stores) {
    throw new Error('Stores not initialized — call setStores() before getStores()');
  }
  return _stores;
}
