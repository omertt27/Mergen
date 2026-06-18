'use client'

export default function QuickStartVideo() {
  return (
    <div className="quick-start-video" style={{
      marginTop: '4rem',
      aspectRatio: '16/9',
      background: '#000',
      border: '1px solid var(--gray-800)',
      borderRadius: '8px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      overflow: 'hidden',
      boxShadow: '0 40px 100px rgba(0,0,0,0.5)',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: '60px',
          height: '60px',
          borderRadius: '50%',
          background: 'var(--accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 1.5rem',
          cursor: 'pointer',
          transition: 'transform 0.2s',
        }} className="play-btn">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
        <p style={{
          fontFamily: 'var(--font-geist-mono), monospace',
          fontSize: '0.75rem',
          textTransform: 'uppercase',
          letterSpacing: '0.2em',
          color: 'var(--gray-600)',
        }}>
          Watch: 60s Quick Start
        </p>
      </div>
      
      {/* Decorative elements to make it look like a video player */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '4px',
        background: 'rgba(255,255,255,0.1)',
      }}>
        <div style={{ width: '30%', height: '100%', background: 'var(--accent)' }} />
      </div>
    </div>
  )
}
