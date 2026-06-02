/**
 * mergenPlugin() — Vite plugin for automatic build SHA injection.
 *
 * Injects <meta name="mergen:sha" content="<sha>"> into the built HTML so
 * the Mergen browser extension automatically links every browser error to the
 * exact CI run and deployment that shipped it.
 *
 * Usage (vite.config.ts):
 *   import { mergenPlugin } from 'mergen-server/sdk/vite-plugin';
 *   export default defineConfig({ plugins: [mergenPlugin()] });
 *
 * SHA resolution order:
 *   1. MERGEN_SHA env var (explicit override)
 *   2. GITHUB_SHA / CI_COMMIT_SHA / GIT_COMMIT (CI environment variables)
 *   3. git rev-parse HEAD (local dev — always works in a git repo)
 */

import { execSync } from 'child_process';
import type { Plugin, IndexHtmlTransformResult } from 'vite';

function resolveSha(): string {
  const fromEnv =
    process.env.MERGEN_SHA ??
    process.env.GITHUB_SHA ??
    process.env.CI_COMMIT_SHA ??  // GitLab
    process.env.GIT_COMMIT ??      // Jenkins
    process.env.CIRCLE_SHA1;       // CircleCI

  if (fromEnv) return fromEnv.slice(0, 40);

  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return '';
  }
}

export function mergenPlugin(): Plugin {
  const sha = resolveSha();

  return {
    name: 'mergen-vite',

    transformIndexHtml(html): IndexHtmlTransformResult {
      if (!sha) return html;
      return [{ tag: 'meta', attrs: { name: 'mergen:sha', content: sha }, injectTo: 'head-prepend' }];
    },

    configResolved() {
      if (sha) {
        console.log(`[mergen] injecting build SHA: ${sha.slice(0, 7)}`);
      } else {
        console.warn('[mergen] could not resolve SHA — set MERGEN_SHA env var or run in a git repo');
      }
    },
  };
}
