#!/usr/bin/env node
/**
 * generate-icons.js
 * Converts icons/icon.svg → icons/icon{16,32,48,128}.png
 * Requires: npm install -D sharp
 * Run: node generate-icons.js
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('sharp not installed — run: npm install -D sharp');
  process.exit(1);
}

const svgPath = join(__dirname, 'icons', 'icon.svg');
const svg = readFileSync(svgPath);
const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const out = join(__dirname, 'icons', `icon${size}.png`);
  await sharp(svg).resize(size, size).png().toFile(out);
  console.log(`✓ icons/icon${size}.png`);
}
