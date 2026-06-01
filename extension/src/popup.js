/**
 * popup.js — Mergen extension popup controller
 */

const DEFAULT_PORT = 3000;

// ── DOM refs ────────────────────────────────────────────────────────────────
const statusPill    = document.getElementById('status-pill');
const statusText    = document.getElementById('status-text');
const serverUrl     = document.getElementById('server-url');
const mcpSub        = document.getElementById('mcp-sub');
const statErrors    = document.getElementById('stat-errors');
const statWarns     = document.getElementById('stat-warns');
const statNet       = document.getElementById('stat-net');
const statsGrid     = document.getElementById('stats-grid');
const activityRow   = document.getElementById('activity-row');
const lastEventText = document.getElementById('last-event-text');
const disconnectHint = document.getElementById('disconnect-hint');
const portInput     = document.getElementById('port-input');
const portSave      = document.getElementById('port-save');
const portSaved     = document.getElementById('port-saved');
const portRow       = document.getElementById('port-row');
const muteToggle    = document.getElementById('mute-toggle');
const toggleSub     = document.getElementById('toggle-sub');
const mutedBanner   = document.getElementById('muted-banner');
const noCsBanner    = document.getElementById('no-cs-banner');
const btnClear      = document.getElementById('btn-clear');
const btnReconnect  = document.getElementById('btn-reconnect');
const btnGear       = document.getElementById('btn-gear');
const welcomeLink   = document.getElementById('welcome-link');
const pricingLink   = document.getElementById('pricing-link');
const planBadge     = document.getElementById('plan-badge');
const teamDot       = document.getElementById('team-dot');
const teamBadge     = document.getElementById('team-badge');
const upgradeLink   = document.getElementById('upgrade-link');
const creditWrap    = document.getElementById('credit-wrap');
const creditCount   = document.getElementById('credit-count');
const creditFill    = document.getElementById('credit-fill');
const creditOverage = document.getElementById('credit-overage');
const signalsWrap   = document.getElementById('signals-wrap');
const signalsList   = document.getElementById('signals-list');
const signalsCount  = document.getElementById('signals-count');

// ── State ─────────────────────────────────────────────────────────────────────
let _prevBuffered = -1;
let _clearConfirmPending = false;
let _clearConfirmTimer = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getBaseUrl(port) { return `http://127.0.0.1:${port}`; }

function setStatus(state, label) {
  statusPill.className = `status-pill ${state}`;
  statusText.textContent = label;
  statusPill.querySelector('.dot').className = state === 'checking' ? 'dot pulse' : 'dot';
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5)  return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function updateMcpStatus(lastCallAt) {
  if (!lastCallAt) {
    mcpSub.textContent = 'MCP: not configured — run setup';
    mcpSub.className = 'mcp-sub unconfigured';
    return;
  }
  const sec = Math.floor((Date.now() - lastCallAt) / 1000);
  if (sec < 300) {
    mcpSub.textContent = `MCP: active (${timeAgo(lastCallAt)})`;
    mcpSub.className = 'mcp-sub active';
  } else {
    mcpSub.textContent = `MCP: last used ${timeAgo(lastCallAt)}`;
    mcpSub.className = 'mcp-sub';
  }
}

// ── Live signals ─────────────────────────────────────────────────────────────

function confidenceBand(c) {
  if (c >= 0.80) return 'high';
  if (c >= 0.55) return 'medium';
  return 'low';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function renderSignals(signals) {
  if (!signals || signals.length === 0) {
    signalsWrap.classList.remove('has-signals');
    signalsList.innerHTML = '';
    signalsCount.textContent = '';
    return;
  }
  signalsWrap.classList.add('has-signals');
  signalsCount.textContent = signals.length === 1 ? '1 finding' : `${signals.length} findings`;

  signalsList.innerHTML = signals.slice(0, 4).map((s) => {
    const band = confidenceBand(s.confidence ?? 0);
    const pct  = Math.round((s.confidence ?? 0) * 100);
    const tool = s.suggestedTool || 'analyze_runtime';
    return `
      <div class="signal ${band}">
        <div class="signal-msg">${escapeHtml(s.message)}</div>
        <div class="signal-action">→ ${escapeHtml(s.action)}</div>
        <button class="signal-cta" data-tool="${escapeHtml(tool)}">
          Run ${escapeHtml(tool)} (${pct}% confidence)
        </button>
      </div>
    `;
  }).join('');

  for (const btn of signalsList.querySelectorAll('.signal-cta')) {
    btn.addEventListener('click', async () => {
      const tool = btn.getAttribute('data-tool');
      const text = `Run ${tool} on the current Mergen buffer and explain the root cause.`;
      try {
        await navigator.clipboard.writeText(text);
        const original = btn.textContent;
        btn.textContent = '✓ Copied — paste into your AI chat';
        setTimeout(() => { btn.textContent = original; }, 2200);
      } catch {
        btn.textContent = `Paste in chat: ${tool}`;
      }
    });
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const { mergenPort = DEFAULT_PORT } = await chrome.storage.local.get('mergenPort');
  portInput.value = mergenPort;
  serverUrl.textContent = getBaseUrl(mergenPort);
  return mergenPort;
}

// ── Mute state ────────────────────────────────────────────────────────────────

async function loadMuteState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const key = `muted_${tab.id}`;
  const result = await chrome.storage.session.get(key).catch(() => ({}));
  const muted = result[key] === true;
  muteToggle.checked = !muted;
  if (muted) { toggleSub.textContent = 'Paused on this tab'; mutedBanner.style.display = 'block'; }
  else       { toggleSub.textContent = 'Active on current tab'; mutedBanner.style.display = 'none'; }
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function refresh(port) {
  setStatus('checking', 'Checking…');

  let health = null;
  try {
    const res = await fetch(`${getBaseUrl(port)}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) health = await res.json();
  } catch { /* offline */ }

  if (!health?.ok) {
    setStatus('disconnected', 'Offline');
    statErrors.textContent = statWarns.textContent = statNet.textContent = '—';
    btnClear.disabled = true;
    creditWrap.style.display = 'none';
    renderSignals([]);
    disconnectHint.style.display = 'block';
    activityRow.style.display = 'none';
    mcpSub.textContent = 'MCP: —';
    mcpSub.className = 'mcp-sub';
    _prevBuffered = -1;
    return;
  }

  disconnectHint.style.display = 'none';
  activityRow.style.display = 'flex';

  setStatus('connected', 'Connected');
  statErrors.textContent = health.errors ?? 0;
  statWarns.textContent  = health.warnings ?? 0;
  statNet.textContent    = health.networkErrors ?? 0;
  btnClear.disabled = false;

  // Flash stats row when new events arrive since last poll
  const newBuffered = health.buffered ?? 0;
  if (_prevBuffered >= 0 && newBuffered > _prevBuffered) {
    statsGrid.classList.remove('flash');
    void statsGrid.offsetWidth; // force reflow to restart CSS animation
    statsGrid.classList.add('flash');
  }
  _prevBuffered = newBuffered;

  // Activity row: show when the last event was captured
  if (health.lastEventAt) {
    lastEventText.textContent = `Last event: ${timeAgo(health.lastEventAt)}`;
  } else {
    lastEventText.textContent = 'No events captured yet — open a browser tab and browse';
  }

  // MCP dual-status indicator
  updateMcpStatus(health.mcpLastCallAt ?? null);

  // Live signals
  renderSignals(health.signals ?? []);

  // Team sync indicator
  const teamSync = health.teamSync;
  if (teamSync?.enabled) {
    teamDot.classList.add('active');
    teamBadge.classList.add('visible');
  } else {
    teamDot.classList.remove('active');
    teamBadge.classList.remove('visible');
  }

  // Plan badge + credit meter
  try {
    const [licRes, usageRes] = await Promise.all([
      fetch(`${getBaseUrl(port)}/license`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${getBaseUrl(port)}/usage`,   { signal: AbortSignal.timeout(2000) }),
    ]);
    const lic   = await licRes.json();
    const usage = await usageRes.json();

    const planId   = lic.plan?.id   ?? 'free';
    const planName = lic.plan?.name ?? 'Free';

    planBadge.textContent = planName;
    planBadge.className   = `plan-label plan-${planId}`;

    const atLimit = usage.included !== null && usage.used / usage.included >= 0.8;
    upgradeLink.style.display = (planId === 'free' || atLimit) ? '' : 'none';

    if (usage.included !== null && usage.included > 0) {
      creditWrap.style.display = 'block';
      const pct = Math.min(100, Math.round((Math.min(usage.used, usage.included) / usage.included) * 100));
      creditCount.textContent = `${usage.used} / ${usage.included}`;
      creditFill.style.width = pct + '%';
      creditFill.style.background = pct >= 90 ? '#f87171' : pct >= 70 ? '#fbbf24' : 'linear-gradient(90deg,#a78bfa,#7c3aed)';

      if (usage.overage > 0) {
        creditOverage.style.display = 'block';
        const dollars = ((usage.overage * (usage.overageCentsPerCredit ?? 5)) / 100).toFixed(2);
        creditOverage.textContent = `+${usage.overage} overage • ~$${dollars} this month`;
      } else {
        creditOverage.style.display = 'none';
      }
    } else {
      creditWrap.style.display = 'none';
    }
  } catch { /* server may not have license module */ }
}

// ── Port save ─────────────────────────────────────────────────────────────────

portSave.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  if (isNaN(port) || port < 1024 || port > 65535) return;
  await chrome.storage.local.set({ mergenPort: port });
  serverUrl.textContent = getBaseUrl(port);
  portSaved.style.display = 'inline';
  setTimeout(() => { portSaved.style.display = 'none'; }, 2000);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'MERGEN_PORT_CHANGED', port }).catch(() => {});
  }
  refresh(port);
});

// ── Gear toggle (port settings) ───────────────────────────────────────────────

btnGear.addEventListener('click', () => {
  const isOpen = portRow.classList.toggle('open');
  btnGear.classList.toggle('active', isOpen);
});

// ── Mute toggle ───────────────────────────────────────────────────────────────

muteToggle.addEventListener('change', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const muted = !muteToggle.checked;
  await chrome.storage.session.set({ [`muted_${tab.id}`]: muted }).catch(() => {});
  chrome.tabs.sendMessage(tab.id, { type: 'MERGEN_MUTE', muted }).catch(() => {});
  if (muted) { toggleSub.textContent = 'Paused on this tab'; mutedBanner.style.display = 'block'; }
  else       { toggleSub.textContent = 'Active on current tab'; mutedBanner.style.display = 'none'; }
});

// ── Clear buffer (two-step confirm to prevent accidental clears) ──────────────

btnClear.addEventListener('click', async () => {
  if (!_clearConfirmPending) {
    _clearConfirmPending = true;
    btnClear.textContent = 'Confirm clear?';
    btnClear.classList.add('confirming');
    _clearConfirmTimer = setTimeout(() => {
      _clearConfirmPending = false;
      _clearConfirmTimer = null;
      btnClear.textContent = '🗑 Clear';
      btnClear.classList.remove('confirming');
    }, 3000);
    return;
  }

  clearTimeout(_clearConfirmTimer);
  _clearConfirmPending = false;
  _clearConfirmTimer = null;
  btnClear.classList.remove('confirming');

  const port = parseInt(portInput.value, 10);
  try {
    await fetch(`${getBaseUrl(port)}/clear`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    btnClear.textContent = '✓ Cleared';
    _prevBuffered = 0;
    setTimeout(() => { btnClear.textContent = '🗑 Clear'; }, 1500);
    refresh(port);
  } catch {
    btnClear.textContent = '✗ Failed';
    setTimeout(() => { btnClear.textContent = '🗑 Clear'; }, 1500);
  }
});

// ── Reconnect ─────────────────────────────────────────────────────────────────

btnReconnect.addEventListener('click', () => refresh(parseInt(portInput.value, 10)));

// ── Nav links ─────────────────────────────────────────────────────────────────

welcomeLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

pricingLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('pricing.html') });
});

upgradeLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('pricing.html') });
});

// ── Content-script ping ───────────────────────────────────────────────────────
// If the tab was open before the extension was installed/reloaded, the content
// script was never injected — console.log patches never ran. Detect this and
// show a one-click "reload tab" button so the user knows why logs are missing.

async function checkContentScript() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('chrome-extension')) return;
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'MERGEN_PING' })
      .catch(() => null);
    if (!response) {
      noCsBanner.style.display = 'block';
      noCsBanner.addEventListener('click', () => {
        chrome.tabs.reload(tab.id);
        window.close();
      }, { once: true });
    }
  } catch { /* ignore — non-injectable page */ }
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  const port = await loadSettings();
  await loadMuteState();
  await refresh(port);
  await checkContentScript();

  // Auto-refresh every 3 s while popup is open so activity row and signals stay live.
  const intervalId = setInterval(() => refresh(parseInt(portInput.value, 10)), 3000);
  window.addEventListener('unload', () => clearInterval(intervalId));
})();
