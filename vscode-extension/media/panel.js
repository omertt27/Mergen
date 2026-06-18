/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ── State ──────────────────────────────────────────────────────────────────
  let _currentPackText = '';
  let _currentPort     = 3000;
  let _captureTimer    = null;
  let _intentAbort     = null;

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

  // Expose everything that HTML onclick attributes reference
  window.send         = send;
  window.sendFeedback = sendFeedback;
  window.copyTool     = copyTool;
  window.runCmd       = runCmd;
  window.onRefresh    = onRefresh;
  window.onClear      = onClear;

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
    el.textContent   = '⏺ Capturing since ' + new Date(timestamp).toLocaleTimeString();
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

  // ── Utilities ──────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

    // Keep port in sync for intent fetches
    if (state.port) _currentPort = state.port;

    const connected = state.connected;
    document.getElementById('dot').className = 'dot' + (connected ? ' ok' : '');
    showEl('disconnected',   !connected);
    showEl('card-buffer',     connected);
    showEl('card-server',     connected);
    showEl('card-milestone',  false);   // static placeholder — never shown

    // ── Account card — always shown when server is connected ─────────────────
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
    }

    if (!connected) {
      ['card-pack','card-activity','card-signals','card-history','card-detectors','card-usage','card-account'].forEach(id => showEl(id, false));
      return;
    }

    const h = state.health;
    const u = state.usage;

    setEl('plan-badge',  (u && u.planName) || '—');
    setEl('stat-errors', h.errors);
    setEl('stat-warns',  h.warnings);
    setEl('stat-net',    h.networkErrors);

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
      } else if (rcBox) { rcBox.style.display = 'none'; }

      const ICON = { error:'🔴', warn:'🟡', log:'⬜', request:'🟠', context:'⬜',
                     terminal:'💻', process_exit:'💥', ci_failure:'❌', ci_success:'✅', deployment:'🚀' };
      const activityList = document.getElementById('activity-list');
      if (activityList) {
        activityList.innerHTML = timeline.slice(-12).reverse().map(r => {
          const age    = Date.now() - r.ts;
          const ageStr = age < 60000    ? Math.max(1, Math.floor(age / 1000)) + 's ago'
                       : age < 3600000 ? Math.floor(age / 60000) + 'm ago'
                       :                 Math.floor(age / 3600000) + 'h ago';
          const src = r.source || '';
          const sha = r.sha ? ' <span style="font-size:9px;opacity:.6">[' + escHtml(r.sha) + ']</span>' : '';
          return '<div class="activity-row">' +
            '<span style="flex-shrink:0;width:18px;text-align:center">' + (ICON[r.kind] || '⬜') + '</span>' +
            (src ? '<span class="activity-source ' + src + '">' + src + '</span>' : '') +
            '<span class="activity-summary">' + escHtml(r.summary) + sha + '</span>' +
            '<span class="activity-time">' + ageStr + '</span>' +
            '</div>';
        }).join('');
      }
    } else { showEl('card-activity', false); }

    // ── Signals ───────────────────────────────────────────────────────────────
    const signals = h.signals || [];
    if (signals.length > 0) {
      showEl('card-signals', true);
      const SICON = { repeated_network_error:'🔁', warn_spike:'⚠️', repeated_error:'❌',
                      slow_requests:'🐢', auth_token_not_stored:'🔑', auth_500:'🔥', storage_cleared:'🗑️' };
      const signalsList = document.getElementById('signals-list');
      if (signalsList) {
        signalsList.innerHTML = signals.map(s => {
          const confPct  = Math.round((s.confidence || 0) * 100);
          const barClass = confPct >= 80 ? '' : confPct >= 55 ? ' med' : ' low';
          const toolKey  = s.suggestedTool || 'quick_check';
          const actionText = s.action ? (s.action.length > 58 ? s.action.slice(0, 57) + '…' : s.action) : ('▶ Run ' + toolKey);
          return '<div class="signal-item">' +
            '<span class="signal-icon">' + (SICON[s.kind] || '🔍') + '</span>' +
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
      setEl('detector-summary',
        cal.overallAccuracy !== null
          ? 'overall ' + Math.round(cal.overallAccuracy * 100) + '% · ' + cal.trustedDetectors + '/' + cal.totalDetectors + ' trusted'
          : cal.totalDetectors + ' detector(s) · awaiting verdicts');
      const detList = document.getElementById('detector-list');
      if (detList) {
        detList.innerHTML = cal.perDetector.slice().sort((a, b) => {
          if (a.trusted !== b.trusted)   return a.trusted ? -1 : 1;
          if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
          return b.verdicts - a.verdicts;
        }).map(s => {
          const badge = !s.trusted ? '<span class="calib-badge">new</span>'
            : (() => { const pct = Math.round(s.accuracy * 100); return '<span class="calib-badge ' + (pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'poor') + '">' + pct + '%</span>'; })();
          let trend = '';
          if (typeof s.trendDelta === 'number' && s.trendDelta !== 0) {
            const d = Math.round(s.trendDelta * 100);
            trend = '<span class="calib-trend ' + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '▲' : '▼') + Math.abs(d) + '%</span>';
          }
          return '<div class="det-row">' + badge + trend +
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
  }

})();