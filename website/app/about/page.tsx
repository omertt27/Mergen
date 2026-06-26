import Nav from '@/components/Nav'
import MacroThesis from '@/components/MacroThesis'
import Footer from '@/components/Footer'

export default function AboutPage() {
  return (
    <>
      <Nav />
      <main className="page-main">
        <div className="wrap">
          <div style={{ padding: '4rem 0 2rem' }}>
            <span className="section-label">Vision</span>
            <h1 style={{
              fontSize: 'clamp(2rem, 4vw, 3rem)',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
              color: 'var(--white)',
              marginBottom: '1rem',
              marginTop: '0.75rem',
            }}>
              The Case for Agent Execution Governance
            </h1>
            <p style={{ color: 'var(--gray-600)', fontSize: '1.05rem', lineHeight: 1.7, maxWidth: 580 }}>
              Why the Agent Execution Governance category exists, why it&apos;s non-discretionary,
              and where Mergen sits in the progression from local gate to enterprise IAM.
            </p>
          </div>
          <MacroThesis />
        </div>
      </main>
      <Footer />
    </>
  )
}
