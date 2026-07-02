/**
 * commands/agent-identity.ts — CLI for issuing and listing signed agent
 * identity tokens (see intelligence/agent-identity.ts).
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { log, error, success, hr } from './shared.js';

function readLocalSecret(): string {
  const secretPath = process.env.MERGEN_AGENT_TOKEN_SECRET
    ? '' // env var takes precedence — no file read needed
    : join(homedir(), '.mergen', 'secret');
  if (process.env.MERGEN_AGENT_TOKEN_SECRET) return process.env.MERGEN_AGENT_TOKEN_SECRET;
  if (secretPath && existsSync(secretPath)) {
    try { return readFileSync(secretPath, 'utf8').trim(); } catch { /* fall through */ }
  }
  return '';
}

export async function agentRegisterCommand(args: string[]): Promise<void> {
  const profileId = args[0];
  if (!profileId) {
    error('Usage: mergen-server agent-register <profile-id>');
    console.log('  Issues a signed MERGEN_AGENT_TOKEN for the given agent-profile id.');
    console.log('  Register the profile first with the agent-profiles API (POST /agent-profiles), then run this.');
    process.exit(1);
  }

  const secret = readLocalSecret();
  if (!secret) {
    error('No signing secret found — start mergen-server at least once to generate ~/.mergen/secret, or set MERGEN_AGENT_TOKEN_SECRET.');
    process.exit(1);
  }

  const { setAgentTokenSecret, issueToken } = await import('../intelligence/agent-identity.js');
  setAgentTokenSecret(secret);
  const token = issueToken(profileId);

  hr();
  success(`Issued agent identity token for profile "${profileId}"`);
  console.log('');
  console.log('  Add this to the MCP server env block for the agent that should carry this identity:');
  console.log('');
  console.log(`    MERGEN_AGENT_TOKEN=${token}`);
  console.log('');
  console.log('  For Cursor/VSCode/Windsurf, add it to the "env" object in your mcp.json mergen entry.');
  console.log('  For Claude Code: claude mcp add mergen --env MERGEN_AGENT_TOKEN=<token> --transport stdio -- node <server-path>');
  console.log('');
  console.log('  This token is long-lived (1 year) and is NOT stored server-side beyond a local record for');
  console.log('  operator visibility (mergen-server agent-list) — verification is stateless. Re-run this');
  console.log('  command to issue a fresh token; the old one keeps working until it expires (no revocation list yet).');
  hr();
}

export async function agentListCommand(): Promise<void> {
  const { listIssuedTokenRecords } = await import('../intelligence/agent-identity.js');
  const records = listIssuedTokenRecords();
  if (records.length === 0) {
    log('No agent identity tokens have been issued on this machine. Run: mergen-server agent-register <profile-id>');
    return;
  }
  hr();
  console.log('Issued agent identity tokens:\n');
  for (const r of records) {
    const expired = Date.now() > r.expiresAt ? ' (EXPIRED)' : '';
    console.log(`  ${r.agentId}`);
    console.log(`    issued:  ${new Date(r.issuedAt).toISOString()}`);
    console.log(`    expires: ${new Date(r.expiresAt).toISOString()}${expired}`);
    console.log('');
  }
  hr();
}
