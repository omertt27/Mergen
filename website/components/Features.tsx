'use client'

const coreCapabilities = [
  {
    name: 'Prevent',
    title: 'Block dangerous actions before execution',
    desc: 'Every tool call passes through a local JSON policy check before execution. Hazardous commands are blocked locally in <1ms without LLM latency or external network calls.',
    badge: 'PREVENT'
  },
  {
    name: 'Govern',
    title: 'Require human approval for high-risk actions',
    desc: 'Flagged operations—including database mutations, structural deletes, and network requests—are held pending operator approval via local terminals or Slack authorization loops.',
    badge: 'GOVERN'
  },
  {
    name: 'Audit',
    title: 'Maintain tamper-evident execution logs',
    desc: 'All actions, policy decisions, and approval outcomes are written to a local hash-chained blunder log. Provides a cryptographic audit trail that remains local and tamper-evident.',
    badge: 'AUDIT'
  }
]

const productFeatures = [
  {
    label: 'Shadow Mode',
    title: 'Passive observation before policy enforcement',
    desc: 'Observe agent behaviors without active blocking. Shadow mode intercepts, analyzes, and registers tool calls against the current policy config, compiling a detailed security risk assessment that highlights which rules would have tripped before active gates are enabled.',
  },
  {
    label: 'Runtime Visualizer',
    title: 'Living map of service communication',
    desc: 'Map out an auto-generated, living graph of how your services actually communicate and behave at runtime. Mergen traces the causal path of all agent actions, providing an immediate visual audit trail of agent activity.',
  },
  {
    label: 'Incident Memory',
    title: 'SQLite-powered incident re-occurrence prevention',
    desc: 'When an error occurs, Mergen checks SQLite history and returns: "This error has happened before. Here\'s what you did last time and why it worked," eliminating recurring outage loops.',
  },
  {
    label: 'Interception Gate',
    title: 'Pre-empt confidently wrong edits',
    desc: 'Intercept proposed code changes and tool calls against historical failures and local safety rules, flashing alerts like: "This change previously caused incident #12 in your repository" before execution.',
  },
  {
    label: 'Blunder Log',
    title: 'Local, append-only, cryptographic JSON safety audits',
    desc: 'All blocked actions, policy violations, and operator overrides are written to a local hash-chained log file (agent-blunders.json). This provides an immutable, local audit trail to verify agent compliance without the overhead of external security logging services.',
  },
  {
    label: 'Slack Authorization',
    title: 'Human-in-the-loop approval routing loops',
    desc: 'Route high-risk or cross-boundary workstation commands to designated Slack channels. Team leads can approve or override command execution in real-time, feeding authorization decisions back into the shared policy corpus.',
  },
  {
    label: 'Shared Policies',
    title: 'Policy sync and distribution across environments',
    desc: 'Sync and enforce unified policy constraints across local workstations, staging environments, and CI/CD pipelines. Easily version-control rules in a shared repository to guarantee security parity across developer sandboxes.',
  },
]

export default function Features() {
  return (
    <section id="why" className="features-section">
      {/* ─── Part 1: Core Capabilities ─── */}
      <div className="section-header">
        <span className="section-label">CORE_CAPABILITIES</span>
        <h2 className="section-title">
          Secure every agent action.
        </h2>
        <p className="section-desc" style={{ maxWidth: '600px', marginBottom: '3rem' }}>
          Mergen is the gateway that sits between autonomous agents and your environments, 
          providing three pillars of security control.
        </p>
      </div>

      <div className="capabilities-grid">
        {coreCapabilities.map((cap) => (
          <div key={cap.name} className="capability-card">
            <span className="capability-badge font-mono">{cap.badge}</span>
            <h3 className="capability-title">{cap.name}</h3>
            <h4 className="capability-subtitle">{cap.title}</h4>
            <p className="capability-desc">{cap.desc}</p>
          </div>
        ))}
      </div>

      {/* ─── Part 2: Product Features ─── */}
      <div className="section-header" style={{ marginTop: '8rem' }}>
        <span className="section-label">PRODUCT_FEATURES</span>
        <h2 className="section-title">
          Deterministic safety gates.
          <br />
          No probabilistic heuristics.
        </h2>
      </div>

      <div className="features-table">
        {productFeatures.map((f, i) => (
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
