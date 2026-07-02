/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ── State ──────────────────────────────────────────────────────────────────
  let _currentPackText = '';
  let _currentPort     = 3000;
  let _captureTimer    = null;
  let _intentAbort     = null;
  let _activeServiceFilter = null;
  let _lastState = null;
  let _activeTab = 'overview';

  // ── Message passing to extension host ─────────────────────────────────────
  function send(type)                { vscode.postMessage({ type }); }
  function sendFeedback(pid, verdict){ vscode.postMessage({ type: 'feedback', pid, verdict }); }
  function copyTool(toolName)        { vscode.postMessage({ type: 'runTool', tool: toolName }); }
  function runCmd(commandId)         { vscode.postMessage({ type: 'runCommand', command: commandId }); }

  function onRefresh() {
    const btn = document.getElementById('btn-refresh');
    if (btn) { btn.textContent = '↺ …'; btn.disabled = true; }
    send('refresh');
    setTimeout(() => { if (btn) { btn.textContent = '↺ Refresh'; btn.disabled = false; } }, 3000);
  }

  function onClear() {
    clearCaptureStatus();
    send('clear');
  }

  // ── Tab switching ──────────────────────────────────────────────────────────
  function switchTab(name) {
    _activeTab = name;
    const tabs = ['overview', 'decisions', 'visualizer', 'policies', 'settings'];
    tabs.forEach(t => {
      const pane = document.getElementById('tab-' + t);
      const btn  = document.getElementById('tab-btn-' + t);
      if (pane) pane.className = 'tab-pane' + (t === name ? ' active' : '');
      if (btn)  btn.className  = 'tab-btn'  + (t === name ? ' active' : '');
    });
  }

  // Expose everything that HTML onclick attributes reference
  window.send         = send;
  window.sendFeedback = sendFeedback;
  window.copyTool     = copyTool;
  window.runCmd       = runCmd;
  window.onRefresh    = onRefresh;
  window.onClear      = onClear;
  window.switchTab    = switchTab;
  window.approveBypassToken = (token) => vscode.postMessage({ type: 'approveBypass', token });
  window.approveBypassTokenWithRemember = (token) => vscode.postMessage({ type: 'approveBypass', token, remember: true });
  window.denyBypassToken = (token) => vscode.postMessage({ type: 'denyBypass', token });
  window.toggleRule = (id, action) => vscode.postMessage({ type: 'toggleRule', id, action });

  let _advancedOpen = false;
  function toggleAdvanced() {
    _advancedOpen = !_advancedOpen;
    const content = document.getElementById('advanced-content');
    const icon = document.getElementById('advanced-toggle-icon');
    if (content) content.style.display = _advancedOpen ? 'block' : 'none';
    if (icon) icon.textContent = _advancedOpen ? '▼' : '▶';
  }
  window.toggleAdvanced = toggleAdvanced;

  // ── Receive messages from extension host ──────────────────────────────────
  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'state':
        render(data.state);
        // Re-enable refresh button once state arrives
        { const btn = document.getElementById('btn-refresh'); if (btn) { btn.textContent = '↺ Refresh'; btn.disabled = false; } }
        break;
      case 'captureStarted':
        showCaptureStatus(data.timestamp);
        break;
      case 'activeFile':
        if (data.relPath) fetchAndRenderIntent(data.relPath);
        break;
    }
  });

  // Signal readiness — panel.ts pushes current state then starts the poll loop
  vscode.postMessage({ type: 'ready' });

  // ── Capture status ─────────────────────────────────────────────────────────
  function showCaptureStatus(timestamp) {
    const el = document.getElementById('capture-status');
    if (!el) return;
    el.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--vscode-charts-red);margin-right:5px;vertical-align:middle;"></span> Capturing since ' + new Date(timestamp).toLocaleTimeString();
    el.style.display = 'block';
    if (_captureTimer) clearTimeout(_captureTimer);
    _captureTimer = setTimeout(() => { el.style.display = 'none'; _captureTimer = null; }, 30 * 60 * 1000);
  }

  function clearCaptureStatus() {
    const el = document.getElementById('capture-status');
    if (el) el.style.display = 'none';
    if (_captureTimer) { clearTimeout(_captureTimer); _captureTimer = null; }
  }

  // ── Intent card — direct fetch for active-file PR context ─────────────────
  async function fetchAndRenderIntent(relPath) {
    const intentCard = document.getElementById('card-intent');
    const intentList = document.getElementById('intent-list');
    const intentFile = document.getElementById('intent-file');
    if (!intentCard || !intentList || !intentFile) return;

    intentFile.textContent = relPath.split('/').pop() || relPath;

    if (_intentAbort) { _intentAbort.abort(); }
    const ctrl  = new AbortController();
    _intentAbort = ctrl;

    try {
      const r = await fetch(
        'http://127.0.0.1:' + _currentPort + '/explain-why/file?path=' + encodeURIComponent(relPath),
        { signal: ctrl.signal },
      );
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      if (!data.ok || !data.contexts || data.contexts.length === 0) {
        intentCard.style.display = 'none';
        return;
      }
      intentCard.style.display = 'block';
      intentList.innerHTML = data.contexts.slice(0, 5).map(c => {
        const title     = c.prTitle   ? escHtml(c.prTitle) : 'SHA ' + escHtml(c.sha);
        const prNum     = c.prNumber  ? '#' + c.prNumber + ' · ' : '';
        const dateStr   = c.mergedAt  ? new Date(c.mergedAt).toLocaleDateString()
                        : c.capturedAt ? new Date(c.capturedAt).toLocaleDateString() : '';
        const author    = c.author ? ' · by ' + escHtml(c.author) : '';
        const aiTag     = c.aiGenerated
          ? '<span class="intent-ai-tag">' + escHtml(c.aiTool || 'AI') + '</span>' : '';
        const issues    = c.linkedIssues && c.linkedIssues.length
          ? '<div class="intent-issues">' + c.linkedIssues.slice(0, 4).map(i => escHtml(i.ref)).join(', ') + '</div>' : '';
        const approvers = c.approvers && c.approvers.length
          ? '<span> · approved by ' + escHtml(c.approvers.slice(0, 2).join(', ')) + '</span>' : '';
        return '<div class="intent-item">' +
          '<div class="intent-pr">'   + prNum + title + aiTag + '</div>' +
          '<div class="intent-meta">' + dateStr + author + approvers + '</div>' +
          issues + '</div>';
      }).join('');
    } catch {
      intentCard.style.display = 'none';
    }
  }

  function escHtml(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function fmtRel(ms) {
    const d = Date.now() - ms;
    if (d < 60000)    return Math.max(1, Math.floor(d / 1000)) + 's ago';
    if (d < 3600000)  return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { month:'short', day:'numeric', timeZone:'UTC' }); }
    catch { return iso; }
  }

  function setEl(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(text);
  }

  function showEl(id, show) {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? 'block' : 'none';
  }

  // ── Calibration / feedback row ─────────────────────────────────────────────
  function renderCalibrationHtml(hyp) {
    const cal = hyp && hyp.calibration;
    const pid = hyp && hyp.pid;

    let badgeHtml = '';
    if (cal) {
      if (!cal.trusted) {
        badgeHtml =
          '<span class="calib-badge" title="Need ≥5 verdicts before this score is trusted.">' +
          'New · ' + cal.verdicts + '/' + cal.predictions + ' rated</span>';
      } else {
        const pct     = Math.round(cal.accuracy * 100);
        const cls     = pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'poor';
        const correct = Math.round(cal.accuracy * cal.verdicts);
        badgeHtml =
          '<span class="calib-badge ' + cls + '" title="Empirical accuracy across ' + cal.verdicts + ' verdicts.">' +
          pct + '% · ' + correct + '/' + cal.verdicts + ' correct</span>';
        if (typeof cal.trendDelta === 'number' && cal.trendDelta !== 0) {
          const delta    = Math.round(cal.trendDelta * 100);
          const trendCls = delta > 0 ? 'up' : 'down';
          badgeHtml +=
            '<span class="calib-trend ' + trendCls + '" title="7-day accuracy trend.">' +
            (delta > 0 ? '▲' : '▼') + Math.abs(delta) + '% (7d)</span>';
        }
      }
    } else {
      badgeHtml = '<span class="calib-badge" title="No verdicts yet.">Unrated</span>';
    }

    let buttonsHtml = '';
    if (pid) {
      const p = JSON.stringify(pid);
      buttonsHtml =
        '<span class="fb-prompt">Was this right?</span>' +
        '<span class="feedback-btns">' +
          '<button class="fb-btn fb-correct" onclick="sendFeedback(' + p + ',\'correct\')">✓ Yes</button>' +
          '<button class="fb-btn fb-partial" onclick="sendFeedback(' + p + ',\'partial\')">◐ Sort of</button>' +
          '<button class="fb-btn fb-wrong"   onclick="sendFeedback(' + p + ',\'wrong\')">✕ No</button>' +
        '</span>';
    }

    let failHtml = '';
    if (cal && cal.commonFailureModes && cal.commonFailureModes.length > 0 && cal.accuracy < 0.75) {
      const items = cal.commonFailureModes.slice(0, 3).map(m =>
        '<li>' + escHtml(m.note) + (m.count > 1 ? ' <span style="opacity:.6">(×' + m.count + ')</span>' : '') + '</li>'
      ).join('');
      failHtml =
        '<div class="calib-failmodes"><b>Often incorrect when:</b><ul>' + items + '</ul></div>';
    }

    return badgeHtml + '<span class="calib-spacer"></span>' + buttonsHtml + failHtml;
  }

  // ── Main render — called on every state message from extension host ────────
  function render(state) {
    if (!state) return;
    _lastState = state;

    // Keep port in sync for intent fetches
    if (state.port) _currentPort = state.port;

    const connected = state.connected;
    document.getElementById('dot').className = 'dot' + (connected ? ' ok' : '');
    showEl('disconnected',   !connected);

    // Update header gateway status
    const gatewayStatus = document.getElementById('gateway-status');
    const gatewayPolicies = document.getElementById('gateway-policies-active');
    if (connected) {
      const pols = state.policies;
      const pending = state.health?.pendingBypassesCount ?? 0;
      const blocked = state.health?.blockedActionsCount ?? 0;

      if (pols) {
        const activeCount = pols.rules.filter(r => r.action !== 'pass').length;
        if (gatewayPolicies) gatewayPolicies.textContent = activeCount + ' active';
      } else {
        if (gatewayPolicies) gatewayPolicies.textContent = '0 active';
      }

      if (gatewayStatus) {
        if (pending > 0) {
          gatewayStatus.textContent = `PENDING (${pending})`;
          gatewayStatus.style.color = 'var(--vscode-charts-yellow)';
        } else if (blocked > 0) {
          gatewayStatus.textContent = `BLOCKED (${blocked})`;
          gatewayStatus.style.color = 'var(--vscode-charts-red)';
        } else if (pols && !pols.enabled) {
          gatewayStatus.textContent = 'SHADOW MODE';
          gatewayStatus.style.color = 'var(--vscode-charts-yellow)';
        } else {
          gatewayStatus.textContent = 'ACTIVE ✓';
          gatewayStatus.style.color = 'var(--vscode-charts-green)';
        }
      }
    } else {
      if (gatewayPolicies) gatewayPolicies.textContent = '0 active';
      if (gatewayStatus) {
        gatewayStatus.textContent = 'OFFLINE';
        gatewayStatus.style.color = 'var(--vscode-charts-red)';
      }
      // Zero out header counters when disconnected
      setEl('hdr-protected', '—');
      setEl('hdr-blocked',   '—');
      setEl('hdr-escalated', '—');
    }

    showEl('card-buffer',     connected);
    showEl('card-server',     connected);
    showEl('card-execution-timeline', connected);
    showEl('card-policy-summary', connected);
    showEl('card-policies-coverage', connected);
    showEl('card-advanced', connected);
    showEl('card-account',  connected);
    showEl('tab-bar',       connected);
    showEl('card-milestone', false); // static placeholder — never shown

    // ── Account card ─────────────────────────────────────────────────────────
    const acct = state.account;
    showEl('card-account', connected);
    if (connected && acct) {
      const signedIn = !!(acct.email || acct.status === 'active');
      showEl('account-signed-in',  signedIn);
      showEl('account-signed-out', !signedIn);
      const planBadge = document.getElementById('account-plan-badge');
      if (planBadge) {
        if (acct.planId && acct.planId !== 'free') {
          planBadge.textContent  = acct.planName || acct.planId;
          planBadge.style.display = 'inline';
        } else {
          planBadge.style.display = 'none';
        }
      }
      if (signedIn) {
        setEl('account-email', acct.email || acct.name || 'Connected');
      }
      // ── Contextual upgrade CTA ──
      const upgrade = document.getElementById('account-upgrade');
      if (upgrade) {
        const next = acct.nextPlan;
        if (next) {
          setEl('account-upgrade-title', 'Upgrade to ' + next.name + ' — ' + (next.priceDescription || ''));
          setEl('account-upgrade-tagline', next.tagline || '');
          const link = document.getElementById('account-upgrade-link');
          if (link) {
            link.setAttribute('href', next.ctaUrl || acct.ctaUrl || 'https://mergen.dev/pricing');
            link.textContent = '↑ Upgrade to ' + next.name;
          }
          upgrade.style.display = 'block';
        } else {
          upgrade.style.display = 'none';
        }
      }
    }

    if (!connected) {
      ['card-pack','card-activity','card-signals','card-history','card-detectors','card-usage','card-account',
       'card-services','card-bypasses','card-policy-summary','card-policies-coverage',
       'card-execution-timeline','card-advanced','tab-bar'].forEach(id => showEl(id, false));
      return;
    }

    const h = state.health;
    const u = state.usage;

    // plan-badge in header — only show when on a paid plan (hidden for free/unknown)
    const planBadgeEl = document.getElementById('plan-badge');
    if (planBadgeEl) {
      const planName = u && u.planName && u.planName !== 'Free' ? u.planName : null;
      planBadgeEl.textContent = planName || '';
      planBadgeEl.style.display = planName ? 'inline' : 'none';
    }
    setEl('stat-errors', h.errors);
    setEl('stat-warns',  h.warnings);
    setEl('stat-net',    h.networkErrors);

    // ── Security Metrics (card + header counters) ──
    const secMetrics = state.securityMetrics;
    if (connected && secMetrics) {
      setEl('metric-protected-actions', secMetrics.protectedActions);
      setEl('metric-blocked-actions',   secMetrics.blockedActions);
      setEl('metric-approvals-requested', secMetrics.approvalsRequested);
      setEl('metric-shadow-violations', secMetrics.shadowViolations);
      // Mirror the three most important numbers into the always-visible header
      setEl('hdr-protected', secMetrics.protectedActions ?? '—');
      setEl('hdr-blocked',   secMetrics.blockedActions   ?? '—');
      setEl('hdr-escalated', secMetrics.approvalsRequested ?? '—');
      if (typeof secMetrics.latencyMs === 'number') {
        setEl('gateway-latency', secMetrics.latencyMs.toFixed(2) + 'ms');
      }
    }

    // ── Active Policies & Coverage ──
    const polState = state.policies;
    const gateCovers = state.gateCovers;
    if (connected && polState) {
      const policiesList = document.getElementById('policies-list');
      if (policiesList) {
        policiesList.innerHTML = polState.rules.map(r => {
          let actionText = r.action === 'block' ? 'BLOCK' : r.action === 'warn' ? 'HOLD' : 'PASS';
          let actionColor = r.action === 'block' ? 'var(--vscode-charts-red)' : r.action === 'warn' ? 'var(--vscode-charts-yellow)' : 'var(--vscode-descriptionForeground)';
          
          let controls = '';
          if (r.immutable) {
            controls = `<span style="font-size:9px;color:var(--vscode-descriptionForeground);margin-left:4px">(immutable)</span>`;
          } else {
            if (r.action === 'block') {
              controls = `
                <span style="font-size:9px;margin-left:6px">
                  <a href="#" onclick="toggleRule('${r.id}', 'warn')" style="text-decoration:none;color:var(--vscode-charts-yellow)">Hold</a> | 
                  <a href="#" onclick="toggleRule('${r.id}', 'pass')" style="text-decoration:none;color:var(--vscode-descriptionForeground)">Mute</a>
                </span>
              `;
            } else if (r.action === 'warn') {
              controls = `
                <span style="font-size:9px;margin-left:6px">
                  <a href="#" onclick="toggleRule('${r.id}', 'block')" style="text-decoration:none;color:var(--vscode-charts-red)">Block</a> | 
                  <a href="#" onclick="toggleRule('${r.id}', 'pass')" style="text-decoration:none;color:var(--vscode-descriptionForeground)">Mute</a>
                </span>
              `;
            } else {
              controls = `
                <span style="font-size:9px;margin-left:6px">
                  <a href="#" onclick="toggleRule('${r.id}', 'block')" style="text-decoration:none;color:var(--vscode-charts-red)">Block</a> | 
                  <a href="#" onclick="toggleRule('${r.id}', 'warn')" style="text-decoration:none;color:var(--vscode-charts-yellow)">Hold</a>
                </span>
              `;
            }
          }
          
          return `
            <div style="display:flex;align-items:flex-start;gap:6px;font-size:11px;margin-bottom:4px">
              <span style="color:${r.action === 'pass' ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-charts-green)'}">✓</span>
              <div style="flex:1">
                <span style="font-weight:600;${r.action === 'pass' ? 'text-decoration:line-through;opacity:0.65;' : ''}">${escHtml(r.name)}</span>
                <span style="font-size:9px;color:${actionColor};margin-left:4px">[${actionText}]</span>
                ${controls}
              </div>
            </div>
          `;
        }).join('');
      }

      if (gateCovers) {
        const hardBlocks = gateCovers.hardBlocks || [];
        const reviews = gateCovers.humanReviewRequired || [];
        const activeCount = hardBlocks.length + reviews.length;

        const coveragePercent = Math.min(100, Math.round((activeCount / 5) * 87));
        const coverageColor = coveragePercent >= 75 ? 'var(--vscode-charts-green)' : coveragePercent >= 50 ? 'var(--vscode-charts-yellow)' : 'var(--vscode-charts-red)';

        // Policies tab — full coverage widget
        setEl('policy-coverage-badge', coveragePercent + '% Coverage');
        setEl('critical-actions-count', activeCount + '/' + activeCount);
        const covBar = document.getElementById('coverage-bar');
        if (covBar) { covBar.style.width = coveragePercent + '%'; covBar.style.background = coverageColor; }

        // Overview tab — compact policy summary
        const blockCount = polState ? polState.rules.filter(r => r.action === 'block').length : 0;
        const totalActive = polState ? polState.rules.filter(r => r.action !== 'pass').length : 0;
        setEl('policy-summary-badge', coveragePercent + '%');
        setEl('policy-summary-active', totalActive);
        setEl('policy-summary-block',  blockCount);
        const summaryBadge = document.getElementById('policy-summary-badge');
        if (summaryBadge) summaryBadge.style.background = coverageColor;
        const summaryBar = document.getElementById('policy-summary-bar');
        if (summaryBar) { summaryBar.style.width = coveragePercent + '%'; summaryBar.style.background = coverageColor; }
      }
    }

    // ── Recent Decisions (Execution Timeline) ──
    const activity = state.activity || [];
    const timelineList = document.getElementById('execution-timeline-list');
    if (connected && activity.length > 0) {
      if (timelineList) {
        timelineList.innerHTML = activity.map(ev => {
          const time = new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          let badgeColor  = 'var(--vscode-charts-green)';
          let badgeText   = 'ALLOW';
          let leftBorder  = 'var(--vscode-charts-green)';
          if (ev.verdict === 'BLOCK' || ev.verdict === 'block') {
            badgeColor = 'var(--vscode-charts-red)';
            badgeText  = 'BLOCK';
            leftBorder = 'var(--vscode-charts-red)';
          } else if (ev.verdict === 'HOLD' || ev.verdict === 'hold' || ev.verdict === 'warn') {
            badgeColor = 'var(--vscode-charts-yellow)';
            badgeText  = 'HOLD';
            leftBorder = 'var(--vscode-charts-yellow)';
          } else if (ev.verdict === 'ESCALATE' || ev.verdict === 'escalate') {
            badgeColor = 'var(--vscode-charts-orange, #d18616)';
            badgeText  = 'ESCALATE';
            leftBorder = 'var(--vscode-charts-orange, #d18616)';
          }
          const ruleText = ev.ruleNames && ev.ruleNames.length > 0
            ? `<div style="font-size:9px;color:var(--vscode-descriptionForeground);margin-top:3px">↳ ${escHtml(ev.ruleNames.join(', '))}</div>`
            : '';
          const cmd = ev.commandArg || ev.toolName || '';
          return `
            <div style="background:var(--vscode-sideBar-background);border:1px solid var(--vscode-widget-border, rgba(127,127,127,.15));border-left:3px solid ${leftBorder};border-radius:4px;padding:6px 8px;font-size:11px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
                <span style="font-weight:700;letter-spacing:.04em;color:${badgeColor};font-size:10px">${badgeText}</span>
                <span style="color:var(--vscode-descriptionForeground);font-size:9px">${time}</span>
              </div>
              <div style="font-family:var(--vscode-editor-font-family, monospace);font-size:10px;color:var(--vscode-foreground);word-break:break-all;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%" title="${escHtml(cmd)}">${escHtml(cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd)}</div>
              ${ruleText}
            </div>
          `;
        }).join('');
      }
    } else {
      if (timelineList) {
        timelineList.innerHTML = '<div style="font-size:11px;color:var(--vscode-descriptionForeground);text-align:center;padding:12px 0;opacity:0.7">No agent decisions recorded yet.<br><span style="font-size:10px">Decisions appear here as your AI agents run.</span></div>';
      }
    }

    // ── Pending Bypasses ──────────────────────────────────────────────────────
    const bypasses = state.pendingBypasses || [];
    const bypassesCard = document.getElementById('card-bypasses');
    const bypassesList = document.getElementById('bypasses-list');
    const bypassesCount = document.getElementById('bypasses-count');
    
    if (connected && bypasses.length > 0) {
      showEl('card-bypasses', true);
      if (bypassesCount) bypassesCount.textContent = bypasses.length;
      if (bypassesList) {
        bypassesList.innerHTML = bypasses.map(b => {
          const expiresMin = Math.max(1, Math.round((b.expiresAt - Date.now()) / 60000));
          return `
            <div style="background:var(--vscode-sideBar-background);border:1px solid var(--vscode-widget-border, rgba(127,127,127,.15));border-radius:4px;padding:8px 10px;font-size:11px">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-weight:600">
                <span style="color:var(--vscode-charts-red)">⏸ Approval Required: ${b.toolName}</span>
                <span style="color:var(--vscode-descriptionForeground);font-size:9px">Expires in ${expiresMin}m</span>
              </div>
              <div style="font-family:var(--vscode-editor-font-family, monospace);font-size:10px;background:var(--vscode-editor-background);padding:4px 6px;border-radius:2px;margin-bottom:6px;word-break:break-all;white-space:pre-wrap">${escHtml(b.commandArg)}</div>
              <div style="display:flex;gap:6px">
                <button class="primary" style="flex:1;padding:3.5px 6px;font-size:10px;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer" onclick="approveBypassToken('${b.token}')">Approve</button>
                <button style="flex:1.2;padding:3.5px 6px;font-size:10px;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;background:var(--vscode-button-secondaryBackground, rgba(127,127,127,0.1));color:var(--vscode-button-secondaryForeground, var(--vscode-foreground));cursor:pointer" onclick="approveBypassTokenWithRemember('${b.token}')">Approve & Remember</button>
                <button style="flex:0.8;padding:3.5px 6px;font-size:10px;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;background:var(--vscode-button-secondaryBackground, rgba(239,68,68,0.15));color:var(--vscode-charts-red);cursor:pointer" onclick="denyBypassToken('${b.token}')">Block</button>
              </div>
            </div>
          `;
        }).join('');
      }
    } else {
      showEl('card-bypasses', false);
    }

    // ── Unified timeline ──────────────────────────────────────────────────────
    const timeline  = state.timeline  || [];
    const rootCause = state.rootCause || null;

    if (timeline.length > 0 || rootCause) {
      showEl('card-activity', true);
      const rcBox = document.getElementById('root-cause-box');
      if (rootCause && rcBox) {
        rcBox.style.display = 'block';
        setEl('rc-confidence', Math.round((rootCause.confidence || 0) * 100) + '% confidence');
        setEl('rc-hypothesis', rootCause.hypothesis || '');
        const rcFix = document.getElementById('rc-fix');
        if (rcFix) {
          if (rootCause.fixHint) { rcFix.textContent = '💡 ' + rootCause.fixHint; rcFix.style.display = 'block'; }
          else                   { rcFix.style.display = 'none'; }
        }
        const rcRecurrence = document.getElementById('rc-recurrence');
        if (rcRecurrence) {
          let recurrenceFound = false;
          if (Array.isArray(state.history)) {
            const pastIncident = state.history.find(h => h.topHypothesis && h.topHypothesis.tag === rootCause.tag && h.builtAt < rootCause.builtAt);
            if (pastIncident && pastIncident.topHypothesis) {
              rcRecurrence.innerHTML = `<strong>⚠️ Incident Re-occurrence:</strong> This error has happened before (${fmtRel(pastIncident.builtAt)}). Last time, you resolved it by using: <em>${escHtml(pastIncident.topHypothesis.fixHint || 'unspecified fix')}</em>.`;
              rcRecurrence.style.display = 'block';
              recurrenceFound = true;
            }
          }
          if (!recurrenceFound) {
            rcRecurrence.style.display = 'none';
          }
        }
      } else if (rcBox) { rcBox.style.display = 'none'; }

      // Helper function to render a clean visual indicator instead of system emojis
      const getIconHtml = (kind) => {
        const svgColors = {
          error: 'var(--vscode-charts-red)',
          warn: 'var(--vscode-charts-yellow)',
          log: 'var(--vscode-descriptionForeground)',
          request: 'var(--vscode-charts-blue)',
          context: 'var(--vscode-descriptionForeground)',
          terminal: 'var(--vscode-descriptionForeground)',
          process_exit: 'var(--vscode-charts-red)',
          ci_failure: 'var(--vscode-charts-red)',
          ci_success: 'var(--vscode-charts-green)',
          deployment: 'var(--vscode-charts-blue)'
        };
        const color = svgColors[kind] || 'var(--vscode-foreground)';
        
        const svgs = {
          error: `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="display:inline-block;vertical-align:middle;color:${color}"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0-1A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM7 4h2v5H7V4zm0 6h2v2H7v-2z"/></svg>`,
          warn: `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="display:inline-block;vertical-align:middle;color:${color}"><path d="M7.56 1.42c.19-.33.68-.33.88 0l7.2 12.5c.19.33-.05.75-.44.75H1.8c-.39 0-.63-.42-.44-.75l7.2-12.5zM8 5v5h1V5H8zm0 6v1h1v-1H8z"/></svg>`,
          log: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:${color}"><rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="5" y1="6" x2="11" y2="6"/><line x1="5" y1="10" x2="11" y2="10"/></svg>`,
          request: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:${color}"><circle cx="8" cy="8" r="6"/><line x1="2" y1="8" x2="14" y2="8"/><path d="M8 2a10.5 10.5 0 0 1 2.5 6A10.5 10.5 0 0 1 8 14 10.5 10.5 0 0 1 5.5 8 10.5 10.5 0 0 1 8 2z"/></svg>`,
          context: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:${color}"><rect x="3" y="3" width="10" height="10" rx="1"/><path d="M3 7h10M7 3v10"/></svg>`,
          terminal: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:${color}"><polyline points="3 5 6 8 3 11"/><line x1="8" y1="11" x2="13" y2="11"/></svg>`,
          process_exit: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:${color}"><circle cx="8" cy="8" r="6"/><line x1="3.8" y1="3.8" x2="12.2" y2="12.2"/></svg>`,
          ci_failure: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:${color}"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`,
          ci_success: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:${color}"><polyline points="3 8 6 11 13 4"/></svg>`,
          deployment: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:${color}"><path d="M14 2L8 8V14L14 2Z"/><path d="M2 14L8 8V2L2 14Z"/></svg>`
        };
        return svgs[kind] || svgs.log;
      };

      const activityList = document.getElementById('activity-list');
      if (activityList) {
        let filteredTimeline = timeline;
        if (_activeServiceFilter) {
          const filterLower = _activeServiceFilter.toLowerCase();
          filteredTimeline = timeline.filter(r => 
            r.summary.toLowerCase().includes('[' + filterLower + ']') ||
            r.summary.toLowerCase().includes('(' + filterLower + ')') ||
            r.summary.toLowerCase().includes(filterLower)
          );
        }

        if (filteredTimeline.length === 0) {
          activityList.innerHTML = '<div class="empty">No events match filter.</div>';
        } else {
          activityList.innerHTML = filteredTimeline.slice(-12).reverse().map(r => {
            const age    = Date.now() - r.ts;
            const ageStr = age < 60000    ? Math.max(1, Math.floor(age / 1000)) + 's ago'
                         : age < 3600000 ? Math.floor(age / 60000) + 'm ago'
                         :                 Math.floor(age / 3600000) + 'h ago';
            const src = r.source || '';
            const sha = r.sha ? ' <span style="font-size:9px;opacity:.6">[' + escHtml(r.sha) + ']</span>' : '';
            return '<div class="activity-row">' +
              '<span style="flex-shrink:0;width:18px;text-align:center;display:flex;align-items:center;justify-content:center">' + getIconHtml(r.kind) + '</span>' +
              (src ? '<span class="activity-source ' + src + '">' + src + '</span>' : '') +
              '<span class="activity-summary">' + escHtml(r.summary) + sha + '</span>' +
              '<span class="activity-time">' + ageStr + '</span>' +
              '</div>';
          }).join('');
        }
      }
    } else { showEl('card-activity', false); }

    // ── Signals ───────────────────────────────────────────────────────────────
    const signals = h.signals || [];
    if (signals.length > 0) {
      showEl('card-signals', true);
      const getSignalIconHtml = (kind) => {
        const svgs = {
          repeated_network_error: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:var(--vscode-charts-blue)"><path d="M1.5 5.5A4.5 4.5 0 0 1 6 1h4a4.5 4.5 0 0 1 4.5 4.5v0A4.5 4.5 0 0 1 10 10H6A4.5 4.5 0 0 1 1.5 5.5z"/><path d="M10.5 4.5L13.5 1.5M10.5 4.5L7.5 1.5"/></svg>`,
          warn_spike: `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style="display:inline-block;vertical-align:middle;color:var(--vscode-charts-yellow)"><path d="M7.56 1.42c.19-.33.68-.33.88 0l7.2 12.5c.19.33-.05.75-.44.75H1.8c-.39 0-.63-.42-.44-.75l7.2-12.5zM8 5v5h1V5H8zm0 6v1h1v-1H8z"/></svg>`,
          repeated_error: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:var(--vscode-charts-red)"><circle cx="8" cy="8" r="6"/><line x1="5.5" y1="5.5" x2="10.5" y2="10.5"/><line x1="10.5" y1="5.5" x2="5.5" y2="10.5"/></svg>`,
          slow_requests: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:var(--vscode-charts-yellow)"><circle cx="8" cy="8" r="6"/><polyline points="8 4 8 8 11 9.5"/></svg>`,
          auth_token_not_stored: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:var(--vscode-charts-blue)"><circle cx="5" cy="11" r="3"/><path d="M7.5 8.5L12 4M10.5 5.5L12 7M12 4L13.5 5.5"/></svg>`,
          auth_500: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:var(--vscode-charts-red)"><path d="M8 1c0 0 5 3 5 8a5 5 0 0 1-10 0c0-5 5-8 5-8z"/></svg>`,
          storage_cleared: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;color:var(--vscode-descriptionForeground)"><path d="M3 4h10M4 4v10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4M6 4V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2"/></svg>`
        };
        return svgs[kind] || `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:inline-block;vertical-align:middle;"><circle cx="8" cy="8" r="6"/><line x1="8" y1="5" x2="8" y2="11"/><line x1="5" y1="8" x2="11" y2="8"/></svg>`;
      };
      const signalsList = document.getElementById('signals-list');
      if (signalsList) {
        signalsList.innerHTML = signals.map(s => {
          const confPct  = Math.round((s.confidence || 0) * 100);
          const barClass = confPct >= 80 ? '' : confPct >= 55 ? ' med' : ' low';
          const toolKey  = s.suggestedTool || 'quick_check';
          const actionText = s.action ? (s.action.length > 58 ? s.action.slice(0, 57) + '…' : s.action) : ('▶ Run ' + toolKey);
          return '<div class="signal-item">' +
            '<span class="signal-icon" style="display:flex;align-items:center;justify-content:center">' + getSignalIconHtml(s.kind) + '</span>' +
            '<div class="signal-body">' +
              '<div class="signal-msg">' + escHtml(s.message) + '</div>' +
              '<div class="signal-meta">' +
                '<div class="conf-bar-wrap"><div class="conf-bar-fill' + barClass + '" style="width:' + confPct + '%"></div></div>' +
                '<span class="conf-pct">' + confPct + '%</span>' +
              '</div>' +
              '<button class="signal-run" onclick="copyTool(' + JSON.stringify(toolKey) + ')">▶ ' + escHtml(actionText) + '</button>' +
            '</div></div>';
        }).join('');
      }
    } else { showEl('card-signals', false); }

    // ── Context pack ──────────────────────────────────────────────────────────
    const pack = state.lastPack;
    if (pack && pack.hasPack) {
      showEl('card-pack', true);
      _currentPackText = pack.contextPack || '';
      setEl('pack-time',    pack.builtAt ? fmtRel(pack.builtAt) : '');
      setEl('pack-trigger', (pack.reason ? '[' + pack.reason + '] ' : '') + (pack.triggerMessage || '(unknown)'));
      setEl('pack-counts',
        (pack.hypothesesCount || 0) + ' hypothesis' + ((pack.hypothesesCount || 0) === 1 ? '' : 'es') +
        ' · ' + (pack.errorsCount || 0) + ' error' + ((pack.errorsCount || 0) === 1 ? '' : 's'));

      const hyp    = pack.topHypothesis;
      const hypBox = document.getElementById('pack-hyp');
      if (hyp && hypBox) {
        hypBox.style.display = 'block';
        setEl('hyp-tag',     hyp.tag || '—');
        setEl('hyp-summary', hyp.summary || '');

        const confEl = document.getElementById('hyp-conf');
        if (confEl) {
          const conf = (hyp.confidence || '').toLowerCase();
          confEl.textContent = 'belief: ' + (conf || '—');
          confEl.className   = 'hyp-conf ' + conf;
        }

        const fixEl = document.getElementById('hyp-fix');
        if (fixEl) {
          if (hyp.fixHint) { fixEl.textContent = '💡 ' + hyp.fixHint; fixEl.style.display = 'block'; }
          else             { fixEl.style.display = 'none'; }
        }

        // Causal chain breadcrumbs
        const chainEl = document.getElementById('causal-chain');
        if (chainEl) {
          const steps = hyp.causalPath || [];
          if (steps.length > 0) {
            chainEl.innerHTML = steps.map((step, i) =>
              '<span style="padding:2px 6px;border-radius:3px;background:rgba(127,127,127,.12)">' + escHtml(step) + '</span>' +
              (i < steps.length - 1 ? '<span style="color:var(--vscode-descriptionForeground);padding:0 2px">→</span>' : '')
            ).join('');
            chainEl.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:3px;margin:8px 0;font-size:10px;font-family:var(--vscode-editor-font-family)';
          } else {
            chainEl.style.display = 'none';
          }
        }

        const calEl = document.getElementById('hyp-calib');
        if (calEl) { calEl.innerHTML = renderCalibrationHtml(hyp); calEl.style.display = 'flex'; }
      } else if (hypBox) { hypBox.style.display = 'none'; }
    } else {
      showEl('card-pack', false);
      _currentPackText = '';
    }

    // ── History ───────────────────────────────────────────────────────────────
    const entries = state.history || [];
    if (entries.length > 0) {
      showEl('card-history', true);
      const histList = document.getElementById('history-list');
      if (histList) {
        histList.innerHTML = entries.slice(0, 10).map(e => {
          const tag    = (e.topHypothesis && e.topHypothesis.tag) || 'baseline';
          const reason = e.reason ? '<span class="history-reason">' + escHtml(e.reason) + '</span>' : '';
          const cal    = e.topHypothesis && e.topHypothesis.calibration;
          let chip = '';
          if (cal && cal.trusted) {
            const pct = Math.round(cal.accuracy * 100);
            chip = '<span class="calib-badge ' + (pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'poor') + '" style="font-size:9px;padding:0 4px">' + pct + '%</span>';
          }
          return '<div class="history-item">' + reason +
            '<span class="history-tag">'  + escHtml(tag) + '</span>' + chip +
            '<span class="history-msg" title="' + escHtml(e.triggerMessage) + '">' + escHtml(e.triggerMessage) + '</span>' +
            '<span class="history-time">' + fmtRel(e.builtAt) + '</span></div>';
        }).join('');
      }
    } else { showEl('card-history', false); }

    // ── Detector health ───────────────────────────────────────────────────────
    const cal = state.calibration;
    if (cal && Array.isArray(cal.perDetector) && cal.perDetector.length > 0) {
      showEl('card-detectors', true);
      const isWarmingUp = !!cal.corpusSeeded;
      setEl('detector-summary',
        isWarmingUp
          ? cal.totalDetectors + ' detector(s) · collecting real verdicts'
          : cal.overallAccuracy !== null
            ? 'overall ' + Math.round(cal.overallAccuracy * 100) + '% · ' + cal.trustedDetectors + '/' + cal.totalDetectors + ' trusted'
            : cal.totalDetectors + ' detector(s) · awaiting verdicts');
      const detList = document.getElementById('detector-list');
      if (detList) {
        detList.innerHTML = cal.perDetector.slice().sort((a, b) => {
          if (!isWarmingUp && a.trusted !== b.trusted) return a.trusted ? -1 : 1;
          if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
          return b.verdicts - a.verdicts;
        }).map(s => {
          let badge;
          if (isWarmingUp) {
            badge = '<span class="calib-badge" style="opacity:.5">prior</span>';
          } else {
            badge = !s.trusted ? '<span class="calib-badge">new</span>'
              : (() => { const pct = Math.round(s.accuracy * 100); return '<span class="calib-badge ' + (pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'poor') + '">' + pct + '%</span>'; })();
          }
          let trend = '';
          if (!isWarmingUp && typeof s.trendDelta === 'number' && s.trendDelta !== 0) {
            const d = Math.round(s.trendDelta * 100);
            trend = '<span class="calib-trend ' + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '▲' : '▼') + Math.abs(d) + '%</span>';
          }
          return '<div class="det-row" style="' + (isWarmingUp ? 'opacity:.5' : '') + '">' + badge + trend +
            '<span class="det-tag">' + escHtml(s.tag) + '</span>' +
            '<span class="det-n">'   + s.verdicts + '/' + s.predictions + '</span></div>';
        }).join('');
      }
    } else { showEl('card-detectors', false); }

    // ── Server info ───────────────────────────────────────────────────────────
    setEl('server-port',      state.port);
    setEl('server-version',   h.version);
    setEl('server-buffered',  h.buffered + ' events');
    setEl('server-analyses',  (u.analysesToday || 0) + (u.analysesAvgPerDay7d ? '  (7d avg: ' + u.analysesAvgPerDay7d + ')' : ''));

    // ── Credits ───────────────────────────────────────────────────────────────
    const showCredits = u.included === null || u.overage > 0 || (u.included > 0 && u.used / u.included >= 0.70);
    showEl('card-usage', showCredits);
    setEl('usage-month',  u.month);
    setEl('usage-resets', fmtDate(u.resetsAt));

    if (u.included === null) {
      showEl('usage-unlimited', true);
      showEl('usage-quota',     false);
      setEl('usage-used-unlim', u.used);
    } else {
      showEl('usage-unlimited', false);
      showEl('usage-quota',     true);
      const pct = u.included > 0 ? Math.min(1, u.used / u.included) : 1;
      const bar = document.getElementById('credit-bar');
      if (bar) {
        bar.style.width = (pct * 100) + '%';
        bar.className   = 'credit-bar-fill' + (u.lowCredits ? ' warn' : '') + (u.overage > 0 ? ' over' : '');
      }
      setEl('usage-used-label',      u.used + ' / ' + u.included + ' used');
      setEl('usage-remaining-label', (u.remaining || 0) + ' left');
      const notice = document.getElementById('notice');
      if (notice) {
        if (u.lowCredits) { notice.textContent = '⚠ Only ' + u.remaining + ' credits left this month.'; notice.className = 'notice visible'; }
        else              { notice.className = 'notice'; }
      }
      showEl('usage-overage', u.overage > 0);
      if (u.overage > 0) {
        setEl('overage-count', u.overage);
        setEl('overage-est',   '$' + (u.estimatedOverageCents / 100).toFixed(2));
        const bs = document.getElementById('billing-status');
        if (bs) {
          bs.textContent = u.billingStatus === 'confirmed' ? '✅ confirmed' : '⏳ pending';
          bs.className   = 'row-value ' + (u.billingStatus === 'confirmed' ? 'billing-confirmed' : 'billing-pending');
        }
      }
    }

    // Render the interactive SVG service topology map
    renderServiceMap(state.services, state.interactions);
  }

  let _simulationNodes = [];
  let _simulationLinks = [];
  let _simulationInterval = null;

  function renderServiceMap(services, interactions) {
    const svg = document.getElementById('service-map-svg');
    const container = document.getElementById('service-map-container');
    const summaryEl = document.getElementById('service-map-summary');
    if (!svg || !container) return;

    const badge = document.getElementById('service-filter-badge');
    const nameEl = document.getElementById('service-filter-name');
    if (badge && nameEl) {
      if (_activeServiceFilter) {
        nameEl.textContent = _activeServiceFilter;
        badge.style.display = 'inline';
      } else {
        badge.style.display = 'none';
      }
    }

    const nodeNames = new Set();
    const sdkByService = {};
    const statsByService = {};

    if (services) {
      Object.keys(services).forEach(key => {
        const s = services[key];
        const name = key.split('/').pop() || '';
        nodeNames.add(name);
        sdkByService[name] = s.sdk;
        statsByService[name] = s;
      });
    }

    if (interactions && interactions.services) {
      interactions.services.forEach(name => nodeNames.add(name));
    }

    const nodesList = Array.from(nodeNames);
    if (nodesList.length === 0) {
      showEl('card-services', false);
      return;
    }
    showEl('card-services', true);

    if (summaryEl) {
      const edgesCount = (interactions && interactions.edges) ? interactions.edges.length : 0;
      summaryEl.textContent = `${nodesList.length} service${nodesList.length !== 1 ? 's' : ''} connected · ${edgesCount} link${edgesCount !== 1 ? 's' : ''}`;
    }

    const prevNodes = {};
    _simulationNodes.forEach(n => { prevNodes[n.id] = n; });

    const width = container.clientWidth || 280;
    const height = 160;
    
    _simulationNodes = nodesList.map(name => {
      const prev = prevNodes[name];
      return {
        id: name,
        x: prev ? prev.x : width / 2 + (Math.random() - 0.5) * 40,
        y: prev ? prev.y : height / 2 + (Math.random() - 0.5) * 40,
        vx: prev ? prev.vx : 0,
        vy: prev ? prev.vy : 0,
        sdk: sdkByService[name] || 'unknown',
        errorCount: statsByService[name] ? statsByService[name].errorCount : 0,
        spanCount: statsByService[name] ? statsByService[name].spanCount : 0,
      };
    });

    const nodeIndexMap = {};
    _simulationNodes.forEach((n, idx) => { nodeIndexMap[n.id] = idx; });

    const rawEdges = (interactions && interactions.edges) || [];
    _simulationLinks = [];
    rawEdges.forEach(e => {
      if (nodeIndexMap[e.source] !== undefined && nodeIndexMap[e.target] !== undefined) {
        _simulationLinks.push({
          source: e.source,
          target: e.target,
          weight: e.weight || 1,
        });
      }
    });

    if (_simulationInterval) clearInterval(_simulationInterval);

    const centerForce = 0.03;
    const repelForce = 400;
    const linkForce = 0.12;

    function step() {
      _simulationNodes.forEach(n => {
        n.vx += (width / 2 - n.x) * centerForce;
        n.vy += (height / 2 - n.y) * centerForce;
      });

      for (let i = 0; i < _simulationNodes.length; i++) {
        const n1 = _simulationNodes[i];
        for (let j = i + 1; j < _simulationNodes.length; j++) {
          const n2 = _simulationNodes[j];
          const dx = n2.x - n1.x;
          const dy = n2.y - n1.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (dist < 75) {
            const force = repelForce / (dist * dist);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            n1.vx -= fx;
            n1.vy -= fy;
            n2.vx += fx;
            n2.vy += fy;
          }
        }
      }

      _simulationLinks.forEach(l => {
        const n1 = _simulationNodes[nodeIndexMap[l.source]];
        const n2 = _simulationNodes[nodeIndexMap[l.target]];
        if (!n1 || !n2) return;
        const dx = n2.x - n1.x;
        const dy = n2.y - n1.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const diff = dist - 55;
        const force = diff * linkForce;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        n1.vx += fx;
        n1.vy += fy;
        n2.vx -= fx;
        n2.vy -= fy;
      });

      _simulationNodes.forEach(n => {
        n.x += n.vx;
        n.y += n.vy;
        const pad = 15;
        n.x = Math.max(pad, Math.min(width - pad, n.x));
        n.y = Math.max(pad, Math.min(height - pad, n.y));
        n.vx *= 0.72;
        n.vy *= 0.72;
      });

      draw();
    }

    function draw() {
      let html = '';

      _simulationLinks.forEach(l => {
        const n1 = _simulationNodes[nodeIndexMap[l.source]];
        const n2 = _simulationNodes[nodeIndexMap[l.target]];
        if (!n1 || !n2) return;
        
        let strokeColor = 'var(--vscode-widget-border, rgba(127,127,127,0.2))';
        let strokeWidth = Math.min(4, 1 + l.weight * 0.5);
        let opacity = 0.6;

        if (_activeServiceFilter) {
          if (l.source === _activeServiceFilter || l.target === _activeServiceFilter) {
            strokeColor = 'var(--vscode-charts-blue)';
            opacity = 1.0;
          } else {
            opacity = 0.15;
          }
        } else if (l.weight > 5) {
          strokeColor = 'var(--vscode-charts-red)';
        } else if (l.weight > 2) {
          strokeColor = 'var(--vscode-charts-yellow)';
        }

        html += `<line x1="${n1.x}" y1="${n1.y}" x2="${n2.x}" y2="${n2.y}" stroke="${strokeColor}" stroke-width="${strokeWidth}" opacity="${opacity}" />`;
      });

      _simulationNodes.forEach(n => {
        const isFiltered = _activeServiceFilter === n.id;
        const hasActiveFilter = !!_activeServiceFilter;
        let opacity = 1.0;
        if (hasActiveFilter) {
          if (isFiltered) {
            opacity = 1.0;
          } else {
            const isConnected = _simulationLinks.some(l => 
              (l.source === _activeServiceFilter && l.target === n.id) ||
              (l.target === _activeServiceFilter && l.source === n.id)
            );
            opacity = isConnected ? 0.75 : 0.25;
          }
        }

        let fill = 'var(--vscode-sideBar-background)';
        let stroke = 'var(--vscode-widget-border, rgba(127,127,127,0.4))';
        if (n.errorCount > 0) {
          stroke = 'var(--vscode-charts-red)';
          if (isFiltered) fill = 'rgba(239, 68, 68, 0.15)';
        } else if (isFiltered) {
          stroke = 'var(--vscode-charts-blue)';
          fill = 'rgba(59, 130, 246, 0.15)';
        } else if (n.sdk === 'node') {
          stroke = 'var(--vscode-charts-green)';
        } else if (n.sdk === 'python') {
          stroke = 'var(--vscode-charts-yellow)';
        }

        const warningDot = n.errorCount > 0 
          ? `<circle cx="${n.x + 7}" cy="${n.y - 7}" r="3.5" fill="var(--vscode-charts-red)" />` 
          : '';

        html += `
          <g class="node-group" style="cursor:pointer" onclick="onServiceNodeClick('${n.id}')" onmousemove="showTooltip(event, '${n.id}', '${n.sdk}', ${n.errorCount}, ${n.spanCount})" onmouseleave="hideTooltip()">
            <circle cx="${n.x}" cy="${n.y}" r="9" fill="${fill}" stroke="${stroke}" stroke-width="2" opacity="${opacity}" />
            ${warningDot}
            <text x="${n.x}" y="${n.y + 18}" font-size="9px" font-weight="600" fill="var(--vscode-foreground)" text-anchor="middle" opacity="${opacity}" style="font-family:var(--vscode-font-family); pointer-events:none">${n.id}</text>
          </g>
        `;
      });

      svg.innerHTML = html;
    }

    for (let i = 0; i < 100; i++) step();

    let count = 0;
    _simulationInterval = setInterval(() => {
      step();
      if (++count > 30) clearInterval(_simulationInterval);
    }, 30);
  }

  window.onServiceNodeClick = function(serviceName) {
    if (_activeServiceFilter === serviceName) {
      _activeServiceFilter = null;
    } else {
      _activeServiceFilter = serviceName;
    }
    if (_lastState) render(_lastState);
  };

  window.onClearServiceFilter = function() {
    _activeServiceFilter = null;
    if (_lastState) render(_lastState);
  };

  window.showTooltip = function(event, id, sdk, errors, spans) {
    const tooltip = document.getElementById('service-map-tooltip');
    if (!tooltip) return;
    const container = document.getElementById('service-map-container');
    const rect = container.getBoundingClientRect();
    
    const x = event.clientX - rect.left + 12;
    const y = event.clientY - rect.top + 12;

    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.style.display = 'block';
    
    tooltip.innerHTML = `
      <div style="font-weight:700;margin-bottom:2px">${id}</div>
      <div style="opacity:0.8">SDK: ${sdk}</div>
      <div style="opacity:0.8;color:${errors > 0 ? 'var(--vscode-charts-red)' : 'inherit'}">Errors: ${errors}</div>
      <div style="opacity:0.8">Spans: ${spans}</div>
    `;
  };

  window.hideTooltip = function() {
    const tooltip = document.getElementById('service-map-tooltip');
    if (tooltip) tooltip.style.display = 'none';
  };


})();