# Security Policy

## Supported Versions

We release security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email: **omertt27@gmail.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will respond within **48 hours** and provide a timeline for a fix.

---

## Security Model

Mergen is designed as a **local-first development tool**. All data stays on `127.0.0.1` (localhost).

### Threat Model

**In Scope:**
- Server vulnerabilities (RCE, injection, etc)
- Extension vulnerabilities affecting host pages
- Authentication/authorization issues
- Data leakage to external systems

**Out of Scope:**
- Local privilege escalation (Mergen runs with user privileges)
- Physical access to machine
- Browser vulnerabilities unrelated to Mergen
- Social engineering attacks

---

## Security Features

### 1. Localhost-Only Binding

The HTTP server binds to `127.0.0.1` only:
```typescript
app.listen(port, '127.0.0.1');
```

**Impact:** Server is not reachable from other machines on the network or internet.

### 2. Optional Shared-Secret Auth

```bash
MERGEN_SECRET=mysecret mergen-server start
```

All ingest requests must include `x-mergen-secret: mysecret` header.

**Note:** Not recommended for most users. Localhost binding provides sufficient isolation.

### 3. Input Validation

All HTTP requests validated with Zod schemas:
```typescript
const consoleEventSchema = z.object({
  type: z.literal('console'),
  level: z.enum(['log', 'info', 'warn', 'error']),
  args: z.array(z.any()),
  url: z.string(),
  timestamp: z.number()
});
```

**Impact:** Malformed requests rejected before processing.

### 4. Payload Size Limits

- **Max request size:** 1MB
- **Max body field:** 8KB (request/response bodies)
- **Max buffer:** 200 events

**Impact:** Prevents memory exhaustion attacks.

### 5. Rate Limiting

Built-in rate limiting:
- Burst: 100 requests
- Sustained: ~1000 req/sec

**Impact:** Mitigates DoS attempts.

### 6. Extension Isolation

The browser extension:
- **Does not** inject scripts into pages
- **Does not** modify page behavior
- **Only captures** console and network events
- **Fails silently** on errors (never breaks host page)

**Impact:** Minimal attack surface, no impact on user's browsing.

### 7. No External Connections

Mergen makes **zero external network connections**:
- No telemetry
- No update checks (except opt-in via `npx mergen-server@latest`)
- No analytics
- No cloud services

**Impact:** No data exfiltration risk.

---

## Best Practices

### For Users

1. **Don't expose the server publicly:**
   - Never bind to `0.0.0.0`
   - Don't port-forward 3000-3010
   - Keep firewall enabled

2. **Don't log sensitive data:**
   - Don't `console.log()` passwords, tokens, or PII
   - Review what your app logs before using Mergen

3. **Run server as unprivileged user:**
   - Don't run as root/admin
   - Use standard user account

4. **Keep dependencies updated:**
   ```bash
   cd server
   npm update
   npm audit
   ```

5. **Review extension permissions:**
   - Extension only needs `activeTab` and `storage` permissions
   - Review code in `extension/src/` before installing

### For Developers

1. **Validate all inputs:**
   - Use Zod schemas for all API endpoints
   - Sanitize user-provided data

2. **Avoid eval/Function:**
   - Never use `eval()` on captured data
   - Don't execute user-provided code

3. **Limit buffer size:**
   - Keep ring buffer capped at 200 events
   - Implement eviction policy

4. **Log security events:**
   - Log failed auth attempts
   - Log malformed requests
   - Monitor for unusual patterns

5. **Run security scans:**
   ```bash
   npm audit
   npm run test
   ```

---

## Known Security Considerations

### 1. Sensitive Data in Logs

**Risk:** Users may accidentally log passwords, tokens, or PII via `console.log()`.

**Mitigation:**
- Documentation warns against logging sensitive data
- Users should review their app's logging before using Mergen
- Consider implementing optional redaction rules

### 2. Local Privilege Escalation

**Risk:** If a malicious process runs as the same user, it could read Mergen's buffer.

**Mitigation:**
- Data is in-memory only (not persisted to disk)
- Buffer is cleared on server restart
- Use OS-level security (firewall, antivirus)

### 3. Browser Extension Permissions

**Risk:** Extension has access to page content (console, network).

**Mitigation:**
- Extension does not inject scripts
- Extension does not modify pages
- Source code is readable in `extension/src/`
- Users can review before installing

### 4. MCP Protocol Security

**Risk:** MCP uses stdio, which is readable by processes with same privilege level.

**Mitigation:**
- MCP is intended for local development only
- Don't use Mergen in untrusted environments
- IDE integration assumes IDE is trusted

---

## Security Updates

We monitor dependencies for known vulnerabilities:

```bash
# Check for vulnerabilities
npm audit

# Auto-fix (when safe)
npm audit fix
```

**Automated:** GitHub Dependabot runs daily on the repository.

---

## Disclosure Policy

When we fix a security issue:

1. **Patch released** within 7 days (for critical issues)
2. **GitHub Security Advisory** published
3. **CVE requested** if severity warrants
4. **Users notified** via GitHub release notes
5. **Full disclosure** after 90 days (or when patch adoption >90%)

---

## Security Contacts

- **Report vulnerabilities:** omertt27@gmail.com
- **Security advisories:** https://github.com/omertt27/Mergen/security/advisories
- **PGP key:** (Optional, if you set one up)

---

## Acknowledgments

We thank security researchers who responsibly disclose vulnerabilities. Contributors may be acknowledged in release notes (with permission).

---

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Chrome Extension Security](https://developer.chrome.com/docs/extensions/mv3/security/)
- [Model Context Protocol Security](https://modelcontextprotocol.io/docs/security)

---

**Last Updated:** 2026-05-14  
**Version:** 1.0.0
