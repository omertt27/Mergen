'use client'

export default function QuickStartVideo() {
  return (
    <div className="quick-start-video" style={{
      marginTop: '2rem',
      aspectRatio: '16/9',
      background: '#090a0c',
      border: '1px solid var(--border-color)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: '54px',
          height: '54px',
          background: 'var(--color-block)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 1.25rem',
          cursor: 'pointer',
          transition: 'transform 0.15s ease',
        }} className="play-btn">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
        <p style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem',
          textTransform: 'uppercase',
          letterSpacing: '0.15em',
          color: 'var(--text-muted)',
        }}>
          Watch: 60s Quick Start
        </p>
      </div>
      
      {/* Video timeline visual */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '3px',
        background: 'var(--border-color)',
      }}>
        <div style={{ width: '30%', height: '100%', background: 'var(--color-block)' }} />
      </div>
    </div>
  )
}
