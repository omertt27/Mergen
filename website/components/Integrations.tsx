const sources = [
  { name: 'Chrome',         type: 'Browser',   tag: 'Extension' },
  { name: 'Node.js',        type: 'Runtime',   tag: 'mergen-node' },
  { name: 'Python',         type: 'Runtime',   tag: 'mergen-python' },
  { name: 'Express',        type: 'Framework', tag: 'Middleware' },
  { name: 'FastAPI',        type: 'Framework', tag: 'Middleware' },
  { name: 'Django',         type: 'Framework', tag: 'Middleware' },
  { name: 'OpenTelemetry',  type: 'Protocol',  tag: 'OTLP :4318' },
  { name: 'Docker',         type: 'Infra',     tag: 'Log stream' },
]

const ides = [
  { name: 'Claude Code',    tag: 'stdio MCP' },
  { name: 'Cursor',         tag: '.cursor/mcp.json' },
  { name: 'Windsurf',       tag: 'mcp_config.json' },
  { name: 'VS Code',        tag: '.vscode/mcp.json' },
]

export default function Integrations() {
  return (
    <section id="integrations">
      <span className="section-label">03 // Integrations</span>
      <h2>
        Plug in anything.
        <br />
        Works immediately.
      </h2>

      <div className="integ-grid mt-lg">
        <div>
          <p className="integ-label">Data Sources</p>
          <div className="integ-row">
            {sources.map((s) => (
              <div key={s.name} className="integ-card">
                <span className="integ-name">{s.name}</span>
                <span className="integ-tag">{s.tag}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="integ-divider">
          <div className="integ-arrow">→</div>
          <span style={{ fontSize: '0.55rem', color: 'var(--gray-600)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            MCP<br />Server
          </span>
          <div className="integ-arrow">→</div>
        </div>

        <div>
          <p className="integ-label">AI IDEs</p>
          <div className="integ-row integ-row-sm">
            {ides.map((ide) => (
              <div key={ide.name} className="integ-card integ-card-accent">
                <span className="integ-name">{ide.name}</span>
                <code className="integ-tag">{ide.tag}</code>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
