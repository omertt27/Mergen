import CausalCanvas from '@/components/CausalCanvas'
import Nav from '@/components/Nav'
import Hero from '@/components/Hero'
import Terminal from '@/components/Terminal'
import Architecture from '@/components/Architecture'
import MacroThesis from '@/components/MacroThesis'
import Features from '@/components/Features'
import Integrations from '@/components/Integrations'
import UserGuide from '@/components/UserGuide'
import Pricing from '@/components/Pricing'
import Footer from '@/components/Footer'

export default function Home() {
  return (
    <>
      <CausalCanvas />
      <Nav />
      <main className="wrap">
        <Hero />
        <Terminal />
        <Architecture />
        <MacroThesis />
        <Features />
        <Integrations />
        <UserGuide />
        <Pricing />
      </main>
      <Footer />
    </>
  )
}
