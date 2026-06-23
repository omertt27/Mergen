export default function Footer() {
  return (
    <footer className="wrap">
      <div className="foot-inner">
        <div>
          <div>© 2026 Mergen</div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.65rem', color: 'var(--gray-600)' }}>
            Execution &amp; Security Gateway for AI Agents.{' '}
            <a href="mailto:hello@mergen.dev" style={{ color: 'var(--accent-text)' }}>
              hello@mergen.dev
            </a>
          </div>
        </div>
        <div>
          <a href="https://github.com/omertt27/Mergen" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="/guide">Guide</a>
          <a href="mailto:hello@mergen.dev">Contact</a>
          <a href="https://github.com/omertt27/Mergen/blob/main/.github/SECURITY.md" target="_blank" rel="noopener noreferrer">Security</a>
          <a href="https://github.com/omertt27/Mergen/blob/main/ARCHITECTURE.md" target="_blank" rel="noopener noreferrer">Architecture</a>
          <a href="/privacy">Privacy</a>
          <a href="/account">Account</a>
        </div>
      </div>
    </footer>
  )
}