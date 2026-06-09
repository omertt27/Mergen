const plans = [
  {
    name: 'Hobby / Individual',
    price: '$0',
    period: '/forever',
    features: [
      '100% Local Execution via stdio transport',
      'Local SQLite FTS5 vector index',
      'Markdown postmortem parser & timeline compiler',
      'explain_service and search_postmortems tools',
      'Read-only database queries',
    ],
    cta: 'Get Started',
    ctaClass: 'btn btn-outline',
    href: 'https://github.com/omertt27/Mergen/blob/main/INSTALL.md',
  },
  {
    name: 'Enterprise / Scale',
    price: 'Contact us',
    period: '',
    features: [
      'Multi-User Shared Corpus: Unified System of Record',
      'Self-Hosted VPC Deployment with SSO/RBAC',
      'Bi-directional Task Syncing (Jira, Linear, Slack)',
      'Runtime Credential Leak Filters',
      'Outcome-Linked SLA & MTTR Guarantees',
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
      <h2>One command.<br />Full production memory.</h2>

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
