/* global acquireVsCodeApi */
(function () {
  'use strict';

  document.getElementById('js-diag').textContent = 'JS: running';
  const vscode = acquireVsCodeApi();

  function send(type) { vscode.postMessage({ type }); }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function copyTool(toolName) {
    vscode.postMessage({ type: 'runTool', tool: toolName });
  }

  function runCmd(commandId) {
    vscode.postMessage({ type: 'runCommand', command: commandId });
  }

  // Expose for inline onclick attributes in dynamically-generated HTML
  window.copyTool = copyTool;
  window.runCmd = runCmd;
  window.sendFeedback = sendFeedback;

  let _currentPackText = '';
  document.getElementById('pack-send').addEventListener('click', () => {
    if (!_currentPackText) return;
    vscode.postMessage({
      type: 'sendToChat',
      text: 'Diagnose this runtime issue using the attached Context Pack:\n\n' + _currentPackText,
    });
  });
  document.getElementById('pack-copy').addEventListener('click', () => {
    if (!_currentPackText) return;
    vscode.postMessage({ type: 'copyPack', text: _currentPackText });
  });

  function fmtRel(ms) {
    const diff = Date.now() - ms;
    if (diff < 60000)    return Math.max(1, Math.floor(diff / 1000)) + 's ago';
    if (diff < 3600000)  return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function renderCalibrationHtml(hyp) {
    const cal = hyp && hyp.calibration;
    const pid = hyp && hyp.pid;
    let badgeHtml = '';
    if (cal) {
      if (!cal.trusted) {
        badgeHtml =
          '<span class="calib-badge" title="Need ≥5 verdicts before this score is trusted.">' +
          'New detector · ' + cal.verdicts + '/' + cal.predictions + ' rated' +
          '</span>';
      } else {
        const pct = Math.round(cal.accuracy * 100);
        const cls = pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'poor';
        const correct = Math.round(cal.accuracy * cal.verdicts);
        badgeHtml =
          '<span class="calib-badge ' + cls + '" title="Empirical accuracy across ' + cal.verdicts + ' user verdicts.">' +
          pct + '% · ' + correct + '/' + cal.verdicts + ' correct' +
          '</span>';
        if (typeof cal.trendDelta === 'number') {
          const delta = Math.round(cal.trendDelta * 100);
          if (delta !== 0) {
            const arrow = delta > 0 ? '▲' : '▼';
            const trendCls = delta > 0 ? 'up' : 'down';
            badgeHtml +=
              '<span class="calib-trend ' + trendCls + '" title="7-day trend vs older verdicts.">' +
              arrow + ' ' + Math.abs(delta) + '% (7d)' +
              '</span>';
          }
        }
      }
    } else {
      badgeHtml = '<span class="calib-badge" title="No verdicts recorded yet.">Unrated</span>';
    }
    let buttonsHtml = '';
    if (pid) {
      buttonsHtml =
        '<span class="fb-prompt">Was this right?</span>' +
        '<span class="feedback-btns">' +
          "<button class='fb-btn fb-correct' onclick='sendFeedback(" + JSON.stringify(pid) + ",\"correct\")'>✓ Yes</button>" +
          "<button class='fb-btn fb-partial' onclick='sendFeedback(" + JSON.stringify(pid) + ",\"partial\")'>◐ Sort of</button>" +
          "<button class='fb-btn fb-wrong'   onclick='sendFeedback(" + JSON.stringify(pid) + ",\"wrong\")'>✕ No</button>" +
        '</span>';
    }
    let failHtml = '';
    if (cal && cal.commonFailureModes && cal.commonFailureModes.length > 0 && cal.accuracy < 0.75) {
      const items = cal.commonFailureModes
        .slice(0, 3)
        .map(m => '<li>' + escHtml(m.note) + (m.count > 1 ? ' <span style="opacity:.6">(×' + m.count + ')</span>' : '') + '</li>')
        .join('');
      failHtml =
        '<div class="calib-failmodes">' +
          '<b>Often incorrect when:</b>' +
          '<ul>' + items + '</ul>' +
        '</div>';
    }
    return badgeHtml + '<span class="calib-spacer"></span>' + buttonsHtml + failHtml;
  }

  function sendFeedback(pid, verdict) {
    vscode.postMessage({ type: 'feedback', pid: pid, verdict: verdict });
  }

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'captureStarted') {
      const el = document.getElementById('capture-status');
      if (el) {
        el.textContent = '⏺ Capturing since ' + new Date(data.timestamp).toLocaleTimeString();
        el.style.display = 'block';
      }
    }
  });

  // ── Direct HTTP polling ──────────────────────────────────────────────────
  let _currentPort = 3000;

  async function fetchState(port) {
    const base = 'http://127.0.0.1:' + port;
    const t = 2000;
    const ctrl = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
    const [health, usage, lastPack, history, calibration, unified] = await Promise.all([
      fetch(base + '/health',   { signal: ctrl(t) }).then(r => r.json()),
      fetch(base + '/usage',    { signal: ctrl(t) }).then(r => r.json()),
      fetch(base + '/last-pack',{ signal: ctrl(t) }).then(r => r.json()).catch(() => ({ hasPack: false })),
      fetch(base + '/history',  { signal: ctrl(t) }).then(r => r.json()).then(d => d.entries || []).catch(() => []),
      fetch(base + '/calibration', { signal: ctrl(t) }).then(r => r.json()).catch(() => null),
      fetch(base + '/timeline/unified?seconds=300&limit=12', { signal: ctrl(t) }).then(r => r.json()).catch(() => ({ rows: [], rootCause: null })),
    ]);
    return { connected: true, port, health, usage, lastPack, history, calibration,
             timeline: (unified.rows || []), rootCause: (unified.rootCause || null), error: null };
  }

  async function pollOnce() {
    const ports = [_currentPort];
    for (let i = 3000; i <= 3010; i++) { if (i !== _currentPort) ports.push(i); }
    for (const p of ports) {
      try {
        const state = await fetchState(p);
        _currentPort = p;
        render(state);
        return;
      } catch (_) { /* try next */ }
    }
    render({ connected: false, port: _currentPort, health: null, usage: null,
             lastPack: null, history: [], calibration: null, timeline: [], rootCause: null, error: null });
  }

  pollOnce();
  setInterval(pollOnce, 2000);

  function render(state) {
    const loadingEl = document.getElementById('loading');
    if (loadingEl) loadingEl.style.display = 'none';

    const connected = state.connected;
    document.getElementById('dot').className = 'dot' + (connected ? ' ok' : '');
    document.getElementById('disconnected').style.display = connected ? 'none' : 'block';
    document.getElementById('card-buffer').style.display  = connected ? 'block' : 'none';
    document.getElementById('card-server').style.display  = connected ? 'block' : 'none';

    if (!connected) return;

    const h = state.health;
    const u = state.usage;

    document.getElementById('plan-badge').textContent = (u && u.planName) || '—';
    document.getElementById('stat-errors').textContent = h.errors;
    document.getElementById('stat-warns').textContent  = h.warnings;
    document.getElementById('stat-net').textContent    = h.networkErrors;

    const timeline  = state.timeline || [];
    const rootCause = state.rootCause || null;
    const activityCard = document.getElementById('card-activity');
    const activityList = document.getElementById('activity-list');
    const rcBox        = document.getElementById('root-cause-box');

    if ((timeline.length > 0 || rootCause) && activityCard) {
      activityCard.style.display = 'block';
      if (rootCause && rcBox) {
        rcBox.style.display = 'block';
        const pct = Math.round((rootCause.confidence || 0) * 100);
        const rcConf = document.getElementById('rc-confidence');
        const rcHyp  = document.getElementById('rc-hypothesis');
        const rcFix  = document.getElementById('rc-fix');
        if (rcConf) rcConf.textContent = pct + '% confidence';
        if (rcHyp)  rcHyp.textContent  = rootCause.hypothesis || '';
        if (rcFix) {
          if (rootCause.fixHint) { rcFix.textContent = '💡 ' + rootCause.fixHint; rcFix.style.display = 'block'; }
          else { rcFix.style.display = 'none'; }
        }
      } else if (rcBox) { rcBox.style.display = 'none'; }

      const ICON = { error:'🔴',warn:'🟡',log:'⬜',request:'🟠',context:'⬜',terminal:'💻',process_exit:'💥',ci_failure:'❌',ci_success:'✅',deployment:'🚀' };
      if (activityList) {
        activityList.innerHTML = timeline.slice(-12).reverse().map(function(r) {
          const age = Date.now() - r.ts;
          const ageStr = age < 60000 ? Math.max(1,Math.floor(age/1000))+'s ago' : age < 3600000 ? Math.floor(age/60000)+'m ago' : Math.floor(age/3600000)+'h ago';
          const icon = ICON[r.kind] || '⬜';
          const src  = r.source || '';
          const sha  = r.sha ? ' <span style="font-size:9px;opacity:.6">[' + escHtml(r.sha) + ']</span>' : '';
          return '<div class="activity-row">' +
            '<span style="flex-shrink:0;width:18px;text-align:center">' + icon + '</span>' +
            (src ? '<span class="activity-source ' + src + '">' + src + '</span>' : '') +
            '<span class="activity-summary">' + escHtml(r.summary) + sha + '</span>' +
            '<span class="activity-time">' + ageStr + '</span>' +
            '</div>';
        }).join('');
      }
    } else if (activityCard) { activityCard.style.display = 'none'; }

    const signals = h.signals || [];
    const signalsCard = document.getElementById('card-signals');
    const signalsList = document.getElementById('signals-list');
    if (signals.length > 0) {
      signalsCard.style.display = 'block';
      const SICON = { repeated_network_error:'🔁',warn_spike:'⚠️',repeated_error:'❌',slow_requests:'🐢',auth_token_not_stored:'🔑',auth_500:'🔥',storage_cleared:'🗑️' };
      signalsList.innerHTML = signals.map(s => {
        const icon     = SICON[s.kind] || '🔍';
        const confPct  = Math.round((s.confidence || 0) * 100);
        const barClass = confPct >= 80 ? '' : confPct >= 55 ? ' med' : ' low';
        const toolKey  = s.suggestedTool || 'quick_check';
        const actionText = s.action ? (s.action.length > 58 ? s.action.slice(0,57)+'…' : s.action) : ('▶ Run ' + toolKey);
        return '<div class="signal-item">' +
          '<span class="signal-icon">' + icon + '</span>' +
          '<div class="signal-body">' +
            '<div class="signal-msg">' + escHtml(s.message) + '</div>' +
            '<div class="signal-meta">' +
              '<div class="conf-bar-wrap"><div class="conf-bar-fill' + barClass + '" style="width:' + confPct + '%"></div></div>' +
              '<span class="conf-pct">' + confPct + '%</span>' +
            '</div>' +
            '<button class="signal-run" onclick="copyTool(' + JSON.stringify(toolKey) + ')">▶ ' + escHtml(actionText) + '</button>' +
          '</div></div>';
      }).join('');
    } else { signalsCard.style.display = 'none'; }

    const pack = state.lastPack;
    const packCard = document.getElementById('card-pack');
    if (pack && pack.hasPack) {
      packCard.style.display = 'block';
      _currentPackText = pack.contextPack || '';
      document.getElementById('pack-time').textContent    = pack.builtAt ? fmtRel(pack.builtAt) : '';
      document.getElementById('pack-trigger').textContent = (pack.reason ? '[' + pack.reason + '] ' : '') + (pack.triggerMessage || '(unknown)');
      document.getElementById('pack-counts').textContent  =
        (pack.hypothesesCount || 0) + ' hypothesis' + ((pack.hypothesesCount || 0) === 1 ? '' : 'es') +
        ' · ' + (pack.errorsCount || 0) + ' error' + ((pack.errorsCount || 0) === 1 ? '' : 's');
      const hyp = pack.topHypothesis;
      const hypBox = document.getElementById('pack-hyp');
      if (hyp) {
        hypBox.style.display = 'block';
        document.getElementById('hyp-tag').textContent     = hyp.tag || '—';
        document.getElementById('hyp-summary').textContent = hyp.summary || '';
        const conf   = (hyp.confidence || '').toLowerCase();
        const confEl = document.getElementById('hyp-conf');
        confEl.textContent = 'belief: ' + (hyp.confidence || '—').toLowerCase();
        confEl.className   = 'hyp-conf ' + conf;
        const fixEl = document.getElementById('hyp-fix');
        if (hyp.fixHint) { fixEl.style.display = 'block'; fixEl.textContent = '💡 ' + hyp.fixHint; }
        else { fixEl.style.display = 'none'; }
        const calEl = document.getElementById('hyp-calib');
        calEl.innerHTML     = renderCalibrationHtml(hyp);
        calEl.style.display = 'flex';
      } else { hypBox.style.display = 'none'; }
    } else { packCard.style.display = 'none'; _currentPackText = ''; }

    const entries = state.history || [];
    const histCard = document.getElementById('card-history');
    const histList = document.getElementById('history-list');
    if (entries.length > 0) {
      histCard.style.display = 'block';
      histList.innerHTML = entries.slice(0, 10).map(e => {
        const tag    = (e.topHypothesis && e.topHypothesis.tag) || 'baseline';
        const reason = e.reason ? '<span class="history-reason">' + escHtml(e.reason) + '</span>' : '';
        const cal    = e.topHypothesis && e.topHypothesis.calibration;
        let chip = '';
        if (cal && cal.trusted) {
          const pct = Math.round(cal.accuracy * 100);
          const cls = pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'poor';
          chip = '<span class="calib-badge ' + cls + '" style="font-size:9px;padding:0 4px">' + pct + '%</span>';
        }
        return '<div class="history-item">' + reason +
          '<span class="history-tag">' + escHtml(tag) + '</span>' + chip +
          '<span class="history-msg" title="' + escHtml(e.triggerMessage) + '">' + escHtml(e.triggerMessage) + '</span>' +
          '<span class="history-time">' + fmtRel(e.builtAt) + '</span></div>';
      }).join('');
    } else { histCard.style.display = 'none'; }

    const cal = state.calibration;
    const detCard = document.getElementById('card-detectors');
    const detList = document.getElementById('detector-list');
    if (cal && Array.isArray(cal.perDetector) && cal.perDetector.length > 0) {
      detCard.style.display = 'block';
      const overallTxt = cal.overallAccuracy !== null
        ? 'overall ' + Math.round(cal.overallAccuracy * 100) + '% · ' + cal.trustedDetectors + '/' + cal.totalDetectors + ' trusted'
        : cal.totalDetectors + ' detector(s) · awaiting verdicts';
      document.getElementById('detector-summary').textContent = overallTxt;
      const sorted = cal.perDetector.slice().sort((a, b) => {
        if (a.trusted !== b.trusted) return a.trusted ? -1 : 1;
        if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
        return b.verdicts - a.verdicts;
      });
      detList.innerHTML = sorted.map(s => {
        let badge;
        if (!s.trusted) { badge = '<span class="calib-badge">new</span>'; }
        else {
          const pct = Math.round(s.accuracy * 100);
          const cls = pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'poor';
          badge = '<span class="calib-badge ' + cls + '">' + pct + '%</span>';
        }
        let trend = '';
        if (typeof s.trendDelta === 'number' && s.trendDelta !== 0) {
          const delta = Math.round(s.trendDelta * 100);
          trend = '<span class="calib-trend ' + (delta > 0 ? 'up' : 'down') + '">' + (delta > 0 ? '▲' : '▼') + Math.abs(delta) + '%</span>';
        }
        return '<div class="det-row">' + badge + trend +
          '<span class="det-tag">' + escHtml(s.tag) + '</span>' +
          '<span class="det-n">' + s.verdicts + '/' + s.predictions + '</span></div>';
      }).join('');
    } else { detCard.style.display = 'none'; }

    document.getElementById('server-port').textContent     = state.port;
    document.getElementById('server-version').textContent  = h.version;
    document.getElementById('server-buffered').textContent = h.buffered + ' events';
    const analysesToday = (u.analysesToday || 0);
    const avg = (u.analysesAvgPerDay7d || 0);
    document.getElementById('server-analyses').textContent = analysesToday + (avg ? '  (7d avg: ' + avg + ')' : '');

    const showCredits = u.included === null || u.overage > 0 || (u.included > 0 && u.used / u.included >= 0.70);
    document.getElementById('card-usage').style.display = showCredits ? 'block' : 'none';
    document.getElementById('usage-month').textContent  = u.month;
    document.getElementById('usage-resets').textContent = fmtDate(u.resetsAt);

    if (u.included === null) {
      document.getElementById('usage-unlimited').style.display = 'block';
      document.getElementById('usage-quota').style.display     = 'none';
      document.getElementById('usage-used-unlim').textContent  = u.used;
    } else {
      document.getElementById('usage-unlimited').style.display = 'none';
      document.getElementById('usage-quota').style.display     = 'block';
      const pct = u.included > 0 ? Math.min(1, u.used / u.included) : 1;
      const bar = document.getElementById('credit-bar');
      bar.style.width = (pct * 100) + '%';
      bar.className   = 'credit-bar-fill' + (u.lowCredits ? ' warn' : '') + (u.overage > 0 ? ' over' : '');
      document.getElementById('usage-used-label').textContent      = u.used + ' / ' + u.included + ' used';
      document.getElementById('usage-remaining-label').textContent = (u.remaining || 0) + ' left';
      const notice = document.getElementById('notice');
      if (u.lowCredits) { notice.textContent = '⚠ Only ' + u.remaining + ' credits left this month.'; notice.className = 'notice visible'; }
      else { notice.className = 'notice'; }
      if (u.overage > 0) {
        document.getElementById('usage-overage').style.display = 'block';
        document.getElementById('overage-count').textContent   = u.overage;
        document.getElementById('overage-est').textContent     = '$' + (u.estimatedOverageCents / 100).toFixed(2);
        const bs = document.getElementById('billing-status');
        bs.textContent = u.billingStatus === 'confirmed' ? '✅ confirmed' : '⏳ pending';
        bs.className   = 'row-value ' + (u.billingStatus === 'confirmed' ? 'billing-confirmed' : 'billing-pending');
      } else { document.getElementById('usage-overage').style.display = 'none'; }
    }
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
    catch (_) { return iso; }
  }

})();
