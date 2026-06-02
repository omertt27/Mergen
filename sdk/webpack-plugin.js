/**
 * MergenWebpackPlugin — webpack / Next.js / CRA SHA injection.
 *
 * Injects <meta name="mergen:sha" content="<sha>"> into the built HTML
 * so the Mergen browser extension can automatically correlate browser errors
 * with CI failures and deployments without any manual setup.
 *
 * Usage (webpack.config.js):
 *   const { MergenWebpackPlugin } = require('mergen-server/sdk/webpack-plugin');
 *   module.exports = { plugins: [new MergenWebpackPlugin()] };
 *
 * Usage (next.config.js):
 *   const { withMergen } = require('mergen-server/sdk/webpack-plugin');
 *   module.exports = withMergen({ ... your next config ... });
 *
 * Usage (Create React App — via CRACO or react-app-rewired):
 *   const { MergenWebpackPlugin } = require('mergen-server/sdk/webpack-plugin');
 *   module.exports = { webpack: (config) => { config.plugins.push(new MergenWebpackPlugin()); return config; } };
 */

'use strict';

const { execSync } = require('child_process');

function resolveSha() {
  const fromEnv =
    process.env.MERGEN_SHA ??
    process.env.GITHUB_SHA ??
    process.env.CI_COMMIT_SHA ??
    process.env.GIT_COMMIT ??
    process.env.CIRCLE_SHA1;

  if (fromEnv) return fromEnv.slice(0, 40);

  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return '';
  }
}

class MergenWebpackPlugin {
  constructor(options = {}) {
    this.sha = options.sha ?? resolveSha();
  }

  apply(compiler) {
    if (!this.sha) {
      compiler.hooks.done.tap('MergenWebpackPlugin', () => {
        console.warn('[mergen] could not resolve SHA — set MERGEN_SHA env var');
      });
      return;
    }

    const sha = this.sha;

    // Hook into HtmlWebpackPlugin if present
    compiler.hooks.compilation.tap('MergenWebpackPlugin', (compilation) => {
      try {
        const HtmlWebpackPlugin = require('html-webpack-plugin');
        HtmlWebpackPlugin.getHooks(compilation).alterAssetTagGroups.tapAsync(
          'MergenWebpackPlugin',
          (data, cb) => {
            data.headTags.unshift({
              tagName: 'meta',
              voidTag: true,
              meta: { plugin: 'html-webpack-plugin' },
              attributes: { name: 'mergen:sha', content: sha },
            });
            cb(null, data);
          },
        );
      } catch {
        // HtmlWebpackPlugin not installed — inject via DefinePlugin pattern instead
        new compiler.webpack.DefinePlugin({
          '__MERGEN_SHA__': JSON.stringify(sha),
        }).apply(compiler);
      }
    });

    compiler.hooks.done.tap('MergenWebpackPlugin', () => {
      console.log(`[mergen] injected build SHA: ${sha.slice(0, 7)}`);
    });
  }
}

// Next.js wrapper — pass your existing next config and get SHA injection for free
function withMergen(nextConfig = {}) {
  const sha = resolveSha();
  return {
    ...nextConfig,
    env: {
      ...nextConfig.env,
      __MERGEN_SHA__: sha,
    },
    webpack(config, options) {
      config.plugins.push(new MergenWebpackPlugin({ sha }));
      if (typeof nextConfig.webpack === 'function') {
        return nextConfig.webpack(config, options);
      }
      return config;
    },
  };
}

module.exports = { MergenWebpackPlugin, withMergen, resolveSha };
