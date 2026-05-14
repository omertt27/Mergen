#!/bin/bash
# install.sh — One-command Mergen installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/omertt27/Mergen/main/install.sh | bash
#   or:
#   bash install.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helpers
log() {
  echo -e "${BLUE}ℹ${NC} $1"
}

success() {
  echo -e "${GREEN}✓${NC} $1"
}

error() {
  echo -e "${RED}✗${NC} $1"
}

warn() {
  echo -e "${YELLOW}⚠${NC} $1"
}

hr() {
  echo "────────────────────────────────────────────────────────"
}

echo ""
echo "🚀 Mergen Installer"
echo ""
hr

# Check Node.js
log "Checking Node.js..."
if ! command -v node &> /dev/null; then
  error "Node.js not found"
  echo ""
  echo "Install Node.js 18+ from: https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  error "Node.js 18+ required (you have $(node --version))"
  exit 1
fi
success "Node.js $(node --version)"

# Check npm
if ! command -v npm &> /dev/null; then
  error "npm not found"
  exit 1
fi
success "npm $(npm --version)"

# Install method
echo ""
log "Choose installation method:"
echo "  1. NPM (npx mergen-server) — easiest"
echo "  2. From source (git clone) — for developers"
echo ""
read -p "Choose (1 or 2): " method

if [ "$method" = "1" ]; then
  # NPM installation
  hr
  log "Installing via NPM..."

  if npx -y mergen-server@latest --version; then
    success "Mergen server installed"
  else
    error "NPM installation failed"
    exit 1
  fi

  # Run setup
  echo ""
  log "Running setup wizard..."
  npx -y mergen-server@latest setup

elif [ "$method" = "2" ]; then
  # Source installation
  hr
  log "Installing from source..."

  # Check git
  if ! command -v git &> /dev/null; then
    error "git not found"
    exit 1
  fi

  # Clone repo
  if [ -d "Mergen" ]; then
    warn "Mergen directory already exists, skipping clone"
    cd Mergen
  else
    log "Cloning repository..."
    git clone https://github.com/omertt27/Mergen.git
    cd Mergen
  fi

  # Build server
  log "Building server..."
  cd server
  npm install
  npm run build
  cd ..
  success "Server built"

  # Run setup
  log "Running setup wizard..."
  node scripts/setup.mjs

else
  error "Invalid choice"
  exit 1
fi

# Extension setup
hr
echo ""
log "Browser Extension Setup"
echo ""
echo "  Option A: Chrome Web Store (recommended)"
echo "    → https://chrome.google.com/webstore/detail/mergen/xxx"
echo ""
echo "  Option B: Manual Install"
echo "    1. Open chrome://extensions"
echo "    2. Enable 'Developer mode'"
echo "    3. Click 'Load unpacked'"
if [ "$method" = "2" ]; then
  echo "    4. Select: $(pwd)/extension"
else
  echo "    4. Download extension from GitHub"
fi
echo ""

# Test installation
hr
log "Testing installation..."
echo ""

if [ "$method" = "1" ]; then
  npx -y mergen-server@latest test || warn "Some checks failed (non-critical)"
else
  node server/dist/cli.js test || warn "Some checks failed (non-critical)"
fi

# Success
hr
echo ""
success "Mergen installation complete!"
echo ""
echo "Next steps:"
if [ "$method" = "1" ]; then
  echo "  1. Start server: npx mergen-server start"
  echo "  2. Or add to PATH: npm install -g mergen-server"
else
  echo "  1. Start server: cd Mergen/server && npm start"
  echo "  2. Or add to PATH: cd server && npm link"
fi
echo "  3. Install browser extension (see options above)"
echo "  4. In your IDE, ask: 'Get recent logs'"
echo ""
echo "Documentation: https://github.com/omertt27/Mergen"
echo ""
