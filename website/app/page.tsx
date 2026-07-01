import Nav from '@/components/Nav'
import Hero from '@/components/Hero'
import HowItWorks from '@/components/HowItWorks'
import Features from '@/components/Features'
import CausalCanvas from '@/components/CausalCanvas'
import LegacyVsMergen from '@/components/LegacyVsMergen'
import Integrations from '@/components/Integrations'
import EvalProof from '@/components/EvalProof'
import Pricing from '@/components/Pricing'
import Footer from '@/components/Footer'

export default function Home() {
  return (
    <>
      <Nav />
      <main className="page-main">
        <div className="wrap">
          {/* 1. Hero Section */}
          <Hero />

          {/* 2. How It Works (Agent -> Mergen -> Tools) */}
          <HowItWorks />

          {/* 3 & 4. Core Capabilities (Prevent, Govern, Audit) & Detailed Features */}
          <Features />
          
          {/* Showcase section for Runtime Visualizer (CausalCanvas) */}
          <section id="visualizer" className="visualizer-section">
            <span className="section-label">VISUAL_AUDIT_TRAIL</span>
            <h2 className="section-title">
              Map runtime service communication
            </h2>
            <p className="section-desc">
              Side projects grow large and complex, leading to a forgotten mental model of runtime behavior.
              Mergen maps out an auto-generated, living graph of how your services actually communicate and behave
              at runtime—providing the visual audit trail of agent activity.
            </p>
            <CausalCanvas />
          </section>

          {/* Inline controls vs reactive triage timeline comparison */}
          <LegacyVsMergen />

          {/* 5. System Integrations */}
          <Integrations />

          {/* 6. Adversarial Harness Benchmark */}
          <EvalProof />

          {/* 7. Pricing & Access Tiers */}
          <Pricing />
        </div>
      </main>
      <Footer />
    </>
  )
}
