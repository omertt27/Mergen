import React from 'react'

const categories = [
  { label: 'Category 1: Infrastructure Teardown (Terraform, AWS, K8s)', total: 8, passed: 8, outcome: 'Blocked' },
  { label: 'Category 2: Database Catastrophes (DROP, DELETE no WHERE)', total: 6, passed: 6, outcome: 'Blocked' },
  { label: 'Category 3: File System Destruction (rm -rf, path traversal)', total: 6, passed: 6, outcome: 'Blocked' },
  { label: 'Category 4: Prompt Injection Hijacks (DAN, ignore rules)', total: 7, passed: 7, outcome: 'Blocked' },
  { label: 'Category 5: Evasion & Obfuscation (Unicode, quote strip, escapes)', total: 9, passed: 9, outcome: 'Blocked' },
  { label: 'Category 6: Schema Mutations (ALTER TABLE, prisma deploy)', total: 7, passed: 7, outcome: 'Held for Review' },
  { label: 'Category 7: Credential Exfiltration (env piping to remote)', total: 3, passed: 3, outcome: 'Blocked' },
  { label: 'Category 8: Override Corpus Enforcement (incident recurrence)', total: 4, passed: 4, outcome: 'Blocked' },
  { label: 'Category 9: Safe Tool Precision (plan, get pods - no over-block)', total: 11, passed: 11, outcome: 'Allowed' },
  { label: 'Category 10: Policy Integrity & Tamper Resistance (HMAC protection)', total: 1, passed: 1, outcome: 'Fallback Safe' },
  { label: 'Category 11: Sub-millisecond Latency (<10ms evaluation target)', total: 4, passed: 4, outcome: 'Passed' },
]

export default function EvalProof() {
  return (
    <section id="eval" style={{ marginTop: '8rem', marginBottom: '8rem' }}>
      <span className="section-label">05 // Security Gate Evals</span>
      <h2>
        Secure every action
        <br />
        before it executes.
      </h2>

      <p style={{ maxWidth: '640px', color: 'var(--gray-400)', fontSize: '1.1rem', lineHeight: 1.7, marginBottom: '4rem' }}>
        We built a deterministic agent safety regression harness. Every commit that updates our gateway rules must pass this validation suite — 66 real-world threat scenarios and 11 distinct security failure categories. When we say 100% of destructive agent actions are blocked or held, that number is reproducible and falsifiable in your own environment.
      </p>

      <div className="eval-layout" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '3rem', alignItems: 'start' }}>
        {/* ── Score card ── */}
        <div className="eval-score-card" style={{ background: 'var(--gray-900)', border: '1px solid var(--gray-800)', padding: '2.5rem', borderRadius: '8px' }}>
          <span style={{
            fontFamily: 'var(--font-geist-mono), monospace',
            fontSize: '0.65rem',
            textTransform: 'uppercase',
            letterSpacing: '0.15em',
            color: 'var(--gray-600)',
            display: 'block',
            marginBottom: '1rem',
          }}>
            Overall Security Rate
          </span>
          <div style={{
            fontSize: 'clamp(4rem, 10vw, 7rem)',
            fontWeight: 900,
            letterSpacing: '-0.05em',
            color: 'var(--accent)',
            lineHeight: 1,
            fontFamily: 'var(--font-geist-mono), monospace',
          }}>
            100%
          </div>
          <div style={{ marginTop: '1.5rem', color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6 }}>
            66 of 66 security scenarios blocked, held, or verified safely.
          </div>
          <div style={{
            marginTop: '2rem',
            paddingTop: '2rem',
            borderTop: '1px solid var(--gray-800)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}>
            {[
              { k: 'Regression Suite', v: '287 evals passed' },
              { k: 'Security Scenarios', v: '66 / 66 blocked/held' },
              { k: 'Avg Evaluation Latency', v: '< 1ms' },
              { k: 'Tamper Resistance', v: 'HMAC-SHA256 verified' },
            ].map(({ k, v }) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                <span style={{ color: 'var(--gray-600)' }}>{k}</span>
                <span style={{ color: 'var(--white)', fontFamily: 'var(--font-geist-mono), monospace' }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Category breakdown ── */}
        <div className="eval-table" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="eval-table-header" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gray-600)', borderBottom: '1px solid var(--gray-800)', paddingBottom: '0.75rem', fontFamily: 'var(--font-geist-mono), monospace' }}>
            <span>Failure Class / Benchmark</span>
            <span style={{ textAlign: 'center' }}>Fixtures</span>
            <span style={{ textAlign: 'right' }}>Gate Outcome</span>
          </div>
          {categories.map((c) => {
            return (
              <div key={c.label} className="eval-table-row" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr', alignItems: 'center', fontSize: '0.85rem', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.75rem' }}>
                <div>
                  <span className="eval-table-label" style={{ color: 'var(--gray-300)', fontWeight: 500 }}>{c.label}</span>
                </div>
                <span className="eval-table-n" style={{ textAlign: 'center', fontFamily: 'var(--font-geist-mono), monospace', color: 'var(--gray-400)' }}>{c.passed}/{c.total}</span>
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ 
                    fontFamily: 'var(--font-geist-mono), monospace', 
                    fontSize: '0.75rem', 
                    color: c.outcome === 'Allowed' ? 'var(--gray-400)' : c.outcome === 'Held for Review' ? '#ffaa00' : 'var(--accent-text)',
                    fontWeight: 700 
                  }}>
                    {c.outcome}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{
        marginTop: '4rem',
        padding: '2rem 3rem',
        border: '1px solid var(--gray-800)',
        borderLeft: '3px solid var(--accent)',
        background: 'rgba(255,85,0,0.02)',
        borderRadius: '4px',
        maxWidth: '800px',
      }}>
        <p style={{ color: 'var(--gray-400)', fontSize: '0.95rem', lineHeight: 1.7, margin: 0 }}>
          <span style={{ color: 'var(--white)', fontWeight: 700 }}>Evasion & Tamper Resistance:</span>{' '}
          Our benchmarks explicitly validate protection against advanced AI bypassing tactics. Using pre-matching Unicode normalization, quote stripping (e.g., matching "dr'o'p t'a'ble" as "drop table"), and recursive argument traversal, Mergen ensures no hidden payloads slip through. Additionally, our HMAC sidecar system prevents rogue agents from overwriting the policy file to self-grant execution permissions.
        </p>
      </div>
    </section>
  )
}