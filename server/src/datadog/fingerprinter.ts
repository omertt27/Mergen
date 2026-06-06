import crypto from 'crypto';
import type { RuntimeFact } from './compactor.js';

export interface FingerprintInput {
  errorType?: string;
  service: string;
  endpoint: string;
  dbTable?: string;
  errorMessage?: string;
}

// Normalize a REST endpoint to a stable pattern
// "POST /checkout/charge" → "post:/checkout/charge"
// "/api/users/123/orders" → "/api/users/{id}/orders"
function normalizeEndpoint(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\/\d+/g, '/{id}')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{23,35}/g, '/{uuid}')
    .replace(/[^a-z0-9:/_{}]/g, '');
}

// Extract the leading word of an error message as a stable "class"
// "deadlock detected at db_session.go:114" → "deadlock"
// "connection refused (localhost:6379)" → "connection"
function errorClass(msg: string): string {
  return msg.trim().split(/[\s:,.(]/)[0].toLowerCase().slice(0, 24);
}

// Extract table name from a SQL statement
// "UPDATE balances SET balance = ..." → "balances"
// "SELECT * FROM orders WHERE ..." → "orders"
function extractTable(stmt: string): string {
  const m = stmt.match(/(?:FROM|INTO|UPDATE|JOIN)\s+["'`]?(\w+)["'`]?/i);
  return m ? m[1].toLowerCase() : '';
}

export function computeFingerprint(input: FingerprintInput): string {
  const et = (input.errorType ?? '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  const svc = input.service.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const ep = normalizeEndpoint(input.endpoint);
  const tbl = (input.dbTable ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  const ec = input.errorMessage ? errorClass(input.errorMessage) : '';

  const key = [et, svc, ep, tbl, ec].join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function fingerprintFromFact(fact: RuntimeFact): string {
  // Extract db table from error message or endpoint context
  const dbTable = extractTable(fact.errorMessage);

  return computeFingerprint({
    errorType: fact.errorMessage.split(':')[0],
    service: fact.service,
    endpoint: fact.endpoint,
    dbTable,
    errorMessage: fact.errorMessage,
  });
}
