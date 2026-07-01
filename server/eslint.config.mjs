// @ts-check
/**
 * eslint.config.mjs — flat config for the Mergen server.
 *
 * Focus: catch a small set of high-value, security-relevant defects rather than
 * enforce a full style guide (Prettier/formatting is intentionally out of scope).
 *
 * The headline rule is `@typescript-eslint/no-floating-promises`. This codebase
 * fires several webhooks/notifications as fire-and-forget (`void fireHitlWebhook(...)`
 * in the gate path); the rule guarantees every such promise is *deliberately*
 * voided or awaited, so a dropped `.catch` can't silently swallow a HITL webhook
 * failure and leave a held tool call hanging.
 *
 * Type-aware rules require the TS program. Some `intelligence/*` modules are
 * closed-source and absent in CI; when their imports resolve to `any` the
 * type-aware rules simply lose fidelity on those lines — they do not crash — so
 * this config runs both locally (full fidelity) and in CI (reduced fidelity).
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Never lint build output, stubs, or the test tree (tests intentionally
    // use loose typing, non-null assertions, and un-awaited fire-and-forget).
    ignores: ['dist/**', 'src/__stubs__/**', 'src/**/*.test.ts', 'scripts/**', 'sdk/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Headline: no dropped promises ─────────────────────────────────────
      '@typescript-eslint/no-floating-promises': 'error',

      // ── Keep, but don't let style noise block CI ──────────────────────────
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // ── Downgraded: real signal, but too pervasive to gate on today. ──────
      // The codebase leans on `any` at closed-source boundaries and dynamic
      // payloads; make these advisory so the gate stays focused on correctness.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
    },
  },
);
