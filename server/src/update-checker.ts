/**
 * update-checker.ts — Check for new Mergen releases
 *
 * Checks GitHub releases API once per day and notifies if update available.
 * Respects NO_UPDATE_NOTIFIER env var.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const GITHUB_API = 'https://api.github.com/repos/omertt27/Mergen/releases/latest';
const CACHE_DIR = resolve(homedir(), '.mergen');
const CACHE_FILE = resolve(CACHE_DIR, 'update-check.json');

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
  notified: boolean;
}

/**
 * Check for updates and return true if new version available
 */
export async function checkForUpdates(currentVersion: string): Promise<string | null> {
  // Skip if disabled
  if (process.env.NO_UPDATE_NOTIFIER === '1' || process.env.NO_UPDATE_NOTIFIER === 'true') {
    return null;
  }

  // Skip in CI environments
  if (process.env.CI === 'true' || process.env.CI === '1') {
    return null;
  }

  try {
    // Read cache
    const cache = readCache();

    // Check if we checked recently (within 24h)
    const now = Date.now();
    if (cache && now - cache.lastCheck < UPDATE_CHECK_INTERVAL) {
      // If we already know about an update and haven't notified, notify now
      if (cache.latestVersion && !cache.notified && isNewer(cache.latestVersion, currentVersion)) {
        markNotified(cache.latestVersion);
        return cache.latestVersion;
      }
      return null;
    }

    // Fetch latest release from GitHub
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout

    const response = await fetch(GITHUB_API, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mergen-Update-Checker' },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      // Silently fail - don't bother user with update check failures
      return null;
    }

    const data = await response.json() as { tag_name: string };
    const latestVersion = data.tag_name.replace(/^v/, ''); // Remove 'v' prefix

    // Write cache
    writeCache({
      lastCheck: now,
      latestVersion,
      notified: false,
    });

    // Return new version if available
    if (isNewer(latestVersion, currentVersion)) {
      markNotified(latestVersion);
      return latestVersion;
    }

    return null;
  } catch (err) {
    // Silently fail - update checks should never break the app
    return null;
  }
}

/**
 * Compare semantic versions (e.g., "1.2.3" vs "1.2.4")
 */
function isNewer(latest: string, current: string): boolean {
  const latestParts = latest.split('.').map(Number);
  const currentParts = current.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const l = latestParts[i] || 0;
    const c = currentParts[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }

  return false;
}

function readCache(): UpdateCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const content = readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // Silently fail
  }
}

function markNotified(version: string): void {
  const cache = readCache();
  if (cache && cache.latestVersion === version) {
    writeCache({ ...cache, notified: true });
  }
}

/**
 * Format update notification message
 */
export function formatUpdateMessage(currentVersion: string, latestVersion: string): string {
  return `
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   📦 Mergen update available: ${currentVersion} → ${latestVersion}         │
│                                                         │
│   Update now:                                           │
│   $ npx mergen-server@latest                            │
│                                                         │
│   Or globally:                                          │
│   $ npm install -g mergen-server@latest                 │
│                                                         │
│   Changelog:                                            │
│   https://github.com/omertt27/Mergen/releases          │
│                                                         │
└─────────────────────────────────────────────────────────┘
`;
}
