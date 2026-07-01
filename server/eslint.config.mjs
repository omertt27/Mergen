// @ts-check
/**
 * eslint.config.mjs — flat config for the Mergen server.
 *
 * Focus: catch a small set of high-value correctness defects (unused symbols,
 * unreachable code, accidental fall-through, `==` vs `===`) rather than enforce
 * a full style guide. Formatting is intentionally out of scope.
 *
 * NOTE on type-aware rules: the headline rule we want is
 * `@typescript-eslint/no-floating-promises` (this codebase fires several
 * fire-and-forget webhooks in the gate path, e.g. `void fireHitlWebhook(...)`).
 * That rule requires typescript-eslint's *type-aware* program, which currently
 * hard-crashes the linter under the repo's Node 24 + TypeScript 5.3.3 combo
 * (native crash during TS program construction, not a JS stack overflow —
 * `--stack-size` does not help). To keep `npm run lint` and the CI lint gate
 * reliable, this config runs the non-type-aware ruleset only. Re-enabling the
 * type-checked rules is tracked as a follow-up gated on a TypeScript upgrade;
 * see the plan file. Until then, floating promises are guarded by convention
 * (explicit `void`) and code review.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Never lint build output, closed-source stubs, generated SDK, build
    // scripts, or the test tree (tests intentionally use loose typing and
    // fire-and-forget calls).
    ignores: ['dist/**', 'src/__stubs__/**', 'src/**/*.test.ts', 'scripts/**', 'sdk/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Unused symbols are real dead-code / typo signal; allow underscore-
      // prefixed args and vars as the deliberate "intentionally unused" marker.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // `any` is used deliberately at closed-source boundaries and for dynamic
      // MCP/JSON payloads — too pervasive to gate on, and not a correctness bug.
      '@typescript-eslint/no-explicit-any': 'off',

      // These are advisory: useful signal, but the codebase has pre-existing
      // instances that shouldn't block the gate today. Kept as warnings so new
      // occurrences are visible in review without failing CI on legacy code.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // require() is used for a few deliberate lazy loads; ANSI-escape stripping
      // legitimately needs control chars in a regex; both are pre-existing.
      '@typescript-eslint/no-require-imports': 'warn',
      'no-control-regex': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'prefer-const': 'warn',
      // Auto-fixable and low-risk, but several live inside security-matching
      // regexes — downgraded rather than blindly --fix'd. Fix by hand over time.
      'no-useless-escape': 'warn',

      // Correctness rules worth FAILING on — these catch real regressions and
      // the codebase is already clean against them:
      'eqeqeq': ['error', 'smart'],
      'no-fallthrough': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
);
