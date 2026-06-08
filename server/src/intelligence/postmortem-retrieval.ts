/**
 * postmortem-retrieval.ts — Hybrid semantic retrieval engine.
 *
 * Two independent retrieval signals combined via Reciprocal Rank Fusion (RRF):
 *
 *   1. SQLite FTS5 (BM25) — keyword matching with Porter stemming.
 *      Precise on exact terminology: service names, error codes, command names.
 *      Handles "connection pool exhausted" → matches "pool", "exhausted", etc.
 *
 *   2. TF-IDF cosine similarity — sparse "embedding" search.
 *      Handles semantic overlap even when exact terms differ.
 *      Corpus-aware: terms rare across all postmortems score higher.
 *      Upgradeable to neural embeddings by swapping computeEmbedding() below.
 *
 *   RRF formula: score(d) = Σ 1 / (k + rank_i(d)) for each result list i.
 *   k=60 is the standard constant (Cormack et al. 2009).
 *   RRF is robust to score-scale differences between retrieval methods — no
 *   normalization required, no tuning needed.
 *
 * This is the technical answer to "won't bigger context windows make you obsolete?"
 * We compress thousands of raw incident events into dense, high-signal summaries
 * before the model sees them. Token budget is fixed; retrieval quality determines
 * what fits in it.
 */

import { postmortemStore, type Postmortem } from './postmortem-store.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const RRF_K = 60;

// Common English stopwords that carry no diagnostic signal
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'up', 'about', 'into', 'through', 'during',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'it', 'its', 'this', 'that', 'these', 'those', 'which', 'who', 'what',
  'when', 'where', 'how', 'why', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only', 'same',
  'than', 'too', 'very', 'just', 'can', 'then', 'now', 'also', 'after',
  'before', 'if', 'while', 'because', 'as', 'until', 'since', 'so',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  postmortem: Postmortem;
  score: number;
  /** Which signals contributed: 'keyword', 'embedding', or 'both' */
  signals: ('keyword' | 'embedding')[];
  /** Cosine similarity from TF-IDF search (0–1) */
  embeddingSimilarity: number | null;
  /** BM25 rank position from FTS5 (0 = top) */
  keywordRank: number | null;
}

// ── Tokenization ──────────────────────────────────────────────────────────────

/**
 * Tokenize incident text into searchable terms.
 * Preserves technical tokens: underscores, digits, hyphenated identifiers.
 * "db_connection_pool_exhausted" → ["db", "connection", "pool", "exhausted"]
 * "OOMKilled" → ["oomkilled"] (lowercased, kept intact)
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Split on punctuation except underscores and hyphens (keep technical IDs intact)
    .replace(/[^\w\s_-]/g, ' ')
    // Split on underscores and hyphens (expand compound identifiers)
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// ── TF-IDF embedding ──────────────────────────────────────────────────────────

type TfIdfVector = Map<string, number>;

/**
 * Compute Inverse Document Frequency for the given corpus.
 * IDF(t) = log(N / df(t)) where N = corpus size, df = documents containing t.
 * Smoothed: IDF(t) = log(1 + N / (1 + df(t))) to avoid division by zero.
 */
function buildIdf(documents: string[][]): Map<string, number> {
  const N = documents.length;
  const df = new Map<string, number>();

  for (const tokens of documents) {
    const seen = new Set(tokens);
    for (const t of seen) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + N / (1 + count)));
  }
  return idf;
}

/**
 * Compute a TF-IDF vector for a document.
 * TF(t) = term count / total terms (normalized frequency).
 * Weight = TF(t) × IDF(t).
 */
function computeTfIdf(tokens: string[], idf: Map<string, number>): TfIdfVector {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  const vec: TfIdfVector = new Map();
  const total = tokens.length || 1;
  for (const [t, count] of tf) {
    const idfScore = idf.get(t) ?? Math.log(2); // fallback for unseen terms
    vec.set(t, (count / total) * idfScore);
  }
  return vec;
}

/**
 * Cosine similarity between two TF-IDF vectors.
 * Returns 0–1 (0 = no overlap, 1 = identical).
 */
function cosineSimilarity(a: TfIdfVector, b: TfIdfVector): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [t, wa] of a) {
    const wb = b.get(t) ?? 0;
    dot += wa * wb;
    normA += wa * wa;
  }
  for (const [, wb] of b) {
    normB += wb * wb;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * TF-IDF cosine similarity search over the full corpus.
 * Returns pids ranked by semantic similarity to the query.
 *
 * Upgradeable: swap this function for an Anthropic/OpenAI embedding call
 * (ANTHROPIC_API_KEY optional) to get neural embeddings while keeping the
 * same RRF pipeline. For incident-specific jargon, TF-IDF is often competitive.
 */
function embeddingSearch(
  query: string,
  postmortems: Postmortem[],
  topK: number,
): Array<{ pid: string; similarity: number; rank: number }> {
  if (postmortems.length === 0) return [];

  // Build corpus: combine all searchable fields per document
  const docTexts = postmortems.map((pm) =>
    [pm.tag, pm.service, pm.rootCause, pm.fixCommand ?? '', pm.body].join(' '),
  );
  const docTokens = docTexts.map(tokenize);
  const queryTokens = tokenize(query);

  if (queryTokens.length === 0) return [];

  // Build IDF from corpus + query (so query terms get proper IDF)
  const idf = buildIdf([...docTokens, queryTokens]);
  const queryVec = computeTfIdf(queryTokens, idf);

  // Score every document
  const scored = postmortems.map((pm, i) => ({
    pid: pm.pid,
    similarity: cosineSimilarity(queryVec, computeTfIdf(docTokens[i], idf)),
  }));

  return scored
    .filter((s) => s.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
    .map((s, rank) => ({ ...s, rank }));
}

// ── Reciprocal Rank Fusion ────────────────────────────────────────────────────

interface RankEntry { pid: string; rank: number }

/**
 * Reciprocal Rank Fusion: combine multiple ranked result lists into one.
 *
 *   score(d) = Σ_i  1 / (k + rank_i(d) + 1)
 *
 * Documents absent from a list receive no score for that list (not penalized).
 * k=60 constant (Cormack, Clarke, Buettcher — SIGIR 2009).
 */
function reciprocalRankFusion(lists: RankEntry[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (const { pid, rank } of list) {
      scores.set(pid, (scores.get(pid) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return scores;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface HybridSearchOptions {
  /** Tag filter — pre-filter corpus to a specific failure mode */
  tag?: string;
  /** Service filter — pre-filter corpus to a specific service */
  service?: string;
  /** Max results to return */
  topK?: number;
  /** Max postmortems to scan for embedding search (caps memory use) */
  maxCorpus?: number;
}

/**
 * Hybrid semantic search over the postmortem corpus.
 *
 * Stage 1: FTS5 BM25 keyword search (fast, precise on exact terms)
 * Stage 2: TF-IDF cosine similarity search (slower, semantically broader)
 * Stage 3: RRF fusion (combines both signals into a single ranking)
 *
 * The final ranking is better than either signal alone:
 * - A postmortem that ranks #1 in both lists will dominate
 * - A postmortem that only appears in one list still gets partial credit
 * - Neither method's score scale affects the other (RRF is scale-invariant)
 */
export function hybridSearch(query: string, opts: HybridSearchOptions = {}): SearchResult[] {
  const { tag, service, topK = 10, maxCorpus = 500 } = opts;

  if (!query.trim()) return [];

  // Load candidate corpus
  let corpus: Postmortem[];
  if (tag) {
    corpus = postmortemStore.getByTag(tag, maxCorpus);
  } else {
    corpus = postmortemStore.list(maxCorpus);
  }

  if (service) {
    corpus = corpus.filter((pm) => pm.service === service);
  }

  if (corpus.length === 0) return [];

  // ── Signal 1: FTS5 keyword ────────────────────────────────────────────────
  const keywordRanking = postmortemStore.keywordSearch(query, topK * 3);

  // If tag/service filter is active, keep only pids in the corpus
  const corpusPidSet = new Set(corpus.map((pm) => pm.pid));
  const filteredKeyword = keywordRanking.filter((r) => corpusPidSet.has(r.pid));

  // ── Signal 2: TF-IDF embedding ────────────────────────────────────────────
  const embeddingRanking = embeddingSearch(query, corpus, topK * 3);

  // ── Stage 3: RRF fusion ───────────────────────────────────────────────────
  const rrfScores = reciprocalRankFusion([filteredKeyword, embeddingRanking]);

  // Build pid → source metadata
  const keywordRankMap = new Map(filteredKeyword.map((r) => [r.pid, r.rank]));
  const embeddingMap   = new Map(embeddingRanking.map((r) => [r.pid, r]));

  // Merge results from both lists (union)
  const allPids = new Set([
    ...filteredKeyword.map((r) => r.pid),
    ...embeddingRanking.map((r) => r.pid),
  ]);

  const pmMap = new Map(corpus.map((pm) => [pm.pid, pm]));

  const results: SearchResult[] = [];
  for (const pid of allPids) {
    const pm = pmMap.get(pid);
    if (!pm) continue;

    const score = rrfScores.get(pid) ?? 0;
    const inKeyword  = keywordRankMap.has(pid);
    const inEmbedding = embeddingMap.has(pid);

    results.push({
      postmortem: pm,
      score,
      signals: [
        ...(inKeyword   ? ['keyword'   as const] : []),
        ...(inEmbedding ? ['embedding' as const] : []),
      ],
      embeddingSimilarity: embeddingMap.get(pid)?.similarity ?? null,
      keywordRank: keywordRankMap.get(pid) ?? null,
    });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Expand a tag slug into a natural language query for embedding search.
 * "infra_db_connection_pool_exhausted" → "database connection pool exhausted timeout"
 */
export function tagToQuery(tag: string): string {
  const expansions: Record<string, string> = {
    db_connection_pool_exhausted: 'database connection pool exhausted timeout max connections',
    oom_kill: 'out of memory OOM kill process killed memory pressure container',
    memory_pressure: 'memory pressure high usage RSS heap limit',
    rate_limit_cascade: 'rate limit 429 throttle cascade downstream retry storm',
    slow_query: 'slow query timeout database latency lock wait',
    downstream_latency_spike: 'downstream dependency latency spike timeout 503',
    certificate_expiry: 'certificate expiry TLS SSL expired renewal',
    disk_pressure: 'disk full pressure inode storage volume mount',
    queue_backlog: 'queue backlog lag consumer worker stuck processing',
    service_unavailable: 'service unavailable 503 health check crash restart',
  };

  const clean = tag.replace(/^infra_/, '');
  return expansions[clean] ?? clean.replace(/_/g, ' ');
}
