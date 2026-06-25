import CausalCanvas from '@/components/CausalCanvas'
import Nav from '@/components/Nav'
import Hero from '@/components/Hero'
import Terminal from '@/components/Terminal'
import QuickStartVideo from '@/components/QuickStartVideo'
import LegacyVsMergen from '@/components/LegacyVsMergen'
import Architecture from '@/components/Architecture'
import EvalProof from '@/components/EvalProof'
import MacroThesis from '@/components/MacroThesis'
import Features from '@/components/Features'
import InteractiveSandbox from '@/components/InteractiveSandbox'
import Integrations from '@/components/Integrations'
import UserGuide from '@/components/UserGuide'
import Pricing from '@/components/Pricing'
import Footer from '@/components/Footer'

export default function Home() {
  return (
    <>
      <CausalCanvas />
      <Nav />
      <div className="notion-page-container">
        {/* Cover Photo */}
        <div className="notion-page-cover" />
        
        {/* Emoji overlay */}
        <div className="notion-page-emoji-container">
          <span className="notion-page-emoji">🛡️</span>
        </div>

        {/* Main Content Area */}
        <main className="wrap notion-page-content">
          <Hero />
          <Terminal />
          <div style={{ maxWidth: '800px', margin: '2rem auto' }}>
            <QuickStartVideo />
          </div>
          <LegacyVsMergen />
          <Architecture />
          <EvalProof />
          <MacroThesis />
          <Features />
          <InteractiveSandbox />
          <Integrations />
          <UserGuide />
          <Pricing />
        </main>
        <Footer />
      </div>
    </>
  )
}
