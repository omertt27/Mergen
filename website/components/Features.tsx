const SlackAuditTrail = () => (
  <div style={{
    marginTop: '2rem',
    background: '#ffffff',
    border: '1px solid #dddddd',
    borderRadius: '8px',
    padding: '1.25rem',
    fontSize: '0.8rem',
    color: '#111111',
    boxShadow: '0 10px 30px rgba(0,0,0,0.06)',
  }}>
    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
      <div style={{ width: '36px', height: '36px', background: '#ff6600', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffffff', fontWeight: 800, fontSize: '0.6rem' }}>MRG</div>
      <div>
        <div style={{ fontWeight: 900, marginBottom: '4px', color: '#111111' }}>Mergen <span style={{ fontWeight: 400, fontSize: '0.7rem', color: '#666666', marginLeft: '6px' }}>APP 3:17 PM</span></div>
        <div style={{ marginBottom: '8px', color: '#111111' }}>🚫 <b>Agent Tool Call Intercepted (Blocked)</b></div>
        <div style={{ background: '#f5f5f5', border: '1px solid #dddddd', borderRadius: '6px', padding: '12px', borderLeft: '4px solid #ff6600' }}>
          <div style={{ color: '#666666', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', fontWeight: 700 }}>Security Intercept Summary</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', color: '#222222' }}>
            <div>• <b>Actor:</b> cursor-agent-server</div>
            <div>• <b>Action:</b> rm -rf /var/log/nginx/*</div>
            <div>• <b>Rule Matched:</b> block_destructive_commands</div>
            <div>• <b>Result:</b> Synchronously blocked in &lt;1ms; blunder logged.</div>
          </div>
        </div>
      </div>
    </div>
  </div>
)

const GateTerminal = () => (
  <div style={{
    marginTop: '2rem',
    background: '#0f0f0f',
    border: '1px solid #2a2a2a',
    borderRadius: '8px',
    padding: '16px',
    fontFamily: 'var(--font-geist-mono), monospace',
    fontSize: '0.72rem',
    lineHeight: 1.8,
  }}>
    <div style={{ color: '#666666', marginBottom: '8px' }}># agent calls execute_fix with "terraform destroy prod"</div>
    <div style={{ color: '#888888' }}>→ <span style={{ color: '#ffffff' }}>tool-guard</span>: evaluating in <span style={{ color: '#ff6600' }}>&lt;1ms</span></div>
    <div style={{ color: '#888888' }}>→ pattern matched: <span style={{ color: '#ff8c42' }}>&quot;terraform destroy&quot;</span> → rule <span style={{ color: '#ffffff' }}>block_destructive_commands</span></div>
    <div style={{ color: '#888888' }}>→ handler: <span style={{ color: '#ff6600' }}>BLOCKED</span> (never invoked)</div>
    <div style={{ color: '#888888' }}>→ blunder logged: <span style={{ color: '#ffffff' }}>agent-blunders.json</span></div>
    <div style={{ marginTop: '8px', color: '#ff6600' }}>🚫 Mergen policy gate blocked this tool call.</div>
    <div style={{ marginTop: '4px', color: '#888888' }}><span style={{ color: '#ffffff' }}>Why:</span> Local Gate: Destructive command pattern matched.</div>
    <div style={{ marginTop: '4px', color: '#888888' }}><span style={{ color: '#ff6600' }}>What to do instead:</span> Run `terraform plan -destroy` to preview</div>
    <div style={{ color: '#888888' }}>&nbsp;&nbsp;the blast radius, then request human approval before proceeding.</div>
    <div style={{ marginTop: '8px', color: '#666666' }}># agent reformulates → calls analyze_runtime → requests HITL approval</div>
    <div style={{ color: '#ff6600' }}>✅ Handler runs within policy.</div>
  </div>
)

const HitlTerminal = () => (
  <div style={{
    marginTop: '2rem',
    background: '#0f0f0f',
    border: '1px solid #2a2a2a',
    borderRadius: '8px',
    padding: '16px',
    fontFamily: 'var(--font-geist-mono), monospace',
    fontSize: '0.72rem',
    lineHeight: 1.8,
  }}>
    <div style={{ color: '#666666', marginBottom: '8px' }}># agent calls execute_fix with "prisma migrate deploy"</div>
    <div style={{ color: '#888888' }}>→ pattern matched: <span style={{ color: '#ff8c42' }}>&quot;prisma migrate&quot;</span> → rule <span style={{ color: '#ffffff' }}>hold_schema_mutations</span></div>
    <div style={{ color: '#888888' }}>→ <span style={{ color: '#ff8c42' }}>HOLD</span>: Promise suspended, token issued</div>
    <div style={{ color: '#888888' }}>→ webhook fired → <span style={{ color: '#ffffff' }}>MERGEN_HITL_WEBHOOK_URL</span></div>
    <div style={{ color: '#666666', marginTop: '8px', fontSize: '0.68rem' }}># operator clicks approve in Slack...</div>
    <div style={{ color: '#888888' }}>→ POST /hitl/approve?token=a3f9… → <span style={{ color: '#ff6600' }}>Promise resolved</span></div>
    <div style={{ color: '#ff6600' }}>✅ Tool call approved. Handler now executing.</div>
  </div>
)

const IDEHint = () => (
  <div style={{
    marginTop: '2rem',
    background: '#ffffff',
    border: '1px solid #dddddd',
    borderRadius: '6px',
    padding: '0',
    overflow: 'hidden',
    boxShadow: '0 10px 30px rgba(0,0,0,0.06)',
  }}>
    <div style={{ background: '#f5f5f5', padding: '8px 12px', fontSize: '0.65rem', color: '#666666', borderBottom: '1px solid #dddddd', display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
      <span>auth_middleware.ts — Mergen Context</span>
      <span>mcp.json</span>
    </div>
    <div style={{ padding: '12px', fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.72rem', color: '#111111' }}>
      <div style={{ color: '#888888' }}>// Mergen: Historical Context found</div>
      <div style={{
        display: 'flex',
        gap: '10px',
        color: '#111111',
        background: 'rgba(255, 102, 0, 0.07)',
        padding: '10px 14px',
        margin: '8px 0',
        borderRadius: '6px',
        lineHeight: 1.5,
        borderLeft: '4px solid #ff6600'
      }}>
        <span style={{ fontSize: '1rem' }}>⚠️</span>
        <div>
          This file was modified in <b>Incident #388</b> (OOM Kill).
          <br/>Reason: Recursive token validation on nested JWTs.
          <br/>Constraint: Do not increase stack depth &gt; 4.
        </div>
      </div>
      <div style={{ opacity: 0.65 }}>
        <span style={{ color: '#ff6600' }}>export const</span> <span style={{ color: '#ffffff' }}>validateToken</span> = (token: <span style={{ color: '#ff8c42' }}>string</span>) =&gt; &#123;
        <br/>&nbsp;&nbsp;<span style={{ color: '#888888' }}>// checking depth...</span>
      </div>
    </div>
  </div>
)

const features = [
  {
    num: '01',
    icon: '🔒',
    title: 'Local Execution Gate — Deterministic, Not Advisory',
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
    icon: '🧑‍💻',
    title: 'Human-in-the-Loop (HITL) — Held Promise Approval',
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
    icon: '🧬',
    title: 'Override Corpus — Infrastructure DNA',
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
    icon: '🛡️',
    title: 'Agent Blunder Log — CISO Insurance',
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
    icon: '⚙️',
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
    icon: '📊',
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
    icon: '👤',
    title: 'Shadow Mode — 30-Day Audit Track Record',
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
    icon: '🚨',
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
      <span className="section-label">04 // Core Systems</span>
      <h2>
        Control that enforces.
        <br />
        Safety that compounds.
      </h2>
      <div className="feature-grid">
        {features.map((f, i) => (
          <div
            key={f.num}
            className="feature-card"
            style={
              i === 1 ? { gridColumn: '8 / span 5', marginTop: '5rem' }
              : i === 3 ? { gridColumn: '8 / span 4', marginTop: '-1rem' }
              : i === 2 ? { gridColumn: '2 / span 5' }
              : undefined
            }
          >
            <div className="feature-icon">{f.icon}</div>
            <span className="feature-num">{f.num}</span>
            <h3 className="feature-title">{f.title}</h3>
            <p className="feature-desc">{f.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
