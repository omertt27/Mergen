/**
 * background.js — Mergen service worker
 * Responsibilities:
 *   1. Open welcome page on first install
 *   2. Poll /health every 10 s → update badge colour + title + compute event rate
 *   3. Relay port-change messages to content scripts
 */

const DEFAULT_PORT     = 3000;
const POLL_INTERVAL_MS = 10_000;
const WINDOW_POLLS     = 6; // 6 × 10 s = 60 s rolling window for rate

// ── First install → open welcome page ────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

// ── Rolling event-rate computation ───────────────────────────────────────────
// Tracks {buffered, lastEventAt} across polls and computes approximate events/min.
// Uses delta in buffered count when the buffer has headroom; falls back to
// counting polls where lastEventAt changed when the buffer is saturated.

async function computeRate(buffered, lastEventAt) {
  const { pollHistory = [] } = await chrome.storage.session.get('pollHistory').catch(() => ({}));
  const now = Date.now();

  pollHistory.push({ buffered, lastEventAt, ts: now });
  while (pollHistory.length > WINDOW_POLLS) pollHistory.shift();
  await chrome.storage.session.set({ pollHistory }).catch(() => {});

  if (pollHistory.length < 2) return null;

  const oldest = pollHistory[0];
  const windowSec = (now - oldest.ts) / 1000;
  if (windowSec < 5) return null;

  // Primary: delta in buffered count (accurate when buffer has room)
  const delta = buffered - oldest.buffered;
  if (delta > 0) return Math.max(1, Math.round((delta / windowSec) * 60));

  // Fallback: count polls where lastEventAt changed (buffer saturated / events evicted)
  let changedPolls = 0;
  for (let i = 1; i < pollHistory.length; i++) {
    if (pollHistory[i].lastEventAt !== pollHistory[i - 1].lastEventAt) changedPolls++;
  }
  if (changedPolls > 0) return Math.max(1, Math.round((changedPolls / (windowSec / POLL_INTERVAL_MS * 1000)) * 6));

  return 0;
}

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

    const data        = await res.json();
    const errorCount  = (data.errors ?? 0) + (data.networkErrors ?? 0);
    const lastEventAt = data.lastEventAt ?? null;
    const buffered    = data.buffered    ?? 0;

    // Active = last event received within 60 s
    const isActive  = lastEventAt && (Date.now() - lastEventAt) < 60_000;
    const evPerMin  = await computeRate(buffered, lastEventAt);

    // Badge: red on errors, green when active, grey when idle
    const badgeColor = errorCount > 0 ? '#f87171' : (isActive ? '#4ade80' : '#94a3b8');
    const badgeText  = errorCount > 0 ? String(Math.min(errorCount, 99)) : (isActive ? '●' : '✓');

    const rateStr  = (evPerMin !== null && evPerMin > 0) ? ` · ~${evPerMin} evt/min` : '';
    const state    = isActive ? 'Active' : 'Connected';
    const title    = `Mergen — ${state}${rateStr} · ${data.errors ?? 0} error(s), ${data.warnings ?? 0} warning(s)`;

    chrome.action.setBadgeBackgroundColor({ color: badgeColor });
    chrome.action.setBadgeText({ text: badgeText });
    chrome.action.setTitle({ title });

    // Store for popup to read without re-fetching
    await chrome.storage.session.set({
      mergenLiveStatus: { isActive, eventsPerMin: evPerMin, lastEventAt, errorCount, port },
    }).catch(() => {});

  } catch {
    chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
    chrome.action.setBadgeText({ text: '✗' });
    chrome.action.setTitle({ title: 'Mergen — Server not running' });
    await chrome.storage.session.set({ mergenLiveStatus: null }).catch(() => {});
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
