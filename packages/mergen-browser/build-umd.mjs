import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

async function build() {
  try {
    // Ensure dist directory exists
    if (!fs.existsSync('dist')) {
      fs.mkdirSync('dist');
    }

    console.log('Building browser UMD bundle...');
    const result = await esbuild.build({
      entryPoints: ['src/index.ts'],
      outfile: 'dist/mergen-browser.umd.js',
      bundle: true,
      minify: true,
      format: 'iife',
      globalName: 'Mergen',
      write: false,
      sourcemap: true,
      target: ['es2020'],
    });

    const jsFile = result.outputFiles.find(f => f.path.endsWith('.js'));
    const mapFile = result.outputFiles.find(f => f.path.endsWith('.map'));

    if (jsFile) {
      // Wrap code in a true UMD block
      const umdCode = `(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Mergen = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  var exports = {};
  ${jsFile.text}
  return typeof Mergen !== 'undefined' ? Mergen : exports;
}));`;

      fs.writeFileSync('dist/mergen-browser.umd.js', umdCode);
      console.log('✓ Created dist/mergen-browser.umd.js');
    }

    if (mapFile) {
      fs.writeFileSync('dist/mergen-browser.umd.js.map', mapFile.text);
      console.log('✓ Created dist/mergen-browser.umd.js.map');
    }

    console.log('Building CommonJS bundle...');
    await esbuild.build({
      entryPoints: ['src/index.ts'],
      outfile: 'dist/index.cjs',
      bundle: true,
      format: 'cjs',
      sourcemap: true,
      target: ['es2020'],
    });
    console.log('✓ Created dist/index.cjs');

  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

build();
