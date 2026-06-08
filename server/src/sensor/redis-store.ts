/**
 * redis-store.ts — Opt-in Redis persistence for the event ring buffer.
 *
 * Activation: set MERGEN_REDIS_URL=redis://localhost:6379
 * Requires:   npm install ioredis  (optional peer dependency — not bundled)
 *
 * Architecture: write-through + rehydrate-on-startup.
 *   - All reads still use the in-memory ring buffer (low-latency).
 *   - Every push() is mirrored to Redis (ZADD with timestamp as score).
 *   - On server restart, rehydrateFromRedis() fetches the last N events
 *     from the sorted set and loads them into the in-memory buffer.
 *   - Buffer clears are mirrored via DEL.
 *
 * This gives you event survival across restarts (the FAANG concern about
 * losing a 30-minute incident context on a crash) without rewriting the
 * 60+ read methods on BufferStore.
 *
 * Redis key: mergen:events  (sorted set, score = event.timestamp)
 * Max stored: 50,000 events (ZREMRANGEBYRANK trims oldest on every push)
 */

import net from 'net';
import logger from './logger.js';
import type { BrowserEvent, BufferStore } from './buffer.js';

const REDIS_KEY  = 'mergen:events';
const MAX_STORED = 50_000;

// ── Minimal RESP2 client ──────────────────────────────────────────────────────
// Avoids a runtime dependency: uses Node's built-in net.Socket to speak the
// Redis Serialization Protocol (RESP2). Only the four commands we need:
//   ZADD key score member
//   ZRANGEBYSCORE key min max LIMIT offset count
//   ZREMRANGEBYRANK key 0 stop
//   DEL key

interface RespClient {
  zadd(key: string, score: number, member: string): Promise<void>;
  zrangebyscore(key: string, min: string, max: string, limit?: number): Promise<string[]>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<void>;
  del(key: string): Promise<void>;
  quit(): void;
}

function parseRedisUrl(url: string): { host: string; port: number; password?: string; db: number } {
  const u = new URL(url);
  return {
    host:     u.hostname || '127.0.0.1',
    port:     parseInt(u.port || '6379', 10),
    password: u.password || undefined,
    db:       parseInt(u.pathname.slice(1) || '0', 10) || 0,
  };
}

function buildRespCommand(args: (string | number)[]): Buffer {
  const lines: string[] = [`*${args.length}\r\n`];
  for (const arg of args) {
    const s = String(arg);
    lines.push(`$${Buffer.byteLength(s, 'utf8')}\r\n${s}\r\n`);
  }
  return Buffer.from(lines.join(''), 'utf8');
}

async function createRespClient(url: string): Promise<RespClient> {
  const { host, port, password, db } = parseRedisUrl(url);
  const socket = new net.Socket();
  let buf = '';
  const pending: Array<(lines: string[]) => void> = [];

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.connect(port, host, () => resolve());
  });

  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    // Simple RESP response parser — reads one reply per pending command
    while (pending.length > 0) {
      const nl = buf.indexOf('\r\n');
      if (nl === -1) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const resolve = pending.shift()!;
      if (line[0] === '+' || line[0] === ':' || line[0] === '-') {
        resolve([line.slice(1)]);
      } else if (line[0] === '$') {
        const len = parseInt(line.slice(1), 10);
        if (len === -1) { resolve(['']); continue; }
        const end = len + 2;
        if (buf.length < end) { buf = line + '\r\n' + buf; pending.unshift(resolve); break; }
        resolve([buf.slice(0, len)]);
        buf = buf.slice(end);
      } else if (line[0] === '*') {
        const count = parseInt(line.slice(1), 10);
        if (count <= 0) { resolve([]); continue; }
        // Collect bulk strings synchronously from buffered data
        const items: string[] = [];
        let ok = true;
        for (let i = 0; i < count; i++) {
          const lnl = buf.indexOf('\r\n');
          if (lnl === -1) { ok = false; break; }
          const lline = buf.slice(0, lnl);
          buf = buf.slice(lnl + 2);
          if (lline[0] === '$') {
            const llen = parseInt(lline.slice(1), 10);
            if (llen === -1) { items.push(''); continue; }
            const lend = llen + 2;
            if (buf.length < lend) { ok = false; break; }
            items.push(buf.slice(0, llen));
            buf = buf.slice(lend);
          }
        }
        if (!ok) { buf = line + '\r\n' + buf; pending.unshift(resolve); break; }
        resolve(items);
      }
    }
  });

  function send(args: (string | number)[]): Promise<string[]> {
    return new Promise((resolve) => {
      pending.push(resolve);
      socket.write(buildRespCommand(args));
    });
  }

  if (password) await send(['AUTH', password]);
  if (db !== 0) await send(['SELECT', db]);

  return {
    async zadd(key, score, member) { await send(['ZADD', key, score, member]); },
    async zrangebyscore(key, min, max, limit) {
      if (limit !== undefined) return send(['ZRANGEBYSCORE', key, min, max, 'LIMIT', 0, limit]);
      return send(['ZRANGEBYSCORE', key, min, max]);
    },
    async zremrangebyrank(key, start, stop) { await send(['ZREMRANGEBYRANK', key, start, stop]); },
    async del(key) { await send(['DEL', key]); },
    quit() { socket.destroy(); },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

let _client: RespClient | null = null;

/**
 * Wrap a BufferStore with Redis write-through persistence.
 * Returns the original store if MERGEN_REDIS_URL is not set.
 * On success, also rehydrates the store from Redis before returning.
 */
export async function wrapWithRedisPersistence(store: BufferStore): Promise<BufferStore> {
  const redisUrl = process.env.MERGEN_REDIS_URL;
  if (!redisUrl) return store;

  try {
    _client = await createRespClient(redisUrl);
    logger.info({ url: redisUrl.replace(/:\/\/.*@/, '://***@') }, 'redis-store: connected');
  } catch (err) {
    logger.warn({ err }, 'redis-store: could not connect — falling back to in-memory only');
    return store;
  }

  // Rehydrate from Redis before wrapping
  try {
    const raw = await _client.zrangebyscore(REDIS_KEY, '-inf', '+inf', MAX_STORED);
    if (raw.length > 0) {
      const events: BrowserEvent[] = [];
      for (const item of raw) {
        try { events.push(JSON.parse(item) as BrowserEvent); } catch { /* skip corrupt entries */ }
      }
      if (events.length > 0) {
        store.rehydrate(events);
        logger.info({ count: events.length }, 'redis-store: rehydrated from Redis');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'redis-store: rehydration failed — continuing without restore');
  }

  const client = _client;

  // Return a proxy that writes through to Redis on push() and clear()
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'push') {
        return (event: BrowserEvent, tenantId?: string) => {
          target.push(event, tenantId);
          // Fire-and-forget: don't block the hot path
          const score = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
          void client.zadd(REDIS_KEY, score, JSON.stringify(event)).then(() =>
            client.zremrangebyrank(REDIS_KEY, 0, -(MAX_STORED + 1)),
          ).catch((err: unknown) => {
            logger.debug({ err }, 'redis-store: write failed');
          });
        };
      }
      if (prop === 'clear') {
        return (tenantId?: string) => {
          target.clear(tenantId);
          if (!tenantId) {
            void client.del(REDIS_KEY).catch((err: unknown) => {
              logger.debug({ err }, 'redis-store: clear failed');
            });
          }
        };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  });
}

export function stopRedisStore(): void {
  if (_client) { _client.quit(); _client = null; }
}
