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
const statWs        = document.getElementById('stat-ws');
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
const btnCapture    = document.getElementById('btn-capture');
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
const sessionStrip  = document.getElementById('session-strip');
const sessionName   = document.getElementById('session-name');
const sessionDiff   = document.getElementById('session-diff');
const sessionCopyBtn = document.getElementById('session-copy-btn');

// ── State ─────────────────────────────────────────────────────────────────────
let _prevBuffered = -1;
let _clearConfirmPending = false;
let _clearConfirmTimer = null;
let _localSecret = null;

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

// ── Debug session strip ───────────────────────────────────────────────────────

let _activeSessionId = null;

async function refreshSessionStrip(port) {
  try {
    const res = await fetch(`${getBaseUrl(port)}/sessions`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) { sessionStrip.classList.remove('active'); return; }
    const { sessions } = await res.json();

    if (!sessions || sessions.length === 0) {
      sessionStrip.classList.remove('active');
      _activeSessionId = null;
      return;
    }

    const s = sessions[0];
    _activeSessionId = s.id;
    sessionStrip.classList.add('active');

    const label = s.description.length > 32 ? s.description.slice(0, 30) + '…' : s.description;
    sessionName.textContent = `🔬 ${label}`;
    if (s.iterationCount > 0) sessionName.textContent += ` · iter ${s.iterationCount}`;

    if (s.latestDiff) {
      const { resolved, persisted, newErrors } = s.latestDiff;
      sessionDiff.innerHTML =
        `<span class="s-ok">✓${resolved}</span> ` +
        `<span class="s-err">✗${persisted + newErrors}</span>`;
    } else {
      sessionDiff.innerHTML = `<span>${s.baselineErrorCount} error${s.baselineErrorCount !== 1 ? 's' : ''} at baseline</span>`;
    }
  } catch { sessionStrip.classList.remove('active'); }
}

sessionCopyBtn.addEventListener('click', async () => {
  if (!_activeSessionId) return;
  const text = `checkpoint_debug_session("${_activeSessionId}", "describe your fix here")`;
  try {
    await navigator.clipboard.writeText(text);
    const orig = sessionCopyBtn.textContent;
    sessionCopyBtn.textContent = '✓ Copied';
    setTimeout(() => { sessionCopyBtn.textContent = orig; }, 1800);
  } catch {
    sessionCopyBtn.textContent = 'Copy failed';
  }
});

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
        <button class="signal-cta" data-tool="${escapeHtml(tool)}">→ Ask your AI</button>
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
  const { mergenPort = DEFAULT_PORT, mergenTraceDomains = [] } = await chrome.storage.local.get(['mergenPort', 'mergenTraceDomains']);
  portInput.value = mergenPort;
  serverUrl.textContent = getBaseUrl(mergenPort);
  const domainsEl = document.getElementById('trace-domains-input');
  if (domainsEl) domainsEl.value = mergenTraceDomains.join('\n');
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
    statErrors.textContent = statWarns.textContent = statNet.textContent = statWs.textContent = '—';
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
  statWs.textContent     = health.websocketConnections ?? 0;
  statsGrid.style.display = 'grid'; // reveal stats on first successful poll
  btnClear.disabled = false;

  // Flash stats row when new events arrive since last poll
  const newBuffered = health.buffered ?? 0;
  if (_prevBuffered >= 0 && newBuffered > _prevBuffered) {
    statsGrid.classList.remove('flash');
    void statsGrid.offsetWidth; // force reflow to restart CSS animation
    statsGrid.classList.add('flash');
  }
  _prevBuffered = newBuffered;

  // Activity row: last event time + live event rate from background rolling window
  if (health.lastEventAt) {
    let rateStr = '';
    try {
      const { mergenLiveStatus = null } = await chrome.storage.session.get('mergenLiveStatus');
      const rate = mergenLiveStatus?.eventsPerMin;
      const active = mergenLiveStatus?.isActive;
      if (rate !== null && rate !== undefined && rate > 0) {
        rateStr = `  ·  ~${rate} evt/min`;
      }
      // Pulse the dot when active
      const dot = statusPill.querySelector('.dot');
      if (dot) dot.className = active ? 'dot pulse' : 'dot';
    } catch { /* storage not available */ }
    lastEventText.textContent = `Last event: ${timeAgo(health.lastEventAt)}${rateStr}`;
  } else {
    lastEventText.textContent = 'No events yet — open your app in a browser tab';
  }

  // MCP dual-status indicator
  updateMcpStatus(health.mcpLastCallAt ?? null);

  // Debug session strip
  await refreshSessionStrip(port);

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

    if (usage.included !== null && usage.included > 0 &&
        (usage.used / usage.included >= 0.70 || usage.overage > 0)) {
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

// ── Engineer identity ─────────────────────────────────────────────────────────
// Stores the engineer's name/email in chrome.storage.local so it's attached to
// every event posted to a shared team Mergen instance.

const userIdInput  = document.getElementById('user-id-input');
const userIdSave   = document.getElementById('user-id-save');
const userIdSaved  = document.getElementById('user-id-saved');

if (userIdInput && userIdSave) {
  // Load existing identity on popup open
  chrome.storage.local.get('mergenUserId', function(r) {
    if (r && r.mergenUserId) userIdInput.value = r.mergenUserId;
  });

  userIdSave.addEventListener('click', async () => {
    const val = userIdInput.value.trim().slice(0, 80);
    await chrome.storage.local.set({ mergenUserId: val || null });
    if (userIdSaved) {
      userIdSaved.style.display = 'inline';
      setTimeout(() => { userIdSaved.style.display = 'none'; }, 2000);
    }
  });
}

// ── Port save ─────────────────────────────────────────────────────────────────

portSave.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  if (isNaN(port) || port < 1024 || port > 65535) return;

  const domainsEl = document.getElementById('trace-domains-input');
  const domains = domainsEl
    ? domainsEl.value.split('\n').map(s => s.trim().toLowerCase()).filter(s => s.length > 0)
    : [];
  await chrome.storage.local.set({ mergenPort: port, mergenTraceDomains: domains });

  serverUrl.textContent = getBaseUrl(port);
  portSaved.style.display = 'inline';
  setTimeout(() => { portSaved.style.display = 'none'; }, 2000);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'MERGEN_PORT_CHANGED', port }).catch(() => {});
      chrome.tabs.sendMessage(tab.id, { type: 'MERGEN_TRACE_DOMAINS', domains }).catch(() => {});
    }
  }
  refresh(port);
});

// ── Gear toggle (port settings) ───────────────────────────────────────────────

btnGear.addEventListener('click', () => {
  const isOpen = portRow.classList.toggle('open');
  btnGear.classList.toggle('active', isOpen);
  btnGear.title = isOpen ? 'Close settings' : 'Settings';
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

// ── Local secret (for mutating requests that require x-mergen-secret) ─────────

async function fetchLocalSecret(port) {
  if (_localSecret) return _localSecret;
  try {
    const res = await fetch(`${getBaseUrl(port)}/local-secret`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.secret === 'string') _localSecret = data.secret;
    }
  } catch { /* server not running or not reachable — proceed without secret */ }
  return _localSecret;
}

// ── Capture point ─────────────────────────────────────────────────────────────

btnCapture?.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  try {
    const secret = await fetchLocalSecret(port);
    await fetch(`${getBaseUrl(port)}/mark`, {
      method: 'POST',
      headers: secret ? { 'x-mergen-secret': secret } : {},
      signal: AbortSignal.timeout(2000),
    });
    
    // Visual feedback for capture
    const origText = btnCapture.textContent;
    btnCapture.textContent = '⏹ Recording';
    btnCapture.style.color = '#ef4444'; // Red
    btnCapture.style.borderColor = '#ef4444';
    
    setTimeout(() => { 
      btnCapture.textContent = origText;
      btnCapture.style.color = '';
      btnCapture.style.borderColor = '';
    }, 4000);
  } catch {
    btnCapture.textContent = '✗ Offline';
    setTimeout(() => { btnCapture.textContent = '⏺ Capture'; }, 1500);
  }
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
    const secret = await fetchLocalSecret(port);
    await fetch(`${getBaseUrl(port)}/clear`, {
      method: 'POST',
      headers: secret ? { 'x-mergen-secret': secret } : {},
      signal: AbortSignal.timeout(2000),
    });
    btnClear.textContent = '✓ Cleared';
    _prevBuffered = 0;
    setTimeout(() => { btnClear.textContent = '🗑 Clear'; }, 1500);
    refresh(port);
  } catch {
    btnClear.textContent = '✗ Failed';
    setTimeout(() => { btnClear.textContent = '🗑 Clear'; }, 1500);
  }
});


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

// ── PII Shield ───────────────────────────────────────────────────────────────
// Client-side pattern scanner. Detects sensitive tokens in recent event data
// and shows a per-entity toggle so the developer can choose what to redact.
// The override list is in-memory only — never persisted or transmitted.

const PII_PATTERNS = [
  { type: 'JWT',        re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { type: 'Bearer',     re: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/gi },
  { type: 'API Key',    re: /(?:api[_-]?key|apikey|access[_-]?key)[^\s"']*["'\s:=]+([A-Za-z0-9\-._]{20,})/gi },
  { type: 'Email',      re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  { type: 'AWS Key',    re: /AKIA[0-9A-Z]{16}/g },
  { type: 'Private Key',re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { type: 'Password',   re: /(?:password|passwd|pwd)[^\s"']*["'\s:=]+["']?([^\s"',;&]{8,})["']?/gi },
];

// Override set: entity values the user has toggled to "allow through"
const _piiAllowlist = new Set();

function scanForPii(text) {
  const found = [];
  for (const { type, re } of PII_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = (m[1] || m[0]).slice(0, 60);
      if (!found.find(f => f.value === value)) {
        found.push({ type, value, masked: !_piiAllowlist.has(value) });
      }
    }
  }
  return found;
}

async function refreshPiiPanel(port) {
  try {
    const data = await fetch(`${getBaseUrl(port)}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
    // Also pull recent log text from health signals
    const signals = data.signals ?? [];
    const text = signals.map(s => s.message + ' ' + s.action).join(' ');
    const entities = scanForPii(text);

    const badge = document.getElementById('pii-badge');
    const list  = document.getElementById('pii-list');

    if (entities.length === 0) {
      badge.textContent = '';
      list.innerHTML = '<div style="font-size:0.65rem;color:var(--text-dim)">No sensitive patterns detected.</div>';
      return;
    }

    badge.textContent = String(entities.length);

    list.innerHTML = entities.map(e => {
      const masked = !_piiAllowlist.has(e.value);
      const preview = masked ? e.value.slice(0, 8) + '••••' : e.value;
      return `<div class="pii-entity" data-value="${encodeURIComponent(e.value)}">
        <span class="pii-type">${e.type}</span>
        <span class="pii-value">${preview}</span>
        <label class="pii-toggle">
          <input type="checkbox" class="pii-override" ${masked ? '' : 'checked'} style="margin:0 2px 0 0" />
          Allow
        </label>
      </div>`;
    }).join('');

    list.querySelectorAll('.pii-override').forEach(cb => {
      cb.addEventListener('change', () => {
        const row = cb.closest('.pii-entity');
        const val = decodeURIComponent(row.dataset.value || '');
        if (cb.checked) {
          _piiAllowlist.add(val);
        } else {
          _piiAllowlist.delete(val);
        }
        // Send override list to content script for runtime use
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
          if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, {
              type: 'MERGEN_PII_ALLOWLIST',
              allowlist: Array.from(_piiAllowlist),
            }).catch(() => {});
          }
        });
      });
    });
  } catch { /* server unreachable */ }
}

const btnPii   = document.getElementById('btn-pii');
const piiPanel = document.getElementById('pii-panel');
const piiClose = document.getElementById('pii-close');

btnPii.addEventListener('click', async () => {
  const isOpen = piiPanel.classList.toggle('open');
  if (isOpen) {
    await refreshPiiPanel(parseInt(portInput.value, 10));
  }
});

piiClose.addEventListener('click', () => piiPanel.classList.remove('open'));

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
