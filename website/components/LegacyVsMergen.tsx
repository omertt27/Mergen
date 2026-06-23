'use client'

const soloManualSteps = [
  { time: '0m',   action: 'Write the change',       detail: 'Touch the same file that caused last month\'s outage.' },
  { time: '0m',   action: 'Run tests',              detail: 'Tests pass. No reviewer. Ship it.' },
  { time: '4h',   action: 'Production alert fires', detail: 'Same failure mode. No one warned you.' },
  { time: '4h+',  action: 'Reconstruct context',    detail: 'Grep logs. Trace the history. Piece it together under pressure.' },
]

const soloMergenSteps = [
  { time: '0m',  action: 'Stage the change',         detail: 'git add auth_middleware.ts' },
  { time: '0s',  action: 'Guard runs',               detail: 'Cross-references staged files against incident history.' },
  { time: '1s',  action: 'Warning surfaced',         detail: '"This file was in Incident #388 — do not increase stack depth > 4."' },
  { time: '2m',  action: 'Fix before shipping',      detail: 'Adjust the change. The outage never happens.' },
]

const manualSteps = [
  { time: '0m',   action: 'PagerDuty fires',      detail: 'Engineer wakes up. Opens laptop.' },
  { time: '5m',   action: 'Check logs',            detail: 'Grep through millions of lines across services.' },
  { time: '15m',  action: 'Check dashboards',      detail: 'Correlate metrics across 5 different tabs.' },
  { time: '30m',  action: 'Ask Slack',             detail: '"Who deployed last?" "Is the DB down?"' },
  { time: '45m',  action: 'Guess root cause',      detail: 'Apply a fix based on intuition. Hope it works.' },
  { time: '60m+', action: 'Watch and wait',        detail: 'Monitor dashboards for another 15 min to confirm.' },
]

const mergenSteps = [
  { time: '0m',  action: 'PagerDuty fires',        detail: 'Mergen receives the webhook.' },
  { time: '2s',  action: 'Analyze telemetry',      detail: 'Correlates logs, traces, and infra signals.' },
  { time: '5s',  action: 'Check policy & overrides', detail: 'Matches against past incidents and human overrides.' },
  { time: '10s', action: 'Generate validated fix',  detail: 'Produces a remediation plan at ≥85% confidence.' },
  { time: '1m',  action: 'Resolve or recommend',   detail: 'Executes (autopilot) or posts fix for approval.' },
  { time: '2m',  action: 'Audit trail posted',     detail: 'Full root cause + actions logged to Slack.' },
]

export default function LegacyVsMergen() {
  return (
    <section id="how">
      <span className="section-label">01 // The Difference</span>
      <h2>
        Before Mergen.
        <br />
        After Mergen.
      </h2>

      {/* Solo dev scenario */}
      <p style={{ color: 'var(--gray-600)', fontSize: '0.8rem', fontFamily: 'var(--font-geist-sans), sans-serif', fontWeight: 600, letterSpacing: '-0.01em', marginBottom: '1.25rem' }}>
        Scenario A — Solo developer, no code reviewer
      </p>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '1px',
        background: 'var(--gray-800)',
        border: '1px solid var(--gray-800)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        marginBottom: '2.5rem',
      }}>
        <div style={{ background: 'var(--surface)', padding: '2.5rem' }}>
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: 'var(--gray-600)' }}>Without Mergen</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {soloManualSteps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem', opacity: 0.5 }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '35px', color: 'var(--gray-600)' }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, marginBottom: '0.2rem', color: 'var(--white)' }}>{s.action}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--gray-600)' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ background: 'rgba(46, 125, 50, 0.02)', padding: '2.5rem', borderLeft: '1px solid var(--gray-800)' }}>
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: '#2e7d32' }}>With Mergen</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {soloMergenSteps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem' }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '35px', color: '#2e7d32', fontWeight: 700 }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, marginBottom: '0.2rem', color: 'var(--white)' }}>{s.action}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{
            marginTop: '2rem',
            padding: '1rem 1.25rem',
            background: '#edf6ec',
            borderLeft: '4px solid #2e7d32',
            borderRadius: '6px',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}>
            <span style={{ fontSize: '1.1rem', lineHeight: '1' }}>✅</span>
            <p style={{ fontSize: '0.8rem', color: '#2e7d32', lineHeight: 1.5, margin: 0 }}>
              <strong>Result:</strong> The bug never ships. Incident history is your reviewer — working silently at commit time.
            </p>
          </div>
        </div>
      </div>

      {/* Team incident response scenario */}
      <p style={{ color: 'var(--gray-600)', fontSize: '0.8rem', fontFamily: 'var(--font-geist-sans), sans-serif', fontWeight: 600, letterSpacing: '-0.01em', marginBottom: '1.25rem', marginTop: '2.5rem' }}>
        Scenario B — Team, production incident at 3am
      </p>
      <div className="compare-grid mt-lg" style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '1px',
        background: 'var(--gray-800)',
        border: '1px solid var(--gray-800)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        marginBottom: '2.5rem',
      }}>
        <div style={{ background: 'var(--surface)', padding: '2.5rem' }}>
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: 'var(--gray-600)' }}>
            Without Mergen
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {manualSteps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem', opacity: 0.5 }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '35px', color: 'var(--gray-600)' }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, marginBottom: '0.2rem', color: 'var(--white)' }}>{s.action}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--gray-600)' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: 'rgba(46, 125, 50, 0.02)', padding: '2.5rem', borderLeft: '1px solid var(--gray-800)' }}>
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: '#2e7d32' }}>
            With Mergen
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {mergenSteps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem' }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '35px', color: '#2e7d32', fontWeight: 700 }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, marginBottom: '0.2rem', color: 'var(--white)' }}>{s.action}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
          
          <div style={{
            marginTop: '2rem',
            padding: '1rem 1.25rem',
            background: '#edf6ec',
            borderLeft: '4px solid #2e7d32',
            borderRadius: '6px',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}>
            <span style={{ fontSize: '1.1rem', lineHeight: '1' }}>✅</span>
            <p style={{ fontSize: '0.8rem', color: '#2e7d32', lineHeight: 1.5, margin: 0 }}>
              <strong>Result:</strong> The engineer wakes up to a resolved incident and a full audit trail — not a 3am fire drill.
              Every action is logged and reversible.
            </p>
          </div>
        </div>
      </div>

      {/* HITL gate scenario */}
      <p style={{ color: 'var(--gray-600)', fontSize: '0.8rem', fontFamily: 'var(--font-geist-sans), sans-serif', fontWeight: 600, letterSpacing: '-0.01em', marginBottom: '1.25rem', marginTop: '2.5rem' }}>
        Scenario C — AI agent attempts a destructive command
      </p>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '1px',
        background: 'var(--gray-800)',
        border: '1px solid var(--gray-800)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        marginBottom: '2.5rem',
      }}>
        <div style={{ background: 'var(--surface)', padding: '2.5rem' }}>
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: 'var(--gray-600)' }}>Without Mergen</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {[
              { time: '0ms',  action: 'Agent calls execute_fix',     detail: '{ command: "terraform destroy prod" }' },
              { time: '0ms',  action: 'Handler runs immediately',     detail: 'No gate. No check. No approval.' },
              { time: '1s',   action: 'terraform destroy executes',   detail: 'Production infrastructure torn down.' },
              { time: '∞',    action: 'Incident declared',            detail: 'Human wakes up to a destroyed environment.' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem', opacity: 0.5 }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '40px', color: 'var(--gray-600)', flexShrink: 0 }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, marginBottom: '0.2rem', color: 'var(--white)' }}>{s.action}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--gray-600)', fontFamily: 'var(--font-geist-mono), monospace' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ background: 'rgba(46, 125, 50, 0.02)', padding: '2.5rem', borderLeft: '1px solid var(--gray-800)' }}>
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: '#2e7d32' }}>With Mergen</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {[
              { time: '0ms',  action: 'Agent calls execute_fix',       detail: '{ command: "terraform destroy prod" }' },
              { time: '<1ms', action: 'Local gate evaluates',           detail: 'Pattern "destroy" matched → rule block_destructive_commands' },
              { time: '<1ms', action: 'Handler never runs',             detail: 'MCP error returned before execution.' },
              { time: '<1ms', action: 'Blunder logged',                 detail: 'Recorded to agent-blunders.json with hash chain.' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem' }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '40px', color: '#2e7d32', fontWeight: 700, flexShrink: 0 }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, marginBottom: '0.2rem', color: 'var(--white)' }}>{s.action}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--gray-400)', fontFamily: 'var(--font-geist-mono), monospace' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{
            marginTop: '1.5rem',
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: '6px',
            padding: '12px 16px',
            fontFamily: 'var(--font-geist-mono), monospace',
            fontSize: '0.72rem',
          }}>
            <div style={{ color: '#ef4444', marginBottom: '6px' }}>🚫 Tool call blocked by Mergen local policy gate.</div>
            <div style={{ color: '#94a3b8' }}>Tool: <span style={{ color: '#e2e8f0' }}>execute_fix</span></div>
            <div style={{ color: '#94a3b8' }}>Reason: <span style={{ color: '#fbbf24' }}>Destructive command pattern matched.</span></div>
            <div style={{ color: '#94a3b8', marginTop: '6px' }}>See: GET /agent-blunders</div>
          </div>
          <div style={{
            marginTop: '1rem',
            padding: '1rem 1.25rem',
            background: '#edf6ec',
            borderLeft: '4px solid #2e7d32',
            borderRadius: '6px',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}>
            <span style={{ fontSize: '1.1rem', lineHeight: '1' }}>✅</span>
            <p style={{ fontSize: '0.8rem', color: '#2e7d32', lineHeight: 1.5, margin: 0 }}>
              <strong>Result:</strong> Production never touched. The gate runs before the handler — deterministically, in under 1ms, with no LLM involved.
            </p>
          </div>
        </div>
      </div>

      {/* Knowledge compounding scenario */}
      <p style={{ color: 'var(--gray-600)', fontSize: '0.8rem', fontFamily: 'var(--font-geist-sans), sans-serif', fontWeight: 600, letterSpacing: '-0.01em', marginBottom: '1.25rem', marginTop: '2.5rem' }}>
        Scenario D — Postmortem that compounds into policy
      </p>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '1px',
        background: 'var(--gray-800)',
        border: '1px solid var(--gray-800)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
      }}>
        <div style={{ background: 'var(--surface)', padding: '2.5rem' }}>
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: 'var(--gray-600)' }}>Without Mergen</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {[
              { time: '0m',  action: 'Incident resolved',    detail: 'Engineer writes a postmortem in Notion. Team reads it once.' },
              { time: '2wk', action: 'Postmortem is stale',  detail: 'Nobody updates it. The constraint lives in one person\'s head.' },
              { time: '3mo', action: 'Engineer leaves',      detail: 'The constraint — "never resize pool on Friday" — is gone.' },
              { time: '3mo', action: 'Same incident',        detail: 'New on-call rebuilds the understanding from scratch.' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem', opacity: 0.5 }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '35px', color: 'var(--gray-600)' }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, marginBottom: '0.2rem', color: 'var(--white)' }}>{s.action}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--gray-600)' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ background: 'rgba(46, 125, 50, 0.02)', padding: '2.5rem', borderLeft: '1px solid var(--gray-800)' }}>
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: '#2e7d32' }}>With Mergen</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {[
              { time: '0m',  action: 'Incident resolved',      detail: 'Mergen records the override: "skip pool resize — Friday batch window."' },
              { time: '1s',  action: 'Policy encoded',          detail: 'Override corpus entry created. Applies to all future incidents of this type.' },
              { time: '3mo', action: 'Engineer leaves',         detail: 'The constraint stays — in the corpus, queryable, enforceable.' },
              { time: '3mo', action: 'Similar incident fires',  detail: 'Mergen surfaces: "This pattern was overridden 6× — reason: batch-window." Autopilot pauses.' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem' }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '35px', color: '#2e7d32', fontWeight: 700 }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, marginBottom: '0.2rem', color: 'var(--white)' }}>{s.action}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{
            marginTop: '2rem',
            padding: '1rem 1.25rem',
            background: '#edf6ec',
            borderLeft: '4px solid #2e7d32',
            borderRadius: '6px',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}>
            <span style={{ fontSize: '1.1rem', lineHeight: '1' }}>✅</span>
            <p style={{ fontSize: '0.8rem', color: '#2e7d32', lineHeight: 1.5, margin: 0 }}>
              <strong>Result:</strong> The knowledge compounds. Every incident makes the next one faster to resolve — for any engineer, any agent, forever.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
