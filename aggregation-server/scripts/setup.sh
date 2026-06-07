#!/usr/bin/env bash
# Mergen Corpus Server — one-shot Cloudflare deploy
# Usage: bash aggregation-server/scripts/setup.sh

set -euo pipefail

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo -e "${BLUE}Mergen Corpus Server — setup${NC}"
echo

# Prerequisite: wrangler authenticated
if ! command -v wrangler &>/dev/null; then
  echo "Installing wrangler..."
  npm install -g wrangler
fi

cd "$(dirname "$0")/.."
npm install

# 1. Create KV namespaces
echo -e "\n${BLUE}Creating KV namespaces...${NC}"
PROD_KV=$(wrangler kv namespace create CALIBRATION_KV --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['id'])" 2>/dev/null || echo "")
PREVIEW_KV=$(wrangler kv namespace create CALIBRATION_KV --preview --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['id'])" 2>/dev/null || echo "")

if [[ -z "$PROD_KV" || -z "$PREVIEW_KV" ]]; then
  echo -e "${YELLOW}Could not auto-create KV namespaces. Run manually:${NC}"
  echo "  wrangler kv namespace create CALIBRATION_KV"
  echo "  wrangler kv namespace create CALIBRATION_KV --preview"
  echo "Then update wrangler.toml with the IDs."
  exit 1
fi

echo -e "${GREEN}KV namespaces created${NC}"
echo "  Production:  $PROD_KV"
echo "  Preview:     $PREVIEW_KV"

# 2. Patch wrangler.toml with real IDs
sed -i.bak \
  -e "s/REPLACE_WITH_YOUR_KV_NAMESPACE_ID/${PROD_KV}/" \
  -e "s/REPLACE_WITH_YOUR_PREVIEW_KV_NAMESPACE_ID/${PREVIEW_KV}/" \
  wrangler.toml
rm -f wrangler.toml.bak
echo "wrangler.toml updated"

# 3. Admin key (optional)
echo -e "\n${BLUE}Admin key (for GET /admin/stats)${NC}"
read -r -p "Set an admin key? [y/N] " SET_KEY
if [[ "$SET_KEY" =~ ^[Yy] ]]; then
  ADMIN_KEY=$(openssl rand -hex 32)
  echo "$ADMIN_KEY" | wrangler secret put CORPUS_ADMIN_KEY
  echo -e "${GREEN}Admin key set.${NC} Save this — it will not be shown again:"
  echo "  X-Admin-Key: $ADMIN_KEY"
fi

# 4. Deploy
echo -e "\n${BLUE}Deploying...${NC}"
npm run deploy

echo -e "\n${GREEN}Done.${NC}"
echo ""
echo "To activate on Mergen installations:"
echo "  MERGEN_TELEMETRY=1 mergen-server start"
echo ""
echo "To verify:"
echo "  curl https://corpus.mergen.dev/health"
echo "  curl https://corpus.mergen.dev/stats"
