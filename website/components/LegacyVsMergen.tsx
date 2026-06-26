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
  { time: '0m',   action: 'Agent task started',    detail: 'custom-agent --task "refactor users schema"' },
  { time: '5m',   action: 'Wall of stdio text',   detail: 'Agent prints thousands of lines of terminal logs.' },
  { time: '15m',  action: 'System breaks',         detail: 'Local server crashes. You have no idea what mutated.' },
  { time: '30m',  action: 'Trace file edits',      detail: 'Manually inspect git diffs and trace agent tool logs.' },
  { time: '1h',   action: 'Find root cause',       detail: 'Piece together that the agent deleted DB config on step 84.' },
]

const mergenSteps = [
  { time: '0m',  action: 'Agent task started',    detail: 'custom-agent --task "refactor users schema"' },
  { time: '1s',  action: 'Gateway inline tracing',detail: 'Gateway intercepts and indexes every tool call.' },
  { time: '5s',  action: 'Compile audit log',     detail: 'Hash-chains every command, read, and write.' },
  { time: '10s', action: 'Generate living map',   detail: 'Renders visual map of exactly what the agent modified.' },
  { time: '30s', action: 'Spot mutation',         detail: 'Instantly isolate that step 84 modified DB config.' },
]

export default function LegacyVsMergen() {
  return (
    <section id="how">
      <span className="section-label">01 // The Difference</span>
      <h2>
        The gate runs before
        <br />
        the handler does.
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
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: '#ff6600' }}>With Mergen</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {soloMergenSteps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem' }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '35px', color: '#ff6600', fontWeight: 700 }}>{s.time}</span>
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
            background: 'rgba(255, 102, 0, 0.07)',
            borderLeft: '4px solid #ff6600',
            borderRadius: '6px',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}>
            <span style={{ fontSize: '1.1rem', lineHeight: '1', color: '#ff6600' }}>✓</span>
            <p style={{ fontSize: '0.8rem', color: '#ff6600', lineHeight: 1.5, margin: 0 }}>
              <strong>Result:</strong> The bug never ships. Incident history is your reviewer — working silently at commit time.
            </p>
          </div>
        </div>
      </div>

      {/* Team incident response scenario */}
      <p style={{ color: 'var(--gray-600)', fontSize: '0.8rem', fontFamily: 'var(--font-geist-sans), sans-serif', fontWeight: 600, letterSpacing: '-0.01em', marginBottom: '1.25rem', marginTop: '2.5rem' }}>
        Scenario B — Solo developer, visual audit trail of agent activity
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
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: '#ff6600' }}>
            With Mergen
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {mergenSteps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem' }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '35px', color: '#ff6600', fontWeight: 700 }}>{s.time}</span>
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
            background: 'rgba(255, 102, 0, 0.07)',
            borderLeft: '4px solid #ff6600',
            borderRadius: '6px',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}>
            <span style={{ fontSize: '1.1rem', lineHeight: '1', color: '#ff6600' }}>✓</span>
            <p style={{ fontSize: '0.8rem', color: '#ff6600', lineHeight: 1.5, margin: 0 }}>
              <strong>Result:</strong> Living map generated in real-time. You immediately see the exact files, environment variables, and system commands changed by the agent.
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
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: '#ff6600' }}>With Mergen</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {[
              { time: '0ms',  action: 'Agent calls execute_fix',       detail: '{ command: "terraform destroy prod" }' },
              { time: '<1ms', action: 'Local gate evaluates',           detail: 'Pattern "destroy" matched → rule block_destructive_commands' },
              { time: '<1ms', action: 'Handler never runs',             detail: 'MCP error returned before execution.' },
              { time: '<1ms', action: 'Blunder logged',                 detail: 'Recorded to agent-blunders.json with hash chain.' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem' }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '40px', color: '#ff6600', fontWeight: 700, flexShrink: 0 }}>{s.time}</span>
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
            <div style={{ color: '#ff6600', marginBottom: '6px' }}>Tool call blocked by Mergen local policy gate.</div>
            <div style={{ color: '#888888' }}>Tool: <span style={{ color: '#ffffff' }}>execute_fix</span></div>
            <div style={{ color: '#888888' }}>Reason: <span style={{ color: '#ff8c42' }}>Destructive command pattern matched.</span></div>
            <div style={{ color: '#888888', marginTop: '6px' }}>See: GET /agent-blunders</div>
          </div>
          <div style={{
            marginTop: '1rem',
            padding: '1rem 1.25rem',
            background: 'rgba(255, 102, 0, 0.07)',
            borderLeft: '4px solid #ff6600',
            borderRadius: '6px',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}>
            <span style={{ fontSize: '1.1rem', lineHeight: '1', color: '#ff6600' }}>✓</span>
            <p style={{ fontSize: '0.8rem', color: '#ff6600', lineHeight: 1.5, margin: 0 }}>
              <strong>Result:</strong> Production never touched. The gate runs before the handler — deterministically, in under 1ms, with no LLM involved.
            </p>
          </div>
        </div>
      </div>

      {/* Knowledge compounding scenario */}
      <p style={{ color: 'var(--gray-600)', fontSize: '0.8rem', fontFamily: 'var(--font-geist-sans), sans-serif', fontWeight: 600, letterSpacing: '-0.01em', marginBottom: '1.25rem', marginTop: '2.5rem' }}>
        Scenario D — Human overrides compound into persistent agent policy
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
              { time: '0m',  action: 'Constraint found',     detail: 'Write warning in README: "Never let AI rewrite auth_middleware.ts."' },
              { time: '2wk', action: 'Rule is forgotten',    detail: 'README changes or is omitted from agent context window.' },
              { time: '3mo', action: 'Engineer leaves',       detail: 'The context leaves with them. New agent has no idea.' },
              { time: '3mo', action: 'Agent rewrites file',   detail: 'Agent replaces authentication logic with a broken pattern.' },
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
          <h3 style={{ marginBottom: '1.5rem', letterSpacing: '-0.01em', fontSize: '0.95rem', fontWeight: 700, color: '#ff6600' }}>With Mergen</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {[
              { time: '0m',  action: 'Policy registered',     detail: 'Register override: "Block automated commits to auth_middleware.ts."' },
              { time: '1s',  action: 'Hook encoded',          detail: 'Local gate registers the constraint automatically.' },
              { time: '3mo', action: 'Engineer leaves',       detail: 'Constraint remains in SQLite override corpus, queryable & active.' },
              { time: '3mo', action: 'Agent edit blocked',    detail: 'Agent tries to edit file. Git hook blocks commit instantly.' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '1.25rem' }}>
                <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.8rem', width: '35px', color: '#ff6600', fontWeight: 700 }}>{s.time}</span>
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
            background: 'rgba(255, 102, 0, 0.07)',
            borderLeft: '4px solid #ff6600',
            borderRadius: '6px',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}>
            <span style={{ fontSize: '1.1rem', lineHeight: '1', color: '#ff6600' }}>✓</span>
            <p style={{ fontSize: '0.8rem', color: '#ff6600', lineHeight: 1.5, margin: 0 }}>
              <strong>Result:</strong> Overrides persist as machine-enforceable rules. The execution gate blocks agent violations even when you forget they exist.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
