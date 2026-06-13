const plans = [
  {
    name: 'Solo / Open Source',
    price: '$0',
    period: '/forever',
    features: [
      'No Datadog required — works with Docker logs and OpenTelemetry',
      'Local override corpus builds automatically from your incidents',
      'All MCP tools: triage_incident, analyze_runtime, validate_fix',
      'Agent Blunder Log + full audit trail (~/.mergen/audit.log)',
      'Shadow mode — 30-day track record before enabling autopilot',
    ],
    cta: 'Get Started',
    ctaClass: 'btn btn-outline',
    href: 'https://github.com/omertt27/Mergen/blob/main/INSTALL.md',
  },
  {
    name: 'Team',
    price: '$49',
    period: '/mo',
    features: [
      'Everything in Solo',
      'Multi-service override corpus with shared team policies',
      'Shadow mode analytics — accuracy report as shareable PDF',
      'Per-service Slack routing with escalation thresholds',
      'Context-assisted MTTR dashboard (assisted vs. unassisted)',
    ],
    cta: 'Start Free Trial',
    ctaClass: 'btn btn-outline',
    href: 'mailto:hello@mergen.dev',
  },
  {
    name: 'Enterprise',
    price: 'Contact',
    period: '',
    features: [
      'Self-hosted VPC deployment with TLS',
      'SSO + RBAC — role-based execution permissions',
      'Compliance exports — immutable JSONL + SOC 2 packaging',
      'Outcome-linked MTTR proof for board-deck reporting',
      'Dedicated onboarding + SLA',
    ],
    cta: 'Contact Sales',
    ctaClass: 'btn btn-white',
    featured: true,
    href: 'mailto:hello@mergen.dev',
  },
]

export default function Pricing() {
  return (
    <section id="access">
      <span className="section-label">05 // Pricing</span>
      <h2>Start free.<br />Scale when the corpus does.</h2>

      <div className="price-row mt-lg" style={{ maxWidth: '1100px', margin: '8rem auto 0' }}>
        {plans.map((plan) => (
          <div
            key={plan.name}
            className="price-col"
            style={
              plan.featured
                ? {
                    background: '#f0f0f0',
                    borderColor: 'var(--accent)',
                    boxShadow: 'inset 0 0 50px rgba(8, 145, 178, 0.05)',
                  }
                : undefined
            }
          >
            <span
              className="price-name"
              style={plan.featured ? { color: 'var(--accent-text)' } : undefined}
            >
              {plan.name}
            </span>
            <div className="price-val">
              {plan.price}
              {plan.period && <span style={{ fontSize: '0.8rem' }}>{plan.period}</span>}
            </div>
            <ul className="price-list">
              {plan.features.map((f, i) => (
                <li
                  key={i}
                  style={plan.featured && i === 0 ? { color: 'var(--white)' } : undefined}
                >
                  {f}
                </li>
              ))}
            </ul>
            <a href={plan.href} className={plan.ctaClass} style={{ display: 'block', textAlign: 'center' }}>
              {plan.cta}
            </a>
          </div>
        ))}
      </div>
    </section>
  )
}
