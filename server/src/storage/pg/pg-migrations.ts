/**
 * pg-migrations.ts — Lightweight SQL migration runner.
 *
 * Reads .sql files from ./migrations/, applies them in lexicographic order,
 * and records each applied migration in the _migrations table. Idempotent:
 * already-applied files are skipped.
 *
 * No external migration library dependency — the postgres tagged-template
 * client is sufficient.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSql } from './pg-client.js';

export async function runMigrations(): Promise<void> {
  const sql = getSql();

  // Ensure migrations table exists before first use
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const applied = await sql`SELECT 1 FROM _migrations WHERE name = ${file}`;
    if (applied.length > 0) continue;

    const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await sql.unsafe(content);
    await sql`INSERT INTO _migrations (name) VALUES (${file})`;
  }
}
