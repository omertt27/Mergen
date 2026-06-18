'use client'

const manualSteps = [
  { time: '0m', action: 'PagerDuty fires', detail: 'Engineer wakes up, opens laptop.' },
  { time: '5m', action: 'Log Grepping', detail: 'Searching through millions of lines in ELK/Datadog.' },
  { time: '15m', action: 'Dashboard Jumping', detail: 'Correlating metrics across 5 different tabs.' },
  { time: '30m', action: 'Slack War Room', detail: 'Asking "who deployed last?" and "is the DB down?"' },
  { time: '45m', action: 'Manual Fix', detail: 'SSHing into boxes, manual rollbacks, praying it works.' },
  { time: '60m+', action: 'Validation', detail: 'Watching dashboards for another 15m to be sure.' },
]

const mergenSteps = [
  { time: '0m', action: 'PagerDuty → Mergen', detail: 'Autonomous loop triggered immediately.' },
  { time: '2s', action: 'Causal Analysis', detail: '800+ events analyzed across all telemetry.' },
  { time: '5s', action: 'Corpus Check', detail: 'Past overrides and policies consulted.' },
  { time: '10s', action: 'Autonomous Fix', detail: 'Fix executed with ≥85% confidence.' },
  { time: '1m', action: 'Validated', detail: 'Error rate confirmed at 0. Incident resolved.' },
  { time: '2m', action: 'Audit Trail', detail: 'Full postmortem posted to Slack for review.' },
]

export default function LegacyVsMergen() {
  return (
    <section id="how">
      <span className="section-label">01 // The Paradigm Shift</span>
      <h2>
        Stop jumping
        <br />
        between dashboards.
      </h2>

      <div className="compare-grid mt-lg" style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '4px',
        background: 'var(--gray-800)',
        border: '1px solid var(--gray-800)',
      }}>
        <div style={{ background: 'var(--bg)', padding: '3rem' }}>
          <h3 style={{ marginBottom: '2rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '1rem', color: 'var(--gray-600)' }}>
            The Manual Loop
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

        <div style={{ background: '#0891b208', padding: '3rem', borderLeft: '1px solid var(--gray-800)' }}>
          <h3 style={{ marginBottom: '2rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '1rem', color: 'var(--accent)' }}>
            The Mergen Loop
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
            background: 'rgba(8, 145, 178, 0.1)',
            border: '1px solid var(--accent)',
            borderRadius: '2px',
          }}>
            <p style={{ fontSize: '0.8rem', color: 'var(--accent-text)', lineHeight: 1.6 }}>
              <strong>Result:</strong> 96% reduction in MTTR. The engineer wakes up to a resolved incident and a full audit trail, rather than a 3am fire drill.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
