// ── IDE tab switching ─────────────────────────────────────────────────────────

for (const tab of document.querySelectorAll('.ide-tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.ide-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.target).classList.add('active');
  });
}

// ── Shared server check ───────────────────────────────────────────────────────

async function checkServer(port) {
  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getPort() {
  try {
    const { mergenPort = 3000 } = await chrome.storage.local.get('mergenPort');
    return mergenPort;
  } catch {
    return 3000;
  }
}

// ── Step 1 inline check ───────────────────────────────────────────────────────

document.getElementById('step1-check-btn').addEventListener('click', async () => {
  const btn = document.getElementById('step1-check-btn');
  const result = document.getElementById('step1-result');
  btn.textContent = 'Checking…';
  btn.disabled = true;
  result.style.display = 'none';

  try {
    const port = await getPort();
    await checkServer(port);
    result.className = 'inline-result ok';
    result.textContent = `✓ Server running on port ${port}`;
  } catch {
    result.className = 'inline-result fail';
    result.textContent = '✗ Not reachable — is the server running?';
  }

  result.style.display = 'inline';
  btn.textContent = 'Check server';
  btn.disabled = false;
});

// ── Full connection check ─────────────────────────────────────────────────────

document.getElementById('check-btn').addEventListener('click', async () => {
  const result = document.getElementById('check-result');
  result.style.display = 'none';

  try {
    const port = await getPort();
    const data = await checkServer(port);

    if (data.buffered > 0) {
      result.className = 'ok';
      result.textContent = `✓ Connected on port ${port} — ${data.buffered} events buffered. You're all set!`;
    } else {
      result.className = 'ok';
      result.textContent = `✓ Server running on port ${port} — no events yet. Open a browser tab to start capturing.`;
    }
  } catch {
    const port = await getPort().catch(() => 3000);
    result.className = 'fail';
    result.textContent = `✗ Could not reach http://127.0.0.1:${port} — is the server running?`;
  }

  result.style.display = 'block';
});
