export default function Nav() {
  return (
    <nav>
      <div className="wrap">
        <div className="nav-inner">
          <a href="/" className="logo">Mergen</a>
          <ul className="nav-links">
            <li><a href="#how">How It Works</a></li>
            <li><a href="#why">Capabilities</a></li>
            <li><a href="#integrations">Integrations</a></li>
            <li><a href="#access">Pricing</a></li>
            <li><a href="https://github.com/omertt27/Mergen">GitHub</a></li>
          </ul>
          <a
            href="https://github.com/omertt27/Mergen/blob/main/INSTALL.md"
            className="btn btn-white nav-cta"
          >
            Get Started
          </a>
        </div>
      </div>
    </nav>
  )
}
