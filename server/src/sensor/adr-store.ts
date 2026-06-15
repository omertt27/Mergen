/**
 * adr-store.ts — In-memory store for Architectural Decision Records.
 *
 * Seeded with the project's initial ADRs. Additional ADRs can be appended
 * at runtime (stored in ~/.mergen/adrs.json) so teams that run Mergen as
 * shared infra can accumulate their own decision log without touching the
 * source tree.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR, zeroRetentionMode } from './paths.js';
import logger from './logger.js';

export type AdrStatus = 'proposed' | 'accepted' | 'deprecated' | 'superseded';

export interface AdrRecord {
  id: string;
  title: string;
  status: AdrStatus;
  date: string;
  decision: string;
  alternatives: string[];
  rationale: string;
  consequences: string;
}

const ADR_FILE = path.join(DATA_DIR, 'adrs.json');

const SEED_ADRS: AdrRecord[] = [
  {
    id: 'ADR-001',
    title: 'Ring buffer as primary event store',
    status: 'accepted',
    date: '2024-01-15',
    decision: 'Use a fixed-capacity (2 000-event) in-memory ring buffer as the primary store for inbound telemetry events, with O(1) eviction of the oldest event when the cap is reached.',
    alternatives: [
      'Unlimited in-memory list — rejected: unbounded memory growth would cause OOM crashes',
      'Write-through to SQLite on every event — rejected: synchronous disk I/O bottlenecks throughput during incident spikes',
      'Redis as primary store — rejected: adds an external dependency that breaks the zero-infrastructure install story',
    ],
    rationale: 'Incident triage tools need the most recent events, not a complete historical ledger. A ring buffer keeps the hot path allocation-free, provides constant-time reads and writes, and caps memory at a predictable ceiling.',
    consequences: 'Reading more than 2 000 events requires querying the SQLite history store. The cap is tunable via MERGEN_BUFFER_SIZE env var.',
  },
  {
    id: 'ADR-002',
    title: 'MCP protocol over custom REST for AI IDE integration',
    status: 'accepted',
    date: '2024-02-01',
    decision: 'Expose Mergen\'s analysis and triage capabilities as Model Context Protocol (MCP) tools over stdio transport, rather than a proprietary REST API.',
    alternatives: [
      'Custom REST API with IDE plugins — rejected: every IDE needs a bespoke plugin; integration surface multiplies with each new IDE',
      'Language Server Protocol (LSP) — rejected: LSP is designed for code intelligence, not arbitrary tool invocation',
      'OpenAI function-calling format — rejected: not IDE-agnostic; couples Mergen to a single model vendor',
    ],
    rationale: 'MCP is the emerging standard for AI tool exposure. A single MCP server declaration in a project config file immediately surfaces all Mergen tools in every compatible IDE.',
    consequences: 'The HTTP server (:3000) and MCP server (stdio) are separate processes sharing state via the in-memory buffer. MCP version upgrades may require updating tool registration patterns.',
  },
  {
    id: 'ADR-003',
    title: 'SQLite for persistent event history',
    status: 'accepted',
    date: '2024-02-15',
    decision: 'Use SQLite (via sql.js) for the 1-hour persistent event history layer, rather than a networked database or plain JSON files.',
    alternatives: [
      'Plain JSON files — rejected: not atomic; crash mid-write corrupts the file; range queries require full deserialisation',
      'PostgreSQL / MySQL — rejected: requires a running database server, breaking the zero-infrastructure install story',
      'Redis — rejected: persistence config complexity; not enabled by default',
      'LevelDB / RocksDB — rejected: native bindings fail on ARM Macs and Alpine Linux',
    ],
    rationale: 'sql.js compiles SQLite to WebAssembly — zero native bindings, consistent binary on every platform. SQLite provides ACID guarantees and efficient timestamp range scans.',
    consequences: 'The sql.js WASM binary adds ~1.2 MB to the installed package. Write throughput is single-threaded. Schema migrations must be handled manually in sqlite-store.ts.',
  },
  {
    id: 'ADR-004',
    title: 'Ingest server binds to 127.0.0.1 by default',
    status: 'accepted',
    date: '2024-03-01',
    decision: 'The Express HTTP server listens on 127.0.0.1:3000 (loopback) by default, not 0.0.0.0.',
    alternatives: [
      'Bind to 0.0.0.0 by default — rejected: any process on the local network could read the event buffer or trigger autonomous fix execution',
      'Bind to 0.0.0.0 with mandatory API key — rejected: key management burden defeats the zero-config local install goal',
      'Unix domain socket — rejected: not supported on Windows',
    ],
    rationale: 'Developer tools should be safe by default. Loopback binding limits the attack surface to processes already on the same machine. Teams needing network access can set MERGEN_HOST=0.0.0.0.',
    consequences: 'Browser extensions and SDKs must use 127.0.0.1, not localhost. Docker deployments require --network=host or explicit port mapping. Cloud mode overrides this to 0.0.0.0 with TLS.',
  },
  {
    id: 'ADR-005',
    title: 'Three-tier tool access model (free / pro / all)',
    status: 'accepted',
    date: '2024-04-01',
    decision: 'Classify every MCP tool into free, pro, or all tiers enforced via withTierGate(). The canonical tier for each tool is declared in tool-manifest.ts.',
    alternatives: [
      'Binary free / paid split — rejected: too coarse; some read-only tools are safe to offer free while execution tools carry risk',
      'Per-tool pricing — rejected: metering complexity and unpredictable bills',
      'No gating at all — rejected: unrestricted execution tools represent liability without a paid support contract',
    ],
    rationale: 'Three tiers maps onto what engineers actually need: free for read-only analysis, pro for execution and third-party API integration, all for tools with no restriction.',
    consequences: 'New tools must be added to tool-manifest.ts with a tier before registration. The manifest consistency test will fail otherwise. withTierGate() returns an upgrade prompt rather than a 403.',
  },
];

class AdrStore {
  private records = new Map<string, AdrRecord>();

  constructor() {
    for (const adr of SEED_ADRS) {
      this.records.set(adr.id, adr);
    }
    this._loadFromDisk();
  }

  private _loadFromDisk(): void {
    try {
      if (!fs.existsSync(ADR_FILE)) return;
      const raw = fs.readFileSync(ADR_FILE, 'utf8');
      const extra = JSON.parse(raw) as AdrRecord[];
      for (const adr of extra) {
        if (adr.id && !this.records.has(adr.id)) {
          this.records.set(adr.id, adr);
        }
      }
    } catch {
      // Non-fatal: seed ADRs are always available
    }
  }

  private _saveToDisk(): void {
    if (zeroRetentionMode()) return;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const userAdrs = [...this.records.values()].filter(
        (r) => !SEED_ADRS.some((s) => s.id === r.id),
      );
      fs.writeFileSync(ADR_FILE, JSON.stringify(userAdrs, null, 2), 'utf8');
    } catch (err) {
      logger.warn({ err }, 'adr-store: failed to persist to disk');
    }
  }

  list(query?: string): AdrRecord[] {
    const all = [...this.records.values()];
    if (!query) return all;
    const q = query.toLowerCase();
    return all.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q) ||
        r.decision.toLowerCase().includes(q) ||
        r.rationale.toLowerCase().includes(q) ||
        r.alternatives.some((a) => a.toLowerCase().includes(q)),
    );
  }

  get(id: string): AdrRecord | undefined {
    return this.records.get(id.toUpperCase());
  }

  add(record: Omit<AdrRecord, 'id'>): AdrRecord {
    const nextNum = this.records.size + 1;
    const id = `ADR-${String(nextNum).padStart(3, '0')}`;
    const adr: AdrRecord = { id, ...record };
    this.records.set(id, adr);
    this._saveToDisk();
    logger.info({ id }, 'adr-store: new ADR recorded');
    return adr;
  }
}

export const adrStore = new AdrStore();
