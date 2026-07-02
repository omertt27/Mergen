#!/usr/bin/env node
/**
 * cli.ts — Mergen CLI for easy setup and management
 *
 * Usage:
 *   npx mergen-server setup    # Interactive setup wizard
 *   npx mergen-server test     # Validate installation
 *   npx mergen-server start    # Start server
 *   npx mergen-server --help   # Show help
 */

// Command implementations extracted into commands/* (C2 refactor).
import { log, error, VERSION } from './commands/shared.js';
import { loginCommand, setupCommand, testCommand, ciCommand, startCommand, doctorCommand, quickstartCommand } from './commands/setup.js';
import { postmortemCommand, timelineCommand, watchCommand, explainCommand, statusCommand, resolvedCommand, replayCommand } from './commands/incident.js';
import { approveCommand, shadowReportCommand, allowCommand, verifyLogCommand, guardCommand, policyPushCommand, policyPullCommand, policyDiffCommand, testSafetyCommand } from './commands/policy.js';
import { prCommand, prShadowCommand, feedbackCommand, backfillCommand, connectCommand } from './commands/github.js';
import { inviteCommand, joinCommand, impactReportCommand, exportCommand, initCommand, demoCommand, exportRiskReportCommand, partnerShortlistCommand, execCommand } from './commands/team.js';
import { agentRegisterCommand, agentListCommand } from './commands/agent-identity.js';
import { gateCheckCommand } from './commands/gate.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      await initCommand();
      break;

    case 'resolved':
      await resolvedCommand(args.slice(1));
      break;

    case 'demo':
      await demoCommand();
      break;

    case 'pr':
      await prCommand(args.slice(1));
      break;

    case 'connect':
      await connectCommand(args.slice(1));
      break;

    case 'backfill':
      await backfillCommand(args.slice(1));
      break;

    case 'feedback':
      await feedbackCommand(args.slice(1));
      break;

    case 'pr-shadow':
      await prShadowCommand();
      break;

    case 'approve':
      await approveCommand(args.slice(1));
      break;

    case 'shadow-report':
      await shadowReportCommand();
      break;

    case 'allow':
      await allowCommand(args.slice(1));
      break;

    case 'impact-report':
      await impactReportCommand(args.slice(1));
      break;

    case 'setup':
      await setupCommand();
      break;

    case 'login':
      await loginCommand();
      break;

    case 'test':
      await testCommand();
      break;

    case 'start':
      await startCommand();
      break;

    case 'ci':
      await ciCommand();
      break;

    case 'invite':
      await inviteCommand();
      break;

    case 'join':
      await joinCommand(args);
      break;

    case 'postmortem':
      await postmortemCommand(args);
      break;

    case 'timeline':
      await timelineCommand(args);
      break;

    case 'watch':
      await watchCommand(args);
      break;

    case 'explain':
      await explainCommand(args.slice(1));
      break;

    case 'quickstart':
      await quickstartCommand();
      break;

    case 'status':
      await statusCommand();
      break;

    case 'doctor':
      await doctorCommand();
      break;

    case 'export':
      await exportCommand(args);
      break;

    case 'export-risk-report':
      await exportRiskReportCommand(args.slice(1));
      break;

    case 'partner-shortlist':
      await partnerShortlistCommand(args.slice(1));
      break;

    case 'exec':
      await execCommand(args.slice(1));
      break;

    case 'test-safety':
      await testSafetyCommand();
      break;

    case 'policy-push':
      await policyPushCommand();
      break;

    case 'policy-pull':
      await policyPullCommand(args.slice(1));
      break;

    case 'policy-diff':
      await policyDiffCommand();
      break;

    case 'verify-log':
      await verifyLogCommand();
      break;

    case 'guard':
      await guardCommand(args);
      break;

    case 'replay':
      await replayCommand(args.slice(1));
      break;

    case 'agent-register':
      await agentRegisterCommand(args.slice(1));
      break;

    case 'agent-list':
      await agentListCommand();
      break;

    case 'gate-check':
      await gateCheckCommand(args.slice(1));
      break;

    case 'version':
    case '--version':
    case '-v':
      console.log(`mergen-server v${VERSION}`);
      break;

    case undefined:
      // No args — start demo mode immediately. 50 sample incidents, zero config.
      await demoCommand();
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(`
Mergen — production incident intelligence

Usage:
  mergen-server                    Zero-config demo — loads 50 sample incidents instantly
  mergen-server start              Start server (production mode)
  mergen-server login              Authenticate Mergen CLI (automatic browser & manual fallback)
  mergen-server login --key <key>  Directly authenticate using a license key
  mergen-server approve <id>       Temporarily bypass a blocked command block (10 min)
  mergen-server setup              Interactive setup wizard (connect PagerDuty, OTLP, IDE)
  mergen-server setup --yes        Non-interactive setup (skip all prompts, use defaults)
  mergen-server setup --ide cursor Configure a specific IDE (cursor|vscode|claude-code|windsurf)
  mergen-server setup --skip-github     Skip GitHub connect step
  mergen-server demo               Same as no args — demo with sample incidents
  mergen-server status             Live snapshot: server health, buffer, errors, MCP activity
  mergen-server doctor             Full health-check: env vars, IDE config, integrations
  mergen-server connect github     Auto-register GitHub webhook → populates intent archive
  mergen-server backfill github    Import historical PRs → enables explain_why on day 1
  mergen-server init               Connect Datadog (guided setup)
  mergen-server pr                 Generate a PR description from your debug session
  mergen-server pr --copy          Same, but copies to clipboard
  mergen-server quickstart         Guided wizard — from zero to first real insight in 2 min
  mergen-server watch <cmd>        Stream any process into Mergen (auto-starts server if needed)
  mergen-server explain [file]     Analyze a log file or piped input — no server required
  mergen-server invite             Generate a team invite URL
  mergen-server join <url>         Join a team Mergen instance
  mergen-server postmortem [h]     Generate a postmortem document (default: last 1 hour)
  mergen-server timeline [seconds] Unified causal timeline
  mergen-server export [label]     Export session as JSON + HTML report
  mergen-server export-risk-report Print CISO security risk report
  mergen-server export-risk-report --markdown  Save as shareable Markdown file
  mergen-server exec -- <cmd>      Run a command through the full Mergen gate (policy, HITL, blast radius), then execute
  mergen-server exec --allow-offline -- <cmd>  Same, but degrade to a local-only check if mergen-server isn't running
  mergen-server gate-check -- <cmd>  Evaluate only, no execution (exit 0=pass 1=blocked). Used by the Claude Code PreToolUse hook
  mergen-server impact-report      Print the 5 pre-agreed Day-30 metrics
  mergen-server impact-report --slide     Screenshot-ready 5-number card
  mergen-server impact-report --baseline  Save Day-1 numbers (compare at Day 30)
  mergen-server impact-report --compare   Show delta vs. saved baseline
  mergen-server impact-report --html      Write full HTML report to disk
  mergen-server partner-shortlist  Print design-partner filter criteria and commands
  mergen-server partner-shortlist --add <name> <company> [role] [reach] [notes]
  mergen-server partner-shortlist --list  Show saved candidates
  mergen-server test-safety        Run adversarial bypass test suite against the gate
  mergen-server policy-push        Save live server policy → .mergen/policy.json (for git)
  mergen-server policy-pull        Apply .mergen/policy.json → live server
  mergen-server policy-pull --merge  Merge (add new rules only, keep existing)
  mergen-server policy-diff        Show diff between .mergen/policy.json and live server
  mergen-server replay <dir>       Score historical incidents against the detector pipeline
  mergen-server agent-register <id>  Issue a signed identity token for an agent profile (see agent-profiles API)
  mergen-server agent-list         List issued agent identity tokens on this machine
  mergen-server verify-log         Verify Agent Blunder Log hash chain (tamper-evident audit)
  mergen-server guard              Pre-commit runtime check (includes incident history for staged services)
  mergen-server guard --install    Install as git pre-commit hook
  mergen-server test               Validate installation
  mergen-server ci                 CI smoke test (exit 0 = healthy)
  mergen-server --version          Show version

Examples:
  npx mergen-server                # instant demo — no config needed
  mergen-server setup --yes        # non-interactive setup in CI
  mergen-server setup --ide cursor --skip-github
  mergen-server start &            # production server in background
  mergen-server connect github --repo acme/api
  mergen-server watch npm start

Documentation: https://github.com/omertt27/Mergen
      `);
      break;

    default:
      error(`Unknown command: ${command}`);
      console.log('Run: mergen-server --help');
      process.exit(1);
  }
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});
