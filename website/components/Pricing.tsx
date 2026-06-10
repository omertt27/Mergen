const plans = [
  {
    name: 'Individual / Solo',
    price: '$0',
    period: '/forever',
    features: [
      '100% Local Execution via MCP stdio',
      'Local Datadog Trace Compactor (Limited)',
      'Single-service PagerDuty awareness',
      'get_incident_context and get_datadog_trace tools',
      'Read-only infra data routing',
    ],
    cta: 'Get Started',
    ctaClass: 'btn btn-outline',
    href: 'https://github.com/omertt27/Mergen/blob/main/INSTALL.md',
  },
  {
    name: 'Enterprise / Team',
    price: 'Contact us',
    period: '',
    features: [
      'Shared Team Context: Unified Incident Timeline',
      'Unlimited Datadog Trace Compaction (500KB → 1KB)',
      'PagerDuty Webhook Automation (Auto-fetch Traces)',
      'Self-Hosted VPC Deployment with SSO/RBAC',
      'Outcome-Linked MTTR Proof & ROI Dashboard',
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
      <span className="section-label">04 // Pricing</span>
      <h2>One command.<br />Full production intelligence.</h2>

      <div className="price-row mt-lg" style={{ maxWidth: '900px', margin: '8rem auto 0' }}>
        {plans.map((plan) => (
          <div
            key={plan.name}
            className="price-col"
            style={
              plan.featured
                ? {
                    background: '#080808',
                    borderColor: 'var(--accent)',
                    boxShadow: 'inset 0 0 50px rgba(165, 243, 252, 0.05)',
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
