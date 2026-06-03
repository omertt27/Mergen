const plans = [
  {
    name: 'Developer',
    price: '$0',
    period: '/mo',
    features: [
      '500 reasoning calls / month',
      'Full local ring buffer',
      'Agent-native extension',
      'Standard MCP tools',
    ],
    cta: 'Join Waitlist',
    ctaClass: 'btn btn-outline',
  },
  {
    name: 'Solo Pro',
    price: '$29',
    period: '/mo',
    features: [
      'Unlimited reasoning calls',
      'Microservice fleet tracing',
      'Native Source Map resolution',
      'OTel-compliant telemetry',
    ],
    cta: 'Start Free Trial',
    ctaClass: 'btn btn-white',
    featured: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    features: [
      'Air-gapped deployment',
      'Team-wide causal graph',
      'Custom security policies',
      'DLP-compliant redaction',
    ],
    cta: 'Contact Sales',
    ctaClass: 'btn btn-outline',
  },
]

export default function Pricing() {
  return (
    <section id="access">
      <span className="section-label">03 // The Access</span>
      <h2>Machine Reasoning Credits.</h2>

      <div className="price-row mt-lg">
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
              {plan.period && <span>{plan.period}</span>}
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
            <a href="#" className={plan.ctaClass} style={{ display: 'block', textAlign: 'center' }}>
              {plan.cta}
            </a>
          </div>
        ))}
      </div>
    </section>
  )
}
