'use client'

const SlackAuditTrail = () => (
  <div style={{
    marginTop: '1.5rem',
    background: 'var(--surface)',
    border: 'var(--border)',
    borderRadius: '6px',
    padding: '1.25rem',
    fontSize: '0.8rem',
    color: 'var(--gray-400)',
    boxShadow: 'var(--shadow-card)',
  }}>
    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
      <div style={{
        width: '32px',
        height: '32px',
        background: 'var(--accent-bg-soft)',
        border: '1px solid var(--accent)',
        borderRadius: '4px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--accent-text)',
        fontWeight: 800,
        fontSize: '0.65rem'
      }}>
        MRG
      </div>
      <div>
        <div style={{ fontWeight: 700, marginBottom: '4px', color: 'var(--white)' }}>
          Mergen
          <span style={{ fontWeight: 400, fontSize: '0.7rem', color: 'var(--gray-600)', marginLeft: '6px' }}>App 3:17 PM</span>
        </div>
        <div style={{ marginBottom: '8px', color: 'var(--white)' }}>
          <strong>Agent Tool Call Intercepted (Blocked)</strong>
        </div>
        <div style={{
          background: 'var(--code-bg)',
          border: 'var(--border)',
          borderRadius: '6px',
          padding: '12px',
          borderLeft: '4px solid var(--accent)'
        }}>
          <div style={{ color: 'var(--gray-600)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', fontWeight: 700 }}>
            Security Intercept Summary
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', color: 'var(--gray-400)' }}>
            <div>• <strong>Actor:</strong> cursor-agent-server</div>
            <div>• <strong>Action:</strong> rm -rf /var/log/nginx/*</div>
            <div>• <strong>Rule Matched:</strong> block_destructive_commands</div>
            <div>• <strong>Result:</strong> Synchronously blocked in &lt;1ms; blunder logged.</div>
          </div>
        </div>
      </div>
    </div>
  </div>
)

const GateTerminal = () => (
  <div style={{
    marginTop: '1.5rem',
    background: 'var(--code-bg)',
    border: 'var(--border)',
    borderRadius: '6px',
    padding: '16px',
    fontFamily: 'var(--font-geist-mono), monospace',
    fontSize: '0.75rem',
    lineHeight: 1.8,
  }}>
    <div style={{ color: 'var(--gray-600)', marginBottom: '8px' }}># agent calls execute_fix with "terraform destroy prod"</div>
    <div style={{ color: 'var(--gray-400)' }}>→ tool-guard: evaluating in <span style={{ color: 'var(--accent-text)' }}>&lt;1ms</span></div>
    <div style={{ color: 'var(--gray-400)' }}>→ pattern matched: <span style={{ color: 'var(--accent-text)' }}>&quot;terraform destroy&quot;</span> → rule block_destructive_commands</div>
    <div style={{ color: 'var(--gray-400)' }}>→ handler: <span style={{ color: 'var(--accent-text)', fontWeight: 700 }}>BLOCKED</span> (never invoked)</div>
    <div style={{ color: 'var(--gray-400)' }}>→ blunder logged: agent-blunders.json</div>
    <div style={{ marginTop: '8px', color: 'var(--accent-text)', fontWeight: 700 }}>Blocked: Destructive command pattern matched.</div>
  </div>
)

const HitlTerminal = () => (
  <div style={{
    marginTop: '1.5rem',
    background: 'var(--code-bg)',
    border: 'var(--border)',
    borderRadius: '6px',
    padding: '16px',
    fontFamily: 'var(--font-geist-mono), monospace',
    fontSize: '0.75rem',
    lineHeight: 1.8,
  }}>
    <div style={{ color: 'var(--gray-600)', marginBottom: '8px' }}># agent calls execute_fix with "prisma migrate deploy"</div>
    <div style={{ color: 'var(--gray-400)' }}>→ pattern matched: &quot;prisma migrate&quot; → rule hold_schema_mutations</div>
    <div style={{ color: 'var(--gray-400)' }}>→ <span style={{ color: 'var(--accent-text)' }}>HOLD</span>: Promise suspended, token issued</div>
    <div style={{ color: 'var(--gray-400)' }}>→ webhook fired → MERGEN_HITL_WEBHOOK_URL</div>
    <div style={{ color: 'var(--gray-600)', marginTop: '8px', fontSize: '0.7rem' }}># operator clicks approve in Slack...</div>
    <div style={{ color: 'var(--gray-400)' }}>→ POST /hitl/approve?token=a3f9… → <span style={{ color: 'var(--accent-text)' }}>Promise resolved</span></div>
    <div style={{ color: 'var(--accent-text)', fontWeight: 700 }}>Approved: Tool call approved. Handler now executing.</div>
  </div>
)

const IDEHint = () => (
  <div style={{
    marginTop: '1.5rem',
    background: 'var(--surface)',
    border: 'var(--border)',
    borderRadius: '6px',
    padding: '0',
    overflow: 'hidden',
    boxShadow: 'var(--shadow-card)',
  }}>
    <div style={{
      background: 'var(--code-bg)',
      padding: '8px 12px',
      fontSize: '0.65rem',
      color: 'var(--gray-600)',
      borderBottom: 'var(--border)',
      display: 'flex',
      justifyContent: 'space-between',
      fontWeight: 600
    }}>
      <span>auth_middleware.ts — Mergen Context</span>
      <span>mcp.json</span>
    </div>
    <div style={{ padding: '12px', fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.75rem', color: 'var(--gray-400)' }}>
      <div style={{ color: 'var(--gray-600)' }}>// Mergen: Historical Context found</div>
      <div style={{
        display: 'flex',
        gap: '10px',
        color: 'var(--white)',
        background: 'var(--accent-bg-soft)',
        padding: '10px 14px',
        margin: '8px 0',
        borderRadius: '6px',
        lineHeight: 1.5,
        borderLeft: '4px solid var(--accent)'
      }}>
        <span style={{ fontSize: '1rem', color: 'var(--accent)' }}>!</span>
        <div>
          This file was modified in <strong>Incident #388</strong> (OOM Kill).
          <br/>Reason: Recursive token validation on nested JWTs.
          <br/>Constraint: Do not increase stack depth &gt; 4.
        </div>
      </div>
      <div style={{ opacity: 0.65 }}>
        <span style={{ color: 'var(--accent-text)' }}>export const</span> <span style={{ color: 'var(--white)' }}>validateToken</span> = (token: <span style={{ color: 'var(--accent-text)' }}>string</span>) =&gt; &#123;
        <br/>&nbsp;&nbsp;<span style={{ color: 'var(--gray-600)' }}>// checking depth...</span>
      </div>
    </div>
  </div>
)

const features = [
  {
    num: '01',
    title: 'Local Execution Gate',
    desc: (
      <>
        Every MCP tool call passes through a{' '}
        <span className="highlight-yellow">synchronous local policy engine before the handler runs</span>.
        Pattern matched against your JSON rules in under 1ms — no LLM, no network, no probabilistic guardrails.
        PASS calls the handler. BLOCK returns a structured error with a specific guided alternative —
        the agent reformulates and retries within policy instead of stopping dead.
        The AI IDE waits for the response; the gate decides before any code executes.
        <GateTerminal />
      </>
    ),
  },
  {
    num: '02',
    title: 'Human-in-the-Loop (HITL)',
    desc: (
      <>
        For flagged-but-not-blocked calls (schema migrations, high blast-radius commands), the gate{' '}
        <span className="highlight-blue">holds the Promise until a human approves or denies</span>.
        An outbound webhook fires to Slack or any HTTP endpoint with approve/deny URLs.
        The AI IDE blocks — MCP stdio is naturally async, so it waits indefinitely for the JSON-RPC response.
        No polling. No re-submission. One click resolves the hold.
        <HitlTerminal />
      </>
    ),
  },
  {
    num: '03',
    title: 'Override Corpus',
    desc: (
      <>
        Every human override becomes machine-readable policy. After six months: your Friday settlement windows,
        compliance holds, and on-call preferences form your specific
        <span className="highlight-yellow"> operational DNA — enforcing invariants before any autonomous action triggers.</span>
        {' '}The algorithm is reproducible. This corpus is not.
      </>
    ),
  },
  {
    num: '04',
    title: 'Agent Blunder Log',
    desc: (
      <>
        Every blocked action is hash-chained to a tamper-evident log: allowlist blocks, corpus halts, planning gates,
        policy intercepts. The total prevented count is the board-deck answer to{' '}
        <span className="highlight-red">"why would you trust an AI agent with production?"</span>
        {' '}Wired automatically — no setup required.
      </>
    ),
  },
  {
    num: '05',
    title: 'Agent Policy Calibration',
    desc: (
      <>
        Mergen calibrates policy rules dynamically to your specific codebase and infrastructure context.{' '}
        As your team adjusts and tags action overrides, the local gateway updates its rule definitions.
        Every action block is logged instantly.
        <SlackAuditTrail />
      </>
    ),
  },
  {
    num: '06',
    title: 'Measurable Developer ROI',
    desc: (
      <>
        The local gateway tracks blocked security exposures, unapproved database mutations, and destructive commands.{' '}
        It generates a weekly ROI report showing how many hours were saved by preventing accidental database wipes,
        deleted configurations, or security leaks.
      </>
    ),
  },
  {
    num: '07',
    title: 'Shadow Mode',
    desc: (
      <>
        Before enforcing strict command blocks, run Mergen in shadow mode. It observes and records what actions
        it would have blocked or suspended, giving your team a full trust report before
        <span className="highlight-yellow"> you activate strict enforcement gates</span>.
      </>
    ),
  },
  {
    num: '08',
    title: 'Pre-commit Incident Guard',
    desc: (
      <>
        Before you ship, Mergen cross-references every staged file against your incident history.{' '}
        <span className="highlight-red">&ldquo;This file was in 3 incidents last month&rdquo;</span>
        {' '}— the question a code reviewer would ask, encoded as a git hook. The corpus working before the incident happens.
        <IDEHint />
      </>
    ),
  },
]

export default function Features() {
  return (
    <section id="why">
      <span className="section-label">Core Systems</span>
      <h2>
        Control that enforces.
        <br />
        Safety that compounds.
      </h2>
      <div className="feature-grid">
        {features.map((f) => (
          <div
            key={f.num}
            className="feature-card"
          >
            <span className="feature-num">{f.num}</span>
            <h3 className="feature-title">{f.title}</h3>
            <div className="feature-desc">{f.desc}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
