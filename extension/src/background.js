/**
 * background.js — Mergen service worker
 * Responsibilities:
 *   1. Open welcome page on first install
 *   2. Poll /health every 10 s → update badge colour + title
 *   3. Relay port-change messages to content scripts
 */

const DEFAULT_PORT = 3000;
const POLL_INTERVAL_MS = 10_000;

// ── First install → open welcome page ────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

// ── Health polling ────────────────────────────────────────────────────────────

async function getPort() {
  const { mergenPort = DEFAULT_PORT } = await chrome.storage.local.get('mergenPort');
  return mergenPort;
}

async function pollHealth() {
  const port = await getPort();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) throw new Error('not ok');

    const data = await res.json();
    const errorCount = (data.errors ?? 0) + (data.networkErrors ?? 0);

    // Green badge when connected
    chrome.action.setBadgeBackgroundColor({ color: errorCount > 0 ? '#f87171' : '#4ade80' });
    chrome.action.setBadgeText({ text: errorCount > 0 ? String(Math.min(errorCount, 99)) : '✓' });
    chrome.action.setTitle({ title: `Mergen — Connected · ${data.errors ?? 0} error(s), ${data.warnings ?? 0} warning(s)` });
  } catch {
    // Red badge when disconnected
    chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
    chrome.action.setBadgeText({ text: '✗' });
    chrome.action.setTitle({ title: 'Mergen — Server not running' });
  }
}

// Poll immediately and then on an alarm
pollHealth();

chrome.alarms.create('mergen-poll', { periodInMinutes: POLL_INTERVAL_MS / 60_000 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'mergen-poll') pollHealth();
});

// Also re-poll whenever storage changes (e.g. port was updated from popup)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.mergenPort) pollHealth();
});
