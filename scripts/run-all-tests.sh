#!/bin/bash
# run-all-tests.sh — Run complete Mergen test suite

set -e

echo "════════════════════════════════════════════════════════"
echo "  Mergen Test Suite Runner"
echo "════════════════════════════════════════════════════════"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

FAILED=0

# ── Server Tests ────────────────────────────────────────────
echo "📦 Server Tests"
echo "────────────────────────────────────────────────────────"

cd server

echo -e "${YELLOW}→ Running E2E System Tests...${NC}"
if npm test -- e2e-system.test.ts --reporter=verbose; then
  echo -e "${GREEN}✓ E2E System Tests passed${NC}"
else
  echo -e "${RED}✗ E2E System Tests failed${NC}"
  FAILED=$((FAILED + 1))
fi
echo ""

echo -e "${YELLOW}→ Running MCP Tools Tests...${NC}"
if npm test -- mcp-tools.test.ts --reporter=verbose; then
  echo -e "${GREEN}✓ MCP Tools Tests passed${NC}"
else
  echo -e "${RED}✗ MCP Tools Tests failed${NC}"
  FAILED=$((FAILED + 1))
fi
echo ""

echo -e "${YELLOW}→ Running Load & Stress Tests...${NC}"
if npm test -- load-stress.test.ts --reporter=verbose; then
  echo -e "${GREEN}✓ Load & Stress Tests passed${NC}"
else
  echo -e "${RED}✗ Load & Stress Tests failed${NC}"
  FAILED=$((FAILED + 1))
fi
echo ""

echo -e "${YELLOW}→ Running Integration Tests...${NC}"
if npm test -- integration.test.ts --reporter=verbose; then
  echo -e "${GREEN}✓ Integration Tests passed${NC}"
else
  echo -e "${RED}✗ Integration Tests failed${NC}"
  FAILED=$((FAILED + 1))
fi
echo ""

echo -e "${YELLOW}→ Running All Other Tests...${NC}"
if npm test; then
  echo -e "${GREEN}✓ All Server Tests passed${NC}"
else
  echo -e "${RED}✗ Some Server Tests failed${NC}"
  FAILED=$((FAILED + 1))
fi
echo ""

cd ..

# ── Extension Tests (if package.json exists) ────────────────
if [ -f "extension/package.json" ] && grep -q "\"test\"" extension/package.json; then
  echo "🔌 Extension Tests"
  echo "────────────────────────────────────────────────────────"

  cd extension

  # Install if needed
  if [ ! -d "node_modules" ]; then
    echo "Installing extension dependencies..."
    npm install
  fi

  echo -e "${YELLOW}→ Running Content Script Tests...${NC}"
  if npm test; then
    echo -e "${GREEN}✓ Extension Tests passed${NC}"
  else
    echo -e "${RED}✗ Extension Tests failed${NC}"
    FAILED=$((FAILED + 1))
  fi
  echo ""

  cd ..
fi

# ── Summary ─────────────────────────────────────────────────
echo "════════════════════════════════════════════════════════"
if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ All test suites passed!${NC}"
  echo "════════════════════════════════════════════════════════"
  exit 0
else
  echo -e "${RED}✗ $FAILED test suite(s) failed${NC}"
  echo "════════════════════════════════════════════════════════"
  exit 1
fi
