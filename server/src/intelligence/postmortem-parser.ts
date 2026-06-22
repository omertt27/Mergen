import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { createHash } from 'crypto';
import { adrStore, type AdrRecord, type AdrStatus } from '../sensor/adr-store.js';
import { postmortemStore, type Postmortem } from './postmortem-store.js';
import logger from '../sensor/logger.js';

/** Parse MTTR string (e.g. "12m 30s", "120s", "unknown") to milliseconds */
function parseMttrToMs(text: string): number | null {
  if (!text || text === 'unknown') return null;
  const minMatch = text.match(/(\d+)m/i);
  const secMatch = text.match(/(\d+)s/i);
  let ms = 0;
  if (minMatch) ms += parseInt(minMatch[1], 10) * 60_000;
  if (secMatch) ms += parseInt(secMatch[1], 10) * 1000;
  if (ms > 0) return ms;
  
  const num = parseInt(text, 10);
  if (!isNaN(num)) return num * 1000;
  return null;
}

/** Generate a deterministic UUID from input string to avoid duplicate records */
function deterministicUUID(input: string): string {
  const hash = createHash('md5').update(input).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Parses ADR markdown file into AdrRecord */
export function parseAdrMarkdown(content: string): AdrRecord | null {
  const titleMatch = content.match(/^#\s*(ADR-\d+):\s*(.*)/mi);
  if (!titleMatch) return null;
  const id = titleMatch[1].toUpperCase();
  const title = titleMatch[2].trim();

  const dateMatch = content.match(/\*\*Date:\*\*\s*(.*)/i);
  const date = dateMatch ? dateMatch[1].trim() : new Date().toISOString().slice(0, 10);

  const statusMatch = content.match(/\*\*Status:\*\*\s*(.*)/i);
  let status: AdrStatus = 'proposed';
  if (statusMatch) {
    const s = statusMatch[1].trim().toLowerCase();
    if (s === 'accepted' || s === 'deprecated' || s === 'superseded' || s === 'proposed') {
      status = s as AdrStatus;
    }
  }

  const extractSection = (headerName: string): string => {
    const regex = new RegExp(`##\\s*${headerName}[\\s\\S]*?(?=##|$)`, 'i');
    const match = content.match(regex);
    if (!match) return '';
    return match[0].replace(new RegExp(`^##\\s*${headerName}`, 'i'), '').trim();
  };

  const decision = extractSection('Decision');
  const rationale = extractSection('Rationale');
  const consequences = extractSection('Consequences');
  
  const alternativesRaw = extractSection('Alternatives(?: considered)?');
  const alternatives: string[] = [];
  if (alternativesRaw) {
    const items = alternativesRaw.match(/^\s*-\s*(.*)/gm);
    if (items) {
      for (const item of items) {
        alternatives.push(item.replace(/^\s*-\s*/, '').trim());
      }
    } else {
      alternatives.push(alternativesRaw);
    }
  }

  return {
    id,
    title,
    status,
    date,
    decision,
    alternatives,
    rationale,
    consequences,
  };
}

/** Parses Postmortem markdown file into Postmortem record */
export function parsePostmortemMarkdown(filename: string, content: string): Postmortem | null {
  // Pattern matches header e.g. # Postmortem — db_connection_pool
  const tagMatch = content.match(/^#\s*Postmortem\s*—\s*(.*)/mi);
  if (!tagMatch) return null;
  let tag = tagMatch[1].trim();
  if (!tag.startsWith('infra_')) {
    tag = `infra_${tag}`;
  }

  const serviceMatch = content.match(/\*\*Service:\*\*\s*([^\s|]+)/i);
  const service = serviceMatch ? serviceMatch[1].trim() : 'unknown';

  const dateMatch = content.match(/\*\*Date:\*\*\s*([^\s|]+)/i);
  const dateStr = dateMatch ? dateMatch[1].trim() : '';
  const generatedAt = dateStr ? new Date(dateStr).getTime() : Date.now();

  const confidenceMatch = content.match(/\*\*Confidence:\*\*\s*(\d+)%/i);
  const confidence = confidenceMatch ? parseInt(confidenceMatch[1], 10) / 100 : 0.85;

  const mttrMatch = content.match(/\*\*MTTR:\*\*\s*([^|]+)/i);
  const mttrMs = mttrMatch ? parseMttrToMs(mttrMatch[1].trim()) : null;

  const resolutionMatch = content.match(/\*\*Resolution:\*\*\s*(.*)/i);
  const resolvedAutonomously = resolutionMatch
    ? /autonomous|mergen/i.test(resolutionMatch[1])
    : false;

  const branchMatch = content.match(/\*\*Branch:\*\*\s*([^\s|]+)/i);
  const gitBranch = branchMatch ? branchMatch[1].trim() : null;

  const shaMatch = content.match(/\*\*SHA:\*\*\s*([^\s|]+)/i);
  const gitSha = shaMatch ? shaMatch[1].trim() : null;

  const extractSection = (headerName: string): string => {
    const regex = new RegExp(`##\\s*${headerName}[\\s\\S]*?(?=##|$)`, 'i');
    const match = content.match(regex);
    if (!match) return '';
    return match[0].replace(new RegExp(`^##\\s*${headerName}`, 'i'), '').trim();
  };

  const rootCause = extractSection('Root Cause') || 'Unknown root cause';
  const fixAppliedRaw = extractSection('Fix Applied');
  let fixCommand: string | null = null;
  if (fixAppliedRaw) {
    const codeFenceMatch = fixAppliedRaw.match(/```(?:[a-zA-Z]*)\n([\s\S]*?)\n```/);
    fixCommand = codeFenceMatch ? codeFenceMatch[1].trim() : fixAppliedRaw.trim();
  }

  const pid = deterministicUUID(path.basename(filename));

  return {
    pid,
    tag,
    service,
    gitSha,
    gitBranch,
    rootCause,
    fixCommand,
    confidence,
    mttrMs,
    resolvedAutonomously,
    causallyCorrect: true, // imported postmortem was verified correct
    generatedAt,
    body: content,
  };
}

export function findRepoRoot(startPath = process.cwd()): string {
  let curr = startPath;
  while (curr && curr !== path.parse(curr).root) {
    if (fs.existsSync(path.join(curr, '.git')) || fs.existsSync(path.join(curr, 'docs/adr'))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return startPath;
}

/** Scans and syncs ADRs and postmortems from git workspace directory into local SQLite/JSON stores */
export async function syncMarkdownFilesFromDisk(startPath = process.cwd()): Promise<{ adrsSynced: number; postmortemsSynced: number }> {
  let adrsSynced = 0;
  let postmortemsSynced = 0;

  const repoRoot = findRepoRoot(startPath);

  try {
    // 1. Sync ADRs from docs/adr/ADR-*.md
    const adrPattern = path.join(repoRoot, 'docs/adr/ADR-*.md').replace(/\\/g, '/');
    const adrFiles = await fg(adrPattern);
    for (const file of adrFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const adr = parseAdrMarkdown(content);
        if (adr) {
          adrStore.upsert(adr);
          adrsSynced++;
        }
      } catch (err) {
        logger.warn({ file, err }, 'postmortem-parser: failed to sync ADR file');
      }
    }

    // 2. Sync Postmortems from docs/postmortems/*.md
    const postmortemDir = path.join(repoRoot, 'docs/postmortems');
    if (fs.existsSync(postmortemDir)) {
      const pmPattern = path.join(postmortemDir, '*.md').replace(/\\/g, '/');
      const pmFiles = await fg(pmPattern);
      for (const file of pmFiles) {
        try {
          const content = fs.readFileSync(file, 'utf8');
          const pm = parsePostmortemMarkdown(file, content);
          if (pm) {
            postmortemStore.write(pm);
            postmortemsSynced++;
          }
        } catch (err) {
          logger.warn({ file, err }, 'postmortem-parser: failed to sync postmortem file');
        }
      }
    }

    logger.info({ adrsSynced, postmortemsSynced, repoRoot }, 'postmortem-parser: sync completed');
  } catch (err) {
    logger.warn({ err }, 'postmortem-parser: markdown files sync failed');
  }

  return { adrsSynced, postmortemsSynced };
}
