/**
 * popup.js — Mergen extension popup controller
 */

const DEFAULT_PORT = 3000;

// ── DOM refs ────────────────────────────────────────────────────────────────
const statusPill   = document.getElementById('status-pill');
const statusText   = document.getElementById('status-text');
const serverUrl    = document.getElementById('server-url');
const statErrors   = document.getElementById('stat-errors');
const statWarns    = document.getElementById('stat-warns');
const statNet      = document.getElementById('stat-net');
const portInput    = document.getElementById('port-input');
const portSave     = document.getElementById('port-save');
const portSaved    = document.getElementById('port-saved');
const muteToggle   = document.getElementById('mute-toggle');
const toggleSub    = document.getElementById('toggle-sub');
const mutedBanner  = document.getElementById('muted-banner');
const noCsBanner   = document.getElementById('no-cs-banner');
const btnClear     = document.getElementById('btn-clear');
const btnReconnect = document.getElementById('btn-reconnect');
const welcomeLink  = document.getElementById('welcome-link');
const pricingLink  = document.getElementById('pricing-link');
const planBadge    = document.getElementById('plan-badge');
const teamDot      = document.getElementById('team-dot');
const teamBadge    = document.getElementById('team-badge');
const upgradeLink  = document.getElementById('upgrade-link');
const creditWrap   = document.getElementById('credit-wrap');
const creditCount  = document.getElementById('credit-count');
const creditFill   = document.getElementById('credit-fill');
const creditOverage = document.getElementById('credit-overage');
const signalsWrap  = document.getElementById('signals-wrap');
const signalsList  = document.getElementById('signals-list');
const signalsCount = document.getElementById('signals-count');

// ── Helpers ──────────────────────────────────────────────────────────────────

function getBaseUrl(port) { return `http://127.0.0.1:${port}`; }

function setStatus(state, label) {
  statusPill.className = `status-pill ${state}`;
  statusText.textContent = label;
  statusPill.querySelector('.dot').className = state === 'checking' ? 'dot pulse' : 'dot';
}

// ── Live signals (B3) ────────────────────────────────────────────────────────
// Render the buffer's session signals (computed server-side from the ring
// buffer) so the dev sees actionable patterns BEFORE crashes — this is the
// core "always-on engagement" surface in the popup.

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

  // Wire CTAs — copy the tool invocation to the clipboard so the dev can
  // paste it into Cursor / Claude / Copilot Chat instantly.
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
    return;
  }

  setStatus('connected', 'Connected');
  statErrors.textContent = health.errors ?? 0;
  statWarns.textContent  = health.warnings ?? 0;
  statNet.textContent    = health.networkErrors ?? 0;
  btnClear.disabled = false;

  // Surface live signals from /health (already computed by the server)
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

    // Show upgrade link for free plan or when at ≥80% of quota
    const atLimit = usage.included !== null && usage.used / usage.included >= 0.8;
    upgradeLink.style.display = (planId === 'free' || atLimit) ? '' : 'none';

    // Credit bar — only for plans with a finite quota
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

// ── Clear buffer ──────────────────────────────────────────────────────────────

btnClear.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  try {
    await fetch(`${getBaseUrl(port)}/clear`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    btnClear.textContent = '✓ Cleared';
    setTimeout(() => { btnClear.textContent = '🗑 Clear Buffer'; }, 1500);
    refresh(port);
  } catch {
    btnClear.textContent = '✗ Failed';
    setTimeout(() => { btnClear.textContent = '🗑 Clear Buffer'; }, 1500);
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
// show a one-click "reload tab" banner so the user knows why logs are missing.

async function checkContentScript() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    // chrome:// and extension pages can't receive messages — skip silently.
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
})();

