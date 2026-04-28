document.getElementById('check-btn').addEventListener('click', async () => {
  const result = document.getElementById('check-result');
  result.style.display = 'none';

  const { mergenPort = 3000 } = await chrome.storage.local.get('mergenPort');
  try {
    const res = await fetch(`http://127.0.0.1:${mergenPort}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json();
    result.className = 'ok';
    result.textContent = `✓ Connected on port ${mergenPort} — ${data.buffered} events buffered`;
  } catch {
    result.className = 'fail';
    result.textContent = `✗ Could not reach http://127.0.0.1:${mergenPort} — is the server running?`;
  }
  result.style.display = 'block';
});
