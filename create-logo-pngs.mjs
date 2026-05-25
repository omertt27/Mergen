#!/usr/bin/env node
/**
 * create-logo-pngs.mjs
 * Generates PNG logos in various sizes from the SVG source
 */
import sharp from 'sharp';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const svgPath = join(__dirname, 'vscode-extension/icons/icon16.svg');
const svgBuffer = readFileSync(svgPath);

const sizes = [
  { name: 'mergen-logo-16.png', size: 16 },
  { name: 'mergen-logo-32.png', size: 32 },
  { name: 'mergen-logo-64.png', size: 64 },
  { name: 'mergen-logo-128.png', size: 128 },
  { name: 'mergen-logo-256.png', size: 256 },
  { name: 'mergen-logo-512.png', size: 512 },
  { name: 'mergen-logo-1024.png', size: 1024 }
];

console.log('🎨 Creating Mergen logo PNGs from SVG...\n');

for (const { name, size } of sizes) {
  const outputPath = join(__dirname, name);

  await sharp(svgBuffer)
    .resize(size, size)
    .png()
    .toFile(outputPath);

  console.log(`✓ ${name} (${size}×${size})`);
}

console.log('\n✨ All logo variants created successfully!');
console.log('\nFiles created:');
sizes.forEach(({ name }) => console.log(`  • ${name}`));
