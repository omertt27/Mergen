import esbuild from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs';

async function main() {
  try {
    console.log('Running tsc for CommonJS and declaration files...');
    execSync('npx tsc', { stdio: 'inherit' });

    console.log('Running esbuild to generate ESM (.mjs) bundles...');
    const entryPoints = [
      'src/index.ts',
      'src/middleware/express.ts',
      'src/middleware/nextjs.ts'
    ];

    for (const entry of entryPoints) {
      const outfile = entry.replace('src/', 'dist/').replace('.ts', '.mjs');
      console.log(`Building ESM for ${entry} -> ${outfile}...`);
      await esbuild.build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node18',
        external: ['express', 'next', 'http', 'https', 'crypto', 'path'],
        sourcemap: true,
      });
    }

    console.log('Build completed successfully!');
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

main();
