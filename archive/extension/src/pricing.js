(async () => {
  const DEFAULT_PORT = 3000;
  const { mergenPort = DEFAULT_PORT } = await chrome.storage.local.get('mergenPort').catch(() => ({}));
  const BASE = `http://127.0.0.1:${mergenPort}`;

  const LS_URLS = {
    solo_pro:  'https://mergen.lemonsqueezy.com/buy/solo-pro',
    team_pro:  'https://mergen.lemonsqueezy.com/buy/team-pro',
  };

  // ── Load plan & usage ──────────────────────────────────────────────────────
  let currentPlanId = 'free';
  try {
    const [licRes, usageRes] = await Promise.all([
      fetch(`${BASE}/license`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${BASE}/usage`,   { signal: AbortSignal.timeout(2000) }),
    ]);
    const lic   = await licRes.json();
    const usage = await usageRes.json();

    currentPlanId = lic.plan?.id ?? 'free';
    markCurrentPlan(currentPlanId);

    if (currentPlanId !== 'free') {
      const banner = document.getElementById('current-plan-banner');
      banner.style.display = 'flex';
      document.getElementById('banner-plan').textContent = lic.plan?.name ?? currentPlanId;

      if (usage.included !== null && usage.included > 0) {
        document.getElementById('banner-meter').style.display = 'block';
        const used = Math.min(usage.used, usage.included);
        const pct  = Math.round((used / usage.included) * 100);
        document.getElementById('banner-meter-count').textContent = `${usage.used} / ${usage.included}`;
        document.getElementById('banner-usage-fill').style.width = pct + '%';
        document.getElementById('banner-usage-fill').style.background =
          pct >= 90 ? '#f87171' : pct >= 70 ? '#fbbf24' : 'linear-gradient(90deg,#a78bfa,#7c3aed)';

        if (usage.overage > 0) {
          const el = document.getElementById('banner-overage');
          el.style.display = 'block';
          const dollars = ((usage.overage * (usage.overageCentsPerCredit ?? 2)) / 100).toFixed(2);
          el.textContent = `+${usage.overage} overage • ~$${dollars} this month`;
        }
      }

      if (lic.plan?.teamSync) {
        document.getElementById('team-section').style.display = 'block';
        loadTeamState();
      }
    }
  } catch { /* server offline */ }

  function markCurrentPlan(planId) {
    // Reset all paid buttons
    document.querySelectorAll('.cta-btn[data-plan]').forEach((btn) => {
      btn.textContent = btn.dataset.plan === 'solo_pro' ? 'Get Pro →' : 'Get Enterprise →';
      btn.className = 'cta-btn cta-paid';
    });
    // Reset free button
    const freeBtn = document.getElementById('cta-free');
    freeBtn.className = 'cta-btn cta-free';
    freeBtn.textContent = planId === 'free' ? '✓ Current plan' : 'Downgrade';

    // Mark active paid plan
    if (planId !== 'free') {
      const btn = document.getElementById(`cta-${planId}`);
      if (btn) {
        btn.textContent = '✓ Current plan';
        btn.className = 'cta-btn cta-current';
      }
    }
  }

  // ── CTA links ──────────────────────────────────────────────────────────────
  document.querySelectorAll('.cta-btn[data-plan]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (btn.classList.contains('cta-current')) return;
      const url = LS_URLS[btn.dataset.plan];
      if (url) chrome.tabs.create({ url });
    });
  });

  // ── License activation ─────────────────────────────────────────────────────
  const keyInput  = document.getElementById('key-input');
  const keyBtn    = document.getElementById('key-btn');
  const keyResult = document.getElementById('key-result');

  keyBtn.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    if (!key) return;
    keyBtn.disabled = true;
    keyBtn.textContent = 'Activating…';
    keyResult.style.display = 'none';
    try {
      const res  = await fetch(`${BASE}/license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'activation failed');
      keyResult.className = 'key-result ok';
      keyResult.textContent = `✓ Activated! Plan: ${data.plan} — welcome, ${data.email}`;
      keyResult.style.display = 'block';
      keyInput.value = '';
      markCurrentPlan(data.planId ?? data.plan);
      if (data.teamSync) {
        document.getElementById('team-section').style.display = 'block';
        loadTeamState();
      }
    } catch (err) {
      keyResult.className = 'key-result fail';
      keyResult.textContent = `✗ ${err.message}`;
      keyResult.style.display = 'block';
    } finally {
      keyBtn.disabled = false;
      keyBtn.textContent = 'Activate';
    }
  });

  // ── Deactivate ─────────────────────────────────────────────────────────────
  document.getElementById('deactivate-btn').addEventListener('click', async () => {
    if (!confirm('Remove license and revert to Free plan?')) return;
    try {
      await fetch(`${BASE}/license`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
      document.getElementById('current-plan-banner').style.display = 'none';
      document.getElementById('team-section').style.display = 'none';
      markCurrentPlan('free');
    } catch { alert('Could not reach the Mergen server.'); }
  });

  // ── Team sync ──────────────────────────────────────────────────────────────
  async function loadTeamState() {
    try {
      const res  = await fetch(`${BASE}/team`, { signal: AbortSignal.timeout(3000) });
      const data = await res.json();

      const dot      = document.getElementById('team-status-dot');
      const text     = document.getElementById('team-status-text');
      const peers    = document.getElementById('team-peers');
      const leaveBtn = document.getElementById('team-leave-btn');

      if (data.enabled) {
        dot.classList.add('active');
        text.textContent = `Active — ${data.memberName}`;
        peers.textContent = `${data.connectedPeers} peer${data.connectedPeers === 1 ? '' : 's'} online`;
        leaveBtn.style.display = 'block';
        document.getElementById('team-member').value = data.memberName ?? '';
        document.getElementById('team-relay').value = data.relayUrl ?? '';
      } else {
        dot.classList.remove('active');
        text.textContent = 'Not configured';
        peers.textContent = '';
        leaveBtn.style.display = 'none';
      }
    } catch { /* server offline */ }
  }

  document.getElementById('team-join-btn').addEventListener('click', async () => {
    const token      = document.getElementById('team-token').value.trim();
    const memberName = document.getElementById('team-member').value.trim() || undefined;
    const relayUrl   = document.getElementById('team-relay').value.trim() || undefined;
    const resultEl   = document.getElementById('team-result');
    const btn        = document.getElementById('team-join-btn');

    if (!token || token.length < 8) {
      resultEl.className = 'team-result fail';
      resultEl.textContent = '✗ Token must be at least 8 characters';
      resultEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Connecting…';
    resultEl.style.display = 'none';

    try {
      const res  = await fetch(`${BASE}/team/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, memberName, relayUrl }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'failed');
      resultEl.className = 'team-result ok';
      resultEl.textContent = `✓ Team sync active`;
      resultEl.style.display = 'block';
      loadTeamState();
    } catch (err) {
      resultEl.className = 'team-result fail';
      resultEl.textContent = `✗ ${err.message}`;
      resultEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Join / Update';
    }
  });

  document.getElementById('team-leave-btn').addEventListener('click', async () => {
    if (!confirm('Leave the team and stop syncing?')) return;
    try {
      await fetch(`${BASE}/team`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
      loadTeamState();
    } catch { alert('Could not reach the Mergen server.'); }
  });

})();
