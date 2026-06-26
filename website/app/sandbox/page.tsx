import Nav from '@/components/Nav'
import InteractiveSandbox from '@/components/InteractiveSandbox'
import QuickStartVideo from '@/components/QuickStartVideo'
import Footer from '@/components/Footer'

export default function SandboxPage() {
  return (
    <>
      <Nav />
      <main className="page-main">
        <div className="wrap">
          <div style={{ padding: '4rem 0 2rem' }}>
            <span className="section-label">Try It</span>
            <h1 style={{
              fontSize: 'clamp(2rem, 4vw, 3rem)',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
              color: 'var(--white)',
              marginBottom: '1rem',
              marginTop: '0.75rem',
            }}>
              Interactive Sandbox
            </h1>
            <p style={{ color: 'var(--gray-600)', fontSize: '1.05rem', lineHeight: 1.7, maxWidth: 580 }}>
              See how Mergen intercepts, blocks, and guides AI agent actions in real time —
              no install required.
            </p>
          </div>
          <div style={{ maxWidth: '800px', margin: '0 auto 4rem' }}>
            <QuickStartVideo />
          </div>
          <InteractiveSandbox />
        </div>
      </main>
      <Footer />
    </>
  )
}
