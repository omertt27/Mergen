'use client'



const features = [
  {
    num: '01',
    title: 'Local Execution Gate',
    desc: (
      <>
        Every MCP tool call passes through a{' '}
        <span className="highlight-yellow">synchronous local policy engine before the handler runs</span>.
        Pattern matched against your JSON rules in under 1ms — no LLM, no network, no probabilistic guardrails.
        PASS calls the handler. BLOCK returns a structured error with a specific guided alternative so the agent reformulates and retries within policy.
      </>
    ),
  },
  {
    num: '02',
    title: 'Human-in-the-Loop (HITL)',
    desc: (
      <>
        For flagged-but-not-blocked calls (schema mutations, high blast-radius commands), the gate{' '}
        <span className="highlight-blue">holds the Promise until a human approves or denies</span>.
        The AI IDE blocks — MCP stdio is naturally async, so it waits indefinitely for the JSON-RPC response with zero polling or re-submission.
      </>
    ),
  },
  {
    num: '03',
    title: 'Override Corpus',
    desc: (
      <>
        Every human override becomes machine-readable policy. Over time, your Friday settlement windows,
        compliance holds, and on-call preferences form your specific
        <span className="highlight-yellow"> operational DNA — enforcing invariants before any autonomous action triggers.</span>
      </>
    ),
  },
  {
    num: '04',
    title: 'Agent Blunder Log',
    desc: (
      <>
        Every blocked action is hash-chained to a local, tamper-evident log (agent-blunders.json).
        Tracks rule blocks, planning gates, and policy intercepts automatically to prove safety without any additional overhead.
      </>
    ),
  },
  {
    num: '05',
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
    num: '06',
    title: 'Pre-commit Incident Guard',
    desc: (
      <>
        Before you ship, Mergen cross-references every staged file against your local SQLite incident history.{' '}
        <span className="highlight-red">&ldquo;This file was in 3 incidents last month&rdquo;</span>
        {' '}— the question a code reviewer would ask, encoded as a git hook. The corpus working before the incident happens.
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
