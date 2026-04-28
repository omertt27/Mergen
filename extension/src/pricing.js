(async () => {
  // ── Config ─────────────────────────────────────────────────────────────────
  const DEFAULT_PORT = 3000;
  const { mergenPort = DEFAULT_PORT } = await chrome.storage.local.get('mergenPort').catch(() => ({}));
  const BASE = `http://127.0.0.1:${mergenPort}`;

  const LS_URLS = {
    solo_standard: 'https://mergen.lemonsqueezy.com/buy/solo-standard',
    solo_pro:      'https://mergen.lemonsqueezy.com/buy/solo-pro',
    team:          'https://mergen.lemonsqueezy.com/buy/team',
    pay_as_you_go: 'https://mergen.lemonsqueezy.com/buy/payg',
  };

  // ── Billing toggle ─────────────────────────────────────────────────────────
  let annual = false;
  document.getElementById('billing-toggle').addEventListener('click', () => {
    annual = !annual;
    document.getElementById('billing-toggle').classList.toggle('annual', annual);
    document.querySelectorAll('.price-val').forEach((el) => {
      el.textContent = annual ? el.dataset.annual : el.dataset.monthly;
    });
    document.querySelectorAll('.billing-period').forEach((el) => {
      el.textContent = annual ? 'annually' : 'monthly';
    });
  });

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
          const dollars = ((usage.overage * (usage.overageCentsPerCredit ?? 5)) / 100).toFixed(2);
          el.textContent = `+${usage.overage} overage • ~$${dollars} this month`;
        }
      }

      if (currentPlanId === 'team') {
        document.getElementById('team-section').style.display = 'block';
        loadTeamState();
      }
    }
  } catch { /* server offline */ }

  function markCurrentPlan(planId) {
    document.querySelectorAll('.cta-btn[data-plan]').forEach((btn) => {
      const plan = btn.dataset.plan;
      const labels = { solo_standard: 'Get Standard →', solo_pro: 'Get Pro →', team: 'Get Team →' };
      btn.textContent = labels[plan] ?? 'Get plan →';
      btn.className = 'cta-btn cta-paid';
    });
    document.getElementById('cta-free').className = 'cta-btn cta-free';
    document.getElementById('cta-free').textContent = planId === 'free' ? '✓ Current plan' : 'Downgrade';

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

  document.getElementById('payg-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: LS_URLS.pay_as_you_go });
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
      markCurrentPlan(data.plan);
      if (data.plan === 'team') {
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
        text.textContent = `Active — member: ${data.memberName}`;
        peers.textContent = `${data.connectedPeers} peer${data.connectedPeers === 1 ? '' : 's'} connected`;
        leaveBtn.style.display = 'inline-block';
        document.getElementById('team-token').value = '';
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
      resultEl.textContent = `✓ Team sync active — ${data.relayUrl}`;
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
