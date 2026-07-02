# Mergen Enterprise Security

**For:** Security teams, CISOs, compliance leads  
**Purpose:** Pre-procurement security review package

---

## Executive summary

Mergen is an MCP server for autonomous incident triage that runs entirely on your infrastructure. Your telemetry never leaves your network. The system executes shell commands — a capability that requires careful security review. This document covers the execution model, data flows, access controls, and compliance posture.

If you have questions this document doesn't answer, contact us: **security@mergen.dev**

---

## 1. Data flows

### What stays on your infrastructure (always)

- All telemetry events (logs, traces, network events, process output)
- Incident content: error messages, stack traces, service names, URLs
- Fix commands and their output
- The override corpus (your team's operational knowledge)
- The shadow log (track record of recommendations)
- The calibration corpus (verdict history)
- The audit log

**No Mergen telemetry server receives any of this data.** Ingest binds to `127.0.0.1` by default, making it unreachable externally.

### What leaves your infrastructure (opt-in only)

If you set `MERGEN_TELEMETRY=1`, Mergen uploads anonymous accuracy signals to our calibration aggregation server. The payload is strictly:

```json
{
  "tag": "infra_db_connection_pool",
  "confidence": 0.91,
  "verdict": "correct",
  "timestamp": 1717900800000
}
```

Nothing else. No error messages. No service names. No commands. No stack traces. No IP addresses.

You can inspect exactly what would be sent before enabling: `GET /calibration/export` returns the full CSV. What's in that CSV is exactly what would be uploaded.

**Default:** `MERGEN_TELEMETRY` is not set — zero data leaves your infrastructure.

### Audit: what would be sent?

```bash
# Review the calibration export before enabling telemetry
curl http://127.0.0.1:3000/calibration/export
```

Every row is: `tag, confidence_level, confidence_score, verdict, note (≤140 chars), timestamp`. No incident content.

---

## 2. Execution model

Mergen executes shell commands. This is the most sensitive capability and has multiple independent safety gates.

### Gate 1 — Confidence threshold

Commands execute only when **remediation confidence ≥ 85%**. Diagnosis confidence and remediation confidence are tracked separately — a hypothesis can be HIGH confidence diagnostically while having lower remediation confidence (e.g., OOM kills are usually correctly diagnosed but the right fix depends on whether it's a leak or a limit issue).

### Gate 2 — Blocklist (15 patterns)

Hard-rejected patterns that cannot be bypassed:

| Pattern | Example |
|---------|---------|
| `rm -rf <path>` | Recursive delete |
| `rm */*` | Path separator removes |
| Disk device writes | `> /dev/sda` |
| Disk dump | `dd if=...` |
| Filesystem format | `mkfs.*` |
| Fork bomb | `:(){ :|:& };:` |
| `curl/wget \| bash` | Remote code execution |
| `chmod 777` | World-writable |
| `sudo rm` | Privileged delete |
| `DROP TABLE` | SQL table drop |
| `DROP DATABASE` | SQL database drop |
| `TRUNCATE TABLE` | SQL truncate |
| `git push --force` | History rewrite |
| `git reset --hard` | Destructive reset |

These are checked via regex against the full command string before any execution attempt.

### Gate 3 — Override corpus

Before executing, Mergen consults your team's override history. If this `(detector_tag, service)` combination has been overridden in the same day-of-week / time-of-day window in the last 90 days, autopilot pauses and posts to Slack requesting manual confirmation. This learns patterns like "never auto-resize the DB pool on Friday evenings" without any explicit configuration.

### Gate 4 — Autopilot level (staged rollout)

`MERGEN_AUTOPILOT_LEVEL` controls which risk tier of commands can execute autonomously:

| Level | What executes | Recommended for |
|-------|--------------|-----------------|
| `restarts` | Service restarts and reloads only (`pm2 restart`, `kubectl rollout restart`, `systemctl restart`) | Initial autopilot rollout |
| `deploys` | Restarts + rollbacks + dependency pins + image updates | After 30 days at `restarts` |
| `full` | All commands that pass the blocklist | After track record established |

This gives your security team a ramp-up path. Start with `restarts` — the safest tier — before promoting to broader execution.

### Gate 5 — RBAC

Role-based access control limits who can execute fixes via the MCP tools:

| Role | Capabilities |
|------|-------------|
| `viewer` | Read-only: view events, hypotheses, reports |
| `responder` | Viewer + execute fixes, record overrides |
| `admin` | Responder + manage team members and routing |

RBAC is checked on every `execute_fix` call. Actors are identified by the `actor` field or `MERGEN_MCP_ACTOR` env var and matched against the RBAC registry.

### Gate 6 — Timeout and output cap

Every command has a 60-second timeout. Output is capped at 16KB (stdout + stderr). Commands that exceed either are killed.

### Gate 7 — Audit log

Every execution attempt is written to `~/.mergen/audit.log` (JSONL format) before and after execution, including:

```json
{
  "t": "2024-01-15T03:17:32.145Z",
  "event": "autonomy.execute",
  "actor": "autopilot",
  "cmd": "npm install jsonwebtoken@9.0.0 && pm2 restart api",
  "ok": true,
  "exitCode": 0,
  "durationMs": 4821,
  "blocked": false,
  "timedOut": false
}
```

Blocked commands are also logged with their `blockReason`. The audit log is append-only and cannot be cleared via the API.

---

## 3. Gate threat model

The execution gate protects systems from unsafe agent actions that pass through
Mergen's MCP server. It is not a general-purpose local endpoint protection
agent. Security review should evaluate four separate attack surfaces:

| Attack surface | Current posture | Enterprise hardening requirement |
|----------------|-----------------|----------------------------------|
| Process-level tampering | Mergen writes a gate heartbeat every 2 seconds (configurable). Every MCP tool call checks heartbeat freshness before policy evaluation — stale or missing heartbeat causes an immediate fail-closed BLOCK. Set `MERGEN_REQUIRE_GATE_HEARTBEAT=true` to activate enforcement (opt-in; default is warn-only). This does not prevent a same-user process from killing Mergen — that requires OS-level privilege separation. | Run the gate under a separate OS user, service manager, or container namespace so the agent cannot signal or write to the gate process. |
| Policy file tampering | `~/.mergen/enterprise-policy.json` is protected with an HMAC sidecar and falls back to safe defaults on signature mismatch. The bypass token file is also HMAC-signed (keyed to `MERGEN_SECRET`). | Store `MERGEN_SECRET` outside the data directory — if the signing key and the files it protects share the same writable filesystem under the same user, a sufficiently privileged local compromise can defeat this control. |
| Override corpus poisoning | The operational override corpus (incident response patterns) and the MCP gate (HITL approve/deny decisions) are isolated stores. A HITL approval or denial does not write to the override corpus and does not relax future gate enforcement. Override corpus entries are scoped by detector tag, service, environment, time window, and actor. | Require review before promoting any corpus entry into a broad policy rule. The attack surface is a coerced or socially-engineered entry that generalizes across services or environments — narrow scoping is the defence. |
| MCP transport trust | The gate evaluates the tool call it receives over MCP stdio. It cannot prove that an upstream host or wrapper preserved the LLM's original intent. | Treat the IDE / agent host as part of the trusted computing base. For higher-assurance deployments, put Mergen at the last controllable boundary before command execution rather than relying on an earlier advisory layer. |

### Process tampering and fail-closed behavior

**What is implemented today.** Mergen starts a gate heartbeat at startup that
writes `~/.mergen/gate-heartbeat.json` every 2 seconds (default; configurable
via `MERGEN_GATE_HEARTBEAT_INTERVAL_MS`). The first action in `applyGate` —
before injection detection, before policy evaluation, before anything else — is
a freshness check against that file. If the heartbeat is stale (older than
`MERGEN_GATE_HEARTBEAT_MAX_AGE_MS`, default 10 seconds) or missing, the gate
returns a structured BLOCK with a guided alternative and logs the event to the
Agent Blunder Log.

Enable enforcement:
```bash
MERGEN_REQUIRE_GATE_HEARTBEAT=true mergen-server start
```

Without this flag the heartbeat is written and checked but the check is
advisory — stale heartbeat logs a warning rather than blocking. Set the flag
for any deployment where fail-closed is a security requirement.

**What is not claimed.** If the AI agent and the gate run as the same OS user,
a compromised agent with shell access may kill the gate process before the
heartbeat can write. The freshness check detects this within one heartbeat
interval (2 seconds by default), but a kill-then-immediately-act sequence
within that window is not prevented by the heartbeat alone.

**The stronger claim requires OS-level separation.** For Tier 2 and Tier 3
deployments, require one of:

- A service manager such as `systemd` or a managed launch daemon that restarts
  the gate and exposes health state to the agent host.
- A separate OS user or container namespace for the gate, with the agent unable
  to signal or write to the gate process.

Until OS-level separation is in place, the claim is: Mergen detects and blocks
unsafe calls that reach the gate, including within 2 seconds of a gate process
failure. The stronger claim — "agents cannot bypass the gate even after
targeting the gate process directly" — requires privilege separation.

---

## 4. Network exposure

### Default (local mode)

```
MERGEN_BIND=127.0.0.1 (default)
```

The Express server binds to `127.0.0.1` only. No external traffic reaches it. The MCP stdio server communicates via stdin/stdout — no network port at all.

### Team mode

```
MERGEN_BIND=0.0.0.0
```

Exposes the server to the local network for CI runners and remote browsers. Use with `MERGEN_SECRET` or `MERGEN_CLOUD_MODE=true` (TLS + API key auth).

### Cloud mode

```
MERGEN_CLOUD_MODE=true
MERGEN_TLS_CERT=/path/to/cert.pem
MERGEN_TLS_KEY=/path/to/key.pem
```

Adds:
- TLS termination
- SHA-256 hashed API key authentication on all ingest endpoints
- Sliding-window rate limiting
- Per-tenant event isolation (events tagged at ingest, filtered on every read)

### DNS rebinding protection

Mergen validates the `Host` header on every request in local mode. Requests from unexpected hostnames are rejected with HTTP 421 before they reach any route. This prevents DNS rebinding attacks from malicious web pages running on the same machine.

---

## 5. PII handling

An always-on regex shield strips PII from all events before they enter the ring buffer:

| Pattern | Example |
|---------|---------|
| Email addresses | `user@example.com` |
| Phone numbers | `+1 (555) 123-4567` |
| AWS access keys | `AKIA...` |
| AWS secret keys | 40-char base64 patterns |
| PEM private keys | `-----BEGIN RSA PRIVATE KEY-----` |
| JWTs | `eyJ...` tokens |
| Credit card numbers | 13–19 digit Luhn-valid numbers |

The shield is configurable for additional patterns: `~/.mergen/pii-config.json`.

PII is replaced with `[REDACTED]` in the buffer. It never reaches the AI IDE or any external system.

---

## 6. Secret management

| Secret | Storage | Transmission |
|--------|---------|-------------|
| Local shared secret | `~/.mergen/secret` (mode 0600) | `x-mergen-secret` header (localhost only) |
| Slack bot token | Environment variable | HTTPS to `slack.com` only |
| Datadog API keys | Environment variable | HTTPS to Datadog API only |
| Cloud API keys | SHA-256 hashed in `~/.mergen/api-keys.json` | Bearer token in Authorization header |

The local secret is generated as a UUID on first start and is readable only by the process owner.

---

## 7. Compliance posture

### SOC 2 readiness

Run `GET /compliance/report` (add `?format=html` for a printable page) for a
live snapshot of these controls against your actual current configuration —
not a static claim, since several rows below depend on env vars you set
(`MERGEN_AUDIT_SECRET`, RBAC membership, whether the policy is enabled).

| Trust Service Criterion | Control | Mergen mechanism | Depends on |
|---|---|---|---|
| Security | Access control | RBAC with viewer / responder / admin roles (`GET /rbac/members`) | Members must be registered — `POST /rbac/members` |
| Security | Least privilege for agents | Per-agent-profile tool/service allowlists, enforced only for a cryptographically verified identity (`MERGEN_AGENT_TOKEN`, not the bare `MERGEN_AGENT_ID` env var) | `mergen-server agent-register <profile-id>` |
| Security | Change management | Every blocked/held action logged (actor, command, outcome, triggered rule) to the Agent Blunder Log | Always on |
| Security | Audit log integrity | Hash-chained blunder log (`GET /agent-blunders/verify`); tamper-evidence level is reported honestly as `none` / `hash-chain` / `hmac-sealed` depending on whether a signing secret is configured — an unkeyed hash chain alone does not survive an attacker with the same filesystem access this process has | `MERGEN_AUDIT_SECRET` for `hmac-sealed` (falls back to the per-install `~/.mergen/secret` otherwise, which is weaker against the exact adversary this control is meant to cover) |
| Security | Incident response | Shadow mode provides a pre-autopilot review period before autonomous execution is trusted | `MERGEN_SHADOW_MODE=true` |
| Confidentiality | Data residency | All data on your infrastructure by default | Default — no cloud mode configured |
| Confidentiality | PII redaction | Always-on regex shield (email, phone, AWS keys, PEM certs, JWTs, credit cards); extensible via `~/.mergen/pii-config.json` | Always on |
| Availability | Not applicable | Mergen governs your infrastructure; it does not host your production systems, so uptime/DR controls for what Mergen governs are your own responsibility, not Mergen's | N/A |

Raw tamper-evident audit data for an external auditor to independently verify: `GET /audit/export?format=soc2`.

### GDPR / CCPA

The PII shield is on by default. No personal data enters the ring buffer or calibration corpus. The anonymous telemetry upload (opt-in) contains no PII.

### Change advisory board (CAB) integration

Use the `compliance-hold` override reason to prevent autopilot execution during CAB-controlled change windows. Overrides are automatically learned — Mergen will pause before acting in the same time window going forward.

```bash
curl -X POST http://127.0.0.1:3000/overrides \
  -H 'Content-Type: application/json' \
  -d '{
    "incidentTag": "*",
    "proposedCommand": "*",
    "overrideReason": "compliance-hold",
    "note": "Q4 change freeze — all changes require CAB approval",
    "service": "payments",
    "environment": "production"
  }'
```

---

## 8. Penetration testing

Before running a pentest against a Mergen deployment:
- Obtain written authorization from your security team (standard scope qualification)
- Test against a staging environment, not production
- The local secret and API keys are in scope for the pentest
- The execution blocklist is in scope — we welcome attempts to bypass it

Report findings to **security@mergen.dev**. We respond within 48 hours and issue CVEs for confirmed vulnerabilities.

---

## 8. Questions CISO teams typically ask

**Q: What happens if Mergen's AI is wrong and executes a bad fix?**  
A: The fix is gated at ≥85% confidence AND passes the blocklist. If it's wrong: it's logged in the audit trail with full output, the Slack thread shows REGRESSED, and the human on-call can manually revert. The override corpus records the bad fix and prevents it from running again in the same context.

**Q: Can an attacker inject a command via a log event?**  
A: Fix commands come from the hypothesis `fixHint` field, which is generated by the internal causal analysis pipeline — not from log events directly. The blocklist applies to all commands regardless of source. Additionally, commands are extracted by a function that requires a recognisable shell command structure; free-text injected in logs does not become a command.

**Q: Does Mergen have network access from within the execution environment?**  
A: Commands run with the same network access as the user who started Mergen. There is no network isolation sandbox. The blocklist prevents `curl | bash` style remote code execution, but Mergen does not provide additional network isolation beyond what your OS and user permissions provide.

**Q: What if the Slack bot token is compromised?**  
A: The Slack bot token has `chat:write` scope only — it can post messages but cannot read messages, access files, or take any action outside Slack. It cannot interact with Mergen's API or trigger execution.

**Q: Can Mergen be used to exfiltrate data?**  
A: Mergen executes commands derived from its causal analysis. It does not have a general-purpose shell or API that accepts arbitrary commands from untrusted sources. The `execute_fix` MCP tool requires `confirm: true` and is accessible only to authenticated MCP clients (your AI IDE). The autopilot only executes commands from the internal hypothesis pipeline.

---

## Contact

- Security issues: **security@mergen.dev**
- General questions: **hello@mergen.dev**
- GitHub: [github.com/omertt27/Mergen](https://github.com/omertt27/Mergen)
