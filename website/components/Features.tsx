'use client'

const featureList = [
  {
    label: 'Local Gate',
    title: 'Synchronous local policy engine running inline',
    desc: 'Every MCP tool call passes through a local JSON policy check before the handler executes. Execution occurs in under 1ms with zero network hops, LLM calls, or cloud round-trips. If a block occurs, the gate returns a structured error to the agent containing policy-compliant alternatives, enabling automated path correction.',
  },
  {
    label: 'HITL Execution',
    title: 'Operator approval gates for high blast-radius actions',
    desc: 'Flagged operations—including database schema mutations, structural deletes, and cross-boundary network requests—are held pending operator approval. The async promise blocks at the gateway level, freezing the AI agent tool execution in its tracks without polling, busy-waiting, or context-window loss.',
  },
  {
    label: 'Override Corpus',
    title: 'Transient human decisions transformed into permanent policy',
    desc: 'Every manual approval or rejection of an agent action is recorded. These overrides compile into a structured SQLite corpus, establishing a machine-readable operational policy. Friday settlement windows, data sanitization rules, and developer preferences automatically enforce invariants.',
  },
  {
    label: 'Blunder Log',
    title: 'Tamper-evident append-only safety audits',
    desc: 'All blocked actions, policy violations, and operator overrides are written to a local hash-chained log file (agent-blunders.json). This provides an immutable, local audit trail to verify agent compliance without the overhead of external security logging services.',
  },
  {
    label: 'Shadow Mode',
    title: 'Passive observation before policy enforcement',
    desc: 'Observe agent behaviors without active blocking. Shadow mode intercepts, analyzes, and registers tool calls against the current policy config, compiling a detailed security risk assessment that highlights which rules would have tripped before active gates are enabled.',
  },
  {
    label: 'Git Guard',
    title: 'Pre-commit prevention of recurring outages',
    desc: 'A git pre-commit hook that cross-references modified workspace paths against the local SQLite history of past outages. Surfacing warnings like "this file was modified in 3 recent incident loops" before changes are pushed, enforcing incident postmortem recommendations.',
  },
]

export default function Features() {
  return (
    <section id="why" className="features-section">
      <div className="section-header">
        <span className="section-label">SYSTEM_CAPABILITIES</span>
        <h2 className="section-title">
          Deterministic safety gates.
          <br />
          No probabilistic heuristics.
        </h2>
      </div>

      <div className="features-table">
        {featureList.map((f, i) => (
          <div key={i} className="features-row">
            <div className="features-row-label font-mono">
              {f.label}
            </div>
            <div className="features-row-content">
              <h3 className="features-row-title">{f.title}</h3>
              <p className="features-row-desc">{f.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
