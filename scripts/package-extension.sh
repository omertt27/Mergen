#!/bin/bash
# package-extension.sh — Package extension for Chrome Web Store

set -e

echo "📦 Packaging Mergen Extension for Chrome Web Store"
echo ""

cd "$(dirname "$0")/../extension"

# Clean previous build
rm -f mergen-extension.zip

# Create zip excluding development files
zip -r mergen-extension.zip . \
  -x "*.git*" \
  -x "node_modules/*" \
  -x "*.DS_Store" \
  -x "store-assets/*" \
  -x "*.md"

echo ""
echo "✅ Extension packaged: extension/mergen-extension.zip"
echo ""
echo "Next steps:"
echo "  1. Go to: https://chrome.google.com/webstore/devconsole"
echo "  2. Click 'New Item'"
echo "  3. Upload mergen-extension.zip"
echo "  4. Fill out store listing"
echo "  5. Submit for review"
echo ""
