/**
 * pg-client.ts — Singleton postgres connection pool (porsager/postgres).
 *
 * getSql() is safe to call multiple times — returns the same sql instance.
 * closeSql() is called in the SIGTERM handler to drain the pool gracefully.
 */

import postgres from 'postgres';

let _sql: ReturnType<typeof postgres> | null = null;

export function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    const url = process.env.MERGEN_PG_URL;
    if (!url) throw new Error('MERGEN_PG_URL is not set');
    _sql = postgres(url, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
    });
  }
  return _sql;
}

export async function closeSql(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}
