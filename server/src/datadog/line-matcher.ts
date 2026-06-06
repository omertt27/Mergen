import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const CONTEXT_LINES = 15;

function findLocalFile(filePath: string, cwd = process.cwd()): string | null {
  if (path.isAbsolute(filePath) && existsSync(filePath)) return filePath;

  const rel = path.resolve(cwd, filePath);
  if (existsSync(rel)) return rel;

  // Strip leading path components to handle Docker-style paths (/app/src/foo.go → src/foo.go)
  const parts = filePath.split('/');
  for (let i = 1; i < parts.length; i++) {
    const candidate = path.resolve(cwd, parts.slice(i).join('/'));
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function localHeadSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export async function matchLines(
  filePath: string,
  lineNumber: number,
  deployedSha?: string,
): Promise<string> {
  const localFile = findLocalFile(filePath);
  if (!localFile) {
    return `[file not found in local workspace: ${filePath}]`;
  }

  let shaWarning = '';
  if (deployedSha) {
    const localSha = localHeadSha();
    if (
      localSha &&
      !localSha.startsWith(deployedSha.slice(0, 7)) &&
      !deployedSha.startsWith(localSha.slice(0, 7))
    ) {
      shaWarning =
        `\n⚠ SHA mismatch: deployed=${deployedSha.slice(0, 7)}, ` +
        `local=${localSha.slice(0, 7)} — code below may differ from what's running in production`;
    }
  }

  try {
    const content = readFileSync(localFile, 'utf8');
    const allLines = content.split('\n');

    const start = Math.max(0, lineNumber - CONTEXT_LINES - 1);
    const end = Math.min(allLines.length, lineNumber + CONTEXT_LINES);

    const excerpt = allLines
      .slice(start, end)
      .map((line, i) => {
        const ln = start + i + 1;
        const marker = ln === lineNumber ? '>>>' : '   ';
        return `${marker} ${String(ln).padStart(4)}: ${line}`;
      })
      .join('\n');

    return excerpt + shaWarning;
  } catch {
    return `[could not read ${localFile}]${shaWarning}`;
  }
}
