# Mergen for Enterprise Teams

Mergen is a self-hosted observability bridge that connects your running applications to your team's AI assistant. It captures live runtime telemetry — console errors, network calls, backend spans — and exposes them to the AI via the Model Context Protocol (MCP).

**Everything stays on your network. No data leaves your infrastructure.**

---

## Who this is for

- Engineering teams of 5–500 developers
- Any language on the backend (Java, C#, Python, Go, Ruby, PHP, Node.js)
- Any frontend framework (React, Angular, Vue, Blazor, anything that runs in a browser)
- Any CI system (GitHub Actions, Azure DevOps, Jenkins, GitLab CI, Bamboo, TeamCity)
- Any AI assistant that supports MCP: GitHub Copilot, Cursor, Claude Code, Windsurf, Continue

---

## Self-hosted deployment

### Docker Compose (recommended for teams)

```yaml
# docker-compose.yml
services:
  mergen:
    image: mergen/server:latest
    ports:
      - "3000:3000"   # MCP + REST API
      - "4318:4318"   # OTLP receiver (optional — for OTel-instrumented backends)
    environment:
      MERGEN_BIND: "0.0.0.0"       # accept connections from the team's network
      MERGEN_SECRET: "${SECRET}"    # shared secret for authenticated writes
      MERGEN_RETENTION_HOURS: "168" # 7-day event retention
    volumes:
      - mergen-data:/app/.mergen   # persist event history and calibration state
    restart: unless-stopped
```

```bash
docker compose up -d
```

The server is now reachable at `http://mergen.internal.yourcompany.com:3000`.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `MERGEN_BIND` | `127.0.0.1` | Set to `0.0.0.0` for team/shared mode |
| `MERGEN_SECRET` | _(none)_ | Shared secret required for write endpoints |
| `MERGEN_RETENTION_HOURS` | `24` | How long events are stored in SQLite |
| `MERGEN_PORT` | `3000` | HTTP port |
| `MERGEN_DOCKER_LOGS` | `false` | Set to `true` to stream Docker container logs |

---

## Connecting your frontend

Add one line to your frontend entry point. No browser extension needed.

```bash
npm install @mergen/browser
```

```typescript
// main.ts / index.ts / App.tsx — wherever your app boots
import { init } from '@mergen/browser';

init({
  endpoint: 'https://mergen.internal.yourcompany.com',
  service: 'frontend',
});
```

This injects W3C `traceparent` headers on every outbound HTTP request, enabling Mergen to perform **deterministic joins** between browser errors and backend log lines — not timestamp guessing, the same trace ID.

Works in any environment: localhost, staging, production. No browser permissions required. Standard OTLP over HTTP.

---

## Connecting your backend

### Java / Spring Boot

Add the OpenTelemetry Java agent to your startup command. No code changes.

```bash
# Download the OTel Java agent
curl -L -o otel-agent.jar \
  https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar

# Start your Spring Boot app with the agent
java \
  -javaagent:otel-agent.jar \
  -Dotel.service.name=backend \
  -Dotel.exporter.otlp.endpoint=http://mergen.internal.yourcompany.com:4318 \
  -Dotel.exporter.otlp.protocol=http/json \
  -jar app.jar
```

The agent instruments Spring MVC, RestTemplate, WebClient, JDBC, and more automatically. Every inbound request extracts the `traceparent` header injected by `@mergen/browser` and propagates it through your call stack.

### C# / .NET

```bash
dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Instrumentation.AspNetCore
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
```

```csharp
// Program.cs
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter(opts => {
            opts.Endpoint = new Uri("http://mergen.internal.yourcompany.com:4318/v1/traces");
            opts.Protocol = OtlpExportProtocol.HttpProtobuf; // or HttpJson
        }));
```

### Go

```go
import (
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

exporter, _ := otlptracehttp.New(ctx,
    otlptracehttp.WithEndpoint("mergen.internal.yourcompany.com:4318"),
    otlptracehttp.WithInsecure(),
)
tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter))
otel.SetTracerProvider(tp)
```

### Python / Django / FastAPI

```bash
pip install mergen-python
# or via OTel:
pip install opentelemetry-sdk opentelemetry-exporter-otlp
```

```python
# settings.py or app startup
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(
        endpoint="http://mergen.internal.yourcompany.com:4318/v1/traces"
    ))
)
trace.set_tracer_provider(provider)
```

### Ruby / Rails

```ruby
# Gemfile
gem 'opentelemetry-sdk'
gem 'opentelemetry-exporter-otlp'
gem 'opentelemetry-instrumentation-rack'
gem 'opentelemetry-instrumentation-net_http'
```

```ruby
# config/initializers/opentelemetry.rb
require 'opentelemetry/sdk'
require 'opentelemetry/exporter/otlp'

OpenTelemetry::SDK.configure do |c|
  c.service_name = 'backend'
  c.use_all
  c.add_span_processor(
    OpenTelemetry::SDK::Trace::Export::BatchSpanProcessor.new(
      OpenTelemetry::Exporter::OTLP::Exporter.new(
        endpoint: 'http://mergen.internal.yourcompany.com:4318'
      )
    )
  )
end
```

### PHP / Laravel

```bash
composer require open-telemetry/opentelemetry
```

```php
// bootstrap/app.php
use OpenTelemetry\Contrib\Otlp\OtlpHttpTransportFactory;
use OpenTelemetry\Contrib\Otlp\SpanExporter;
use OpenTelemetry\SDK\Trace\TracerProvider;

$transport = (new OtlpHttpTransportFactory())->create(
    'http://mergen.internal.yourcompany.com:4318/v1/traces',
    'application/json'
);
$exporter  = new SpanExporter($transport);
$provider  = new TracerProvider(new SimpleSpanProcessor($exporter));
```

---

## Connecting your CI system

Every CI event is joined to browser errors via the commit SHA. When a developer hits an error, Mergen shows which CI run built the code they're running — and whether it had failing tests.

### Azure DevOps Pipelines

In your pipeline YAML, add a step after the test run:

```yaml
- task: Bash@3
  displayName: 'Report to Mergen'
  condition: always()
  inputs:
    targetType: 'inline'
    script: |
      STATUS="success"
      if [ "$(Agent.JobStatus)" != "Succeeded" ]; then STATUS="failure"; fi
      curl -s -X POST https://mergen.internal.yourcompany.com/ci/generic \
        -H 'Content-Type: application/json' \
        -H 'x-mergen-secret: $(MERGEN_SECRET)' \
        -d "{
          \"sha\":      \"$(Build.SourceVersion)\",
          \"branch\":   \"$(Build.SourceBranchName)\",
          \"status\":   \"$STATUS\",
          \"job\":      \"$(System.JobDisplayName)\",
          \"workflow\": \"$(Build.DefinitionName)\",
          \"url\":      \"$(System.TeamFoundationCollectionUri)$(System.TeamProject)/_build/results?buildId=$(Build.BuildId)\",
          \"provider\": \"azure_devops\"
        }"
```

Or configure a Service Hook webhook at Project Settings → Service Hooks → Web Hooks:
- Trigger: **Build completed**
- URL: `https://mergen.internal.yourcompany.com/ci/azure-devops`

### Jenkins

Install the [Notification Plugin](https://plugins.jenkins.io/notification/). In your job's Post-build Actions:

```
Endpoint URL: https://mergen.internal.yourcompany.com/ci/jenkins
Format: JSON
Event: Job finalized
```

Or via Groovy pipeline:

```groovy
post {
  always {
    script {
      def status = currentBuild.result == 'SUCCESS' ? 'success' : 'failure'
      httpRequest(
        url: 'https://mergen.internal.yourcompany.com/ci/generic',
        httpMode: 'POST',
        contentType: 'APPLICATION_JSON',
        customHeaders: [[name: 'x-mergen-secret', value: env.MERGEN_SECRET]],
        requestBody: """{
          "sha":    "${env.GIT_COMMIT}",
          "branch": "${env.BRANCH_NAME}",
          "status": "${status}",
          "job":    "${env.JOB_NAME} #${env.BUILD_NUMBER}",
          "url":    "${env.BUILD_URL}"
        }"""
      )
    }
  }
}
```

### GitHub Actions

```yaml
- name: Report to Mergen
  if: always()
  run: |
    STATUS="${{ job.status == 'success' && 'success' || 'failure' }}"
    curl -s -X POST ${{ vars.MERGEN_URL }}/ci/github \
      -H 'Content-Type: application/json' \
      -H "x-mergen-secret: ${{ secrets.MERGEN_SECRET }}" \
      -d '{
        "sha":      "${{ github.sha }}",
        "branch":   "${{ github.ref_name }}",
        "status":   "'"$STATUS"'",
        "job":      "${{ github.job }}",
        "workflow": "${{ github.workflow }}"
      }'
```

### GitLab CI

```yaml
report_to_mergen:
  stage: .post
  when: always
  script:
    - |
      STATUS=$([ "$CI_JOB_STATUS" = "success" ] && echo "success" || echo "failure")
      curl -s -X POST $MERGEN_URL/ci/generic \
        -H 'Content-Type: application/json' \
        -H "x-mergen-secret: $MERGEN_SECRET" \
        -d "{
          \"sha\":      \"$CI_COMMIT_SHA\",
          \"branch\":   \"$CI_COMMIT_REF_NAME\",
          \"status\":   \"$STATUS\",
          \"job\":      \"$CI_JOB_NAME\",
          \"workflow\": \"$CI_PIPELINE_NAME\",
          \"url\":      \"$CI_JOB_URL\",
          \"provider\": \"gitlab_ci\"
        }"
```

---

## Configuring your AI assistant

### GitHub Copilot (VS Code)

Requirements: VS Code 1.99+, GitHub Copilot extension, agent mode.

The `.vscode/mcp.json` in this repo is pre-configured. Open the Mergen project in VS Code, then:

1. Open GitHub Copilot Chat (`Ctrl+Alt+I` / `Cmd+Alt+I`)
2. Switch to **Agent mode** (robot icon)
3. Click **Tools** — Mergen tools appear in the list

For a project-level install in your own repo, create `.vscode/mcp.json`:

```json
{
  "servers": {
    "mergen": {
      "type": "stdio",
      "command": "npx",
      "args": ["mergen-server@latest", "start"]
    }
  }
}
```

Or point at your shared instance:

```json
{
  "servers": {
    "mergen": {
      "type": "http",
      "url": "https://mergen.internal.yourcompany.com/mcp"
    }
  }
}
```

### JetBrains IDEs (IntelliJ IDEA, WebStorm, Rider, PyCharm)

Create `.idea/mcp.json` in your project root (already committed in this repo):

```json
{
  "mcpServers": {
    "mergen": {
      "command": "node",
      "args": ["$PROJECT_DIR$/server/dist/index.js"]
    }
  }
}
```

Or via the JetBrains AI settings: **Settings → Tools → AI Assistant → MCP Servers → Add**.

### Cursor, Claude Code, Windsurf

See [CLAUDE.md](../CLAUDE.md) for per-IDE setup commands. All use the same MCP server binary.

---

## Security posture

**Data never leaves your network.**

- The server binds to `127.0.0.1` by default. Team mode (`MERGEN_BIND=0.0.0.0`) requires explicit opt-in.
- All event data is stored in SQLite on the host filesystem — no external database, no cloud sync.
- The OTLP receiver (`/v1/traces`, `/v1/logs`) accepts standard OTel protocol. No proprietary format.
- Sensitive fields (Authorization headers, cookies, passwords, JWTs, API keys) are redacted **before** the event is written to the buffer — not on read, on write. This means redacted data never appears in any log or AI response.
- Mutating endpoints require an `x-mergen-secret` header. The secret is generated locally on first run and stored in `~/.mergen/secret`.
- DNS rebinding attacks are blocked by Host-header validation on the local server.

**What Mergen does NOT do:**

- Send data to any cloud service
- Require an internet connection to function
- Store data outside the host machine (in the default configuration)
- Record user keystrokes or screen content

---

## The business case: MTTR reduction

The metric enterprise engineering orgs track for developer tooling is **Mean Time to Resolve** (MTTR) — how long from "error reported" to "fix deployed."

The standard path without Mergen:

1. Error appears in Sentry / Datadog
2. Engineer reads the stack trace, guesses at context
3. Engineer asks teammates, checks Slack history
4. Engineer reproduces locally (sometimes takes hours)
5. Engineer fixes and deploys

With Mergen, steps 2–4 collapse. The AI sees the exact causal chain — which request fired, what the backend returned, which commit introduced the regression, which CODEOWNERS team owns the file. It produces a diagnosis grounded in execution data, not static code.

The MTTR impact is largest for the 20% of bugs that are hardest to reproduce — auth timing issues, race conditions, environment-specific failures. These are the bugs that take days. Mergen doesn't eliminate them, but it eliminates the "I can't reproduce it" blocker by capturing what actually happened in the browser at the moment of failure.

---

## Questions

For deployment questions, security review, or enterprise licensing:

- GitHub: [github.com/omertt27/Mergen](https://github.com/omertt27/Mergen)
- Email: omertahtoko@gmail.com
