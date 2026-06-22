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
  { time: '5s',  action: 'Check operational memory', detail: 'Matches against past incidents and human overrides.' },
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
      <p style={{ color: 'var(--gray-600)', fontSize: '0.75rem', fontFamily: 'var(--font-geist-mono), monospace', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '1rem' }}>
        Scenario A — Solo developer, no code reviewer
      </p>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '4px',
        background: 'var(--gray-800)',
        border: '1px solid var(--gray-800)',
        marginBottom: '4px',
      }}>
        <div style={{ background: 'var(--bg)', padding: '2rem 3rem' }}>
          <h3 style={{ marginBottom: '2rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '1rem', color: 'var(--gray-600)' }}>Without Mergen</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {soloManualSteps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.5rem', opacity: 0.5 }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '40px' }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.25rem' }}>{s.action}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--gray-600)' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ background: 'rgba(255, 85, 0, 0.02)', padding: '2rem 3rem', borderLeft: '1px solid var(--gray-800)' }}>
          <h3 style={{ marginBottom: '2rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '1rem', color: 'var(--accent)' }}>With Mergen</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {soloMergenSteps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.5rem' }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '40px', color: 'var(--accent)' }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.25rem', color: 'var(--white)' }}>{s.action}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: '2rem', padding: '1.5rem', background: 'rgba(255, 85, 0, 0.06)', border: '1px solid var(--accent)', borderRadius: '4px' }}>
            <p style={{ fontSize: '0.8rem', color: 'var(--accent-text)', lineHeight: 1.6 }}>
              <strong>Result:</strong> The bug never ships. Incident history is your reviewer — working silently at commit time.
            </p>
          </div>
        </div>
      </div>

      {/* Team incident response scenario */}
      <p style={{ color: 'var(--gray-600)', fontSize: '0.75rem', fontFamily: 'var(--font-geist-mono), monospace', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '1rem', marginTop: '3rem' }}>
        Scenario B — Team, production incident at 3am
      </p>
      <div className="compare-grid mt-lg" style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '4px',
        background: 'var(--gray-800)',
        border: '1px solid var(--gray-800)',
      }}>
        <div style={{ background: 'var(--bg)', padding: '3rem' }}>
          <h3 style={{ marginBottom: '2rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '1rem', color: 'var(--gray-600)' }}>
            Without Mergen
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {manualSteps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.5rem', opacity: 0.5 }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '40px' }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.25rem' }}>{s.action}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--gray-600)' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: 'rgba(255, 85, 0, 0.02)', padding: '3rem', borderLeft: '1px solid var(--gray-800)' }}>
          <h3 style={{ marginBottom: '2rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '1rem', color: 'var(--accent)' }}>
            With Mergen
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {mergenSteps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.5rem' }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '40px', color: 'var(--accent)' }}>{s.time}</span>
                <div>
                  <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.25rem', color: 'var(--white)' }}>{s.action}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
          
          <div style={{
            marginTop: '3rem',
            padding: '1.5rem',
            background: 'rgba(255, 85, 0, 0.06)',
            border: '1px solid var(--accent)',
            borderRadius: '4px',
          }}>
            <p style={{ fontSize: '0.8rem', color: 'var(--accent-text)', lineHeight: 1.6 }}>
              <strong>Result:</strong> The engineer wakes up to a resolved incident and a full audit trail — not a 3am fire drill.
              Every action is logged and reversible.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
