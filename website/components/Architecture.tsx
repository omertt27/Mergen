export default function Architecture() {
  return (
    <section id="schematic">
      <span className="section-label">02 // The Schematic</span>
      <h2>Verified Causal Chain.</h2>

      <div className="arch-view mt-lg">
        <div className="arch-grid" />
        <div className="arch-content">
          <div className="arch-box">
            <span className="tag">BROWSER</span>
            <h4>Frontend Event</h4>
            <code style={{ fontSize: '0.6rem', color: 'var(--gray-400)' }}>
              POST /api/checkout
            </code>
          </div>

          <div className="arch-connector" />

          <div
            className="arch-box"
            style={{
              borderColor: 'var(--accent)',
              boxShadow: '0 0 20px rgba(165, 243, 252, 0.1)',
            }}
          >
            <span className="tag" style={{ background: 'var(--accent)', color: '#000' }}>
              NEXUS
            </span>
            <h4>Causal Engine</h4>
            <code style={{ fontSize: '0.6rem', color: 'var(--accent-text)' }}>
              TRACE_ID: 8a2f...
            </code>
          </div>

          <div className="arch-connector" />

          <div className="arch-box">
            <span className="tag">BACKEND</span>
            <h4>Service Signal</h4>
            <code style={{ fontSize: '0.6rem', color: 'var(--gray-400)' }}>
              500 Internal Error
            </code>
          </div>
        </div>
      </div>
    </section>
  )
}
