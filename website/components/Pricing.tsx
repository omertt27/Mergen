'use client'

import { useState } from 'react'

const plans = [
  {
    name: 'Solo / Open Source',
    price: '$0',
    period: '/forever',
    pitch: 'Deterministic agent execution gateway on a workstation. Local execution gate, override corpus, pre-commit guard, Agent Blunder Log. No cloud, no card.',
    pilotCondition: null,
    cta: 'Get Started',
    ctaClass: 'btn btn-outline',
    href: 'https://github.com/omertt27/Mergen/blob/main/INSTALL.md',
    featured: false,
  },
  {
    name: 'Growth',
    price: '$299',
    period: '/mo',
    pitch: 'Team-wide execution policy enforcement. Shared override corpus, Slack-to-corpus loop, agent execution visualizer, ROI dashboard. Up to 10 services.',
    pilotCondition: 'Pilot succeeds when Mergen correctly intercepts 1 unsafe agent action in your environment within 7 days.',
    cta: 'Start Growth Pilot →',
    ctaClass: 'btn btn-outline',
    href: 'mailto:hello@mergen.dev?subject=Growth%20Pilot%20Request',
    featured: false,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    pitch: 'VPC / Sandbox isolation gates, CI/CD agent safety gate, compliance controls, VPC deployment — with a 30-day shadow pilot before any commitment.',
    pilotCondition: null,
    cta: 'Schedule a Pilot Call →',
    ctaClass: 'btn btn-white',
    href: 'mailto:hello@mergen.dev?subject=Enterprise%20Pilot%20Request',
    featured: true,
  },
]

type Cell = boolean | string

const matrix: { name: string; solo: Cell; team: Cell; enterprise: Cell }[] = [
  { name: 'Agent command intercept & block',           solo: true,     team: true,     enterprise: true },
  { name: 'Override corpus (enforcement policy)',       solo: 'Local',  team: 'Shared', enterprise: 'Shared' },
  { name: 'Per-environment gate calibration',          solo: true,     team: true,     enterprise: true },
  { name: 'Pre-commit incident guard (git hook)',       solo: true,     team: true,     enterprise: true },
  { name: 'Agent Blunder Log + audit trail',            solo: true,     team: true,     enterprise: true },
  { name: 'Shadow mode (gate audit log)',               solo: true,     team: true,     enterprise: true },
  { name: 'Agent execution visualizer & replay',        solo: false,    team: true,     enterprise: true },
  { name: 'Slack-to-corpus policy enforcement',         solo: false,    team: true,     enterprise: true },
  { name: 'ROI dashboard (hours saved)',                solo: false,    team: true,     enterprise: true },
  { name: 'Slack ownership approval routing',           solo: false,    team: true,     enterprise: true },
  { name: 'CI/CD agent safety gate (GitHub Action)',    solo: false,    team: false,    enterprise: true },
  { name: 'VPC / Sandbox isolation gates',              solo: false,    team: false,    enterprise: true },
  { name: 'VPC deployment + TLS',                       solo: false,    team: false,    enterprise: true },
  { name: 'SSO + RBAC + compliance controls',           solo: false,    team: false,    enterprise: true },
  { name: 'Audit exports (SOC 2 ready)',                solo: false,    team: false,    enterprise: true },
  { name: 'Dedicated onboarding + SLA',                 solo: false,    team: false,    enterprise: true },
]

function Cell({ val }: { val: Cell }) {
  if (val === true)  return <span className="pm-check">✓</span>
  if (val === false) return <span className="pm-no">—</span>
  return <span className="pm-val">{val}</span>
}

export default function Pricing() {
  const [showMatrix, setShowMatrix] = useState(false)

  return (
    <section id="access">
      <span className="section-label">PRICING_AND_ACCESS</span>
      <h2>Start with the local gate.<br />Graduate to Agent IAM.</h2>

      {/* ── Price cards ── */}
      <div className="price-row mt-lg" style={{ maxWidth: '1100px', margin: '8rem auto 0' }}>
        {plans.map((plan) => (
          <div
            key={plan.name}
            className={`price-col${plan.featured ? ' price-col-featured' : ''}`}
          >
            <span className={`price-name${plan.featured ? ' price-name-featured' : ''}`}>
              {plan.name}
            </span>
            <div className="price-val">
              {plan.price}
              {plan.period && <span style={{ fontSize: '0.8rem' }}>{plan.period}</span>}
            </div>
            <p className="price-pitch">{plan.pitch}</p>
            {plan.pilotCondition && (
              <p style={{ fontSize: '0.72rem', color: 'var(--gray-400)', marginBottom: '1.25rem', fontStyle: 'italic', lineHeight: 1.5 }}>
                ✓ {plan.pilotCondition}
              </p>
            )}
            <a href={plan.href} className={plan.ctaClass} style={{ display: 'block', textAlign: 'center' }}>
              {plan.cta}
            </a>
          </div>
        ))}
      </div>

      {/* ── Toggle button ── */}
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '4rem' }}>
        <button
          onClick={() => setShowMatrix(!showMatrix)}
          style={{
            background: 'transparent',
            border: '1px solid var(--gray-800)',
            color: 'var(--gray-400)',
            padding: '12px 24px',
            borderRadius: '30px',
            cursor: 'pointer',
            fontSize: '0.85rem',
            fontWeight: 600,
            transition: 'all 0.25s ease',
            fontFamily: 'var(--font-geist-mono), monospace',
          }}
          onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = '#ffffff'; }}
          onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--gray-800)'; e.currentTarget.style.color = 'var(--gray-400)'; }}
        >
          {showMatrix ? 'Hide Full Feature Comparison ↑' : 'Compare All Features ↓'}
        </button>
      </div>

      {/* ── Feature matrix ── */}
      {showMatrix && (
        <div style={{ maxWidth: '1100px', margin: '4rem auto 0', overflowX: 'auto' }}>
          <table className="pricing-matrix">
            <thead>
              <tr>
                <th style={{ width: '48%' }}>Feature</th>
                <th>Solo</th>
                <th>Growth</th>
                <th>Enterprise</th>
              </tr>
            </thead>
            <tbody>
              {matrix.map((row) => (
                <tr key={row.name}>
                  <td style={{ color: 'var(--gray-400)' }}>{row.name}</td>
                  <td><Cell val={row.solo} /></td>
                  <td><Cell val={row.team} /></td>
                  <td><Cell val={row.enterprise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}