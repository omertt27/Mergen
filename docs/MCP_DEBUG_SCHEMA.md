# Mergen MCP Debugging Event Schema — Open Specification v1.0

> We are publishing this schema as an open standard. Any debugging tool that implements this schema is compatible with the Mergen MCP server and can be queried by any MCP client.

This document describes the event payloads, ingest contract, and MCP tool interfaces used by Mergen. The goal is interoperability: browser extensions, embedded WebViews, SDKs, and other debugging tools should be able to emit the same core event model and immediately benefit from the same analysis and MCP workflows.

## Design Goals

- **Local-first:** events are designed to be sent to a localhost ingest service.
- **Transport-agnostic:** any producer that can POST JSON can participate.
- **Schema-light, analysis-friendly:** the format is explicit enough for tooling while remaining easy to generate from browser runtimes.
- **Privacy-aware:** sensitive fields should be redacted at the edge before storage or transport.

## Event Types

All events are JSON objects. Timestamps are Unix epoch milliseconds.

### 1. `ConsoleEvent`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/omertt27/Mergen/schema/console-event.json",
  "title": "ConsoleEvent",
  "type": "object",
  "additionalProperties": false,
  "required": ["type", "level", "args", "url", "timestamp"],
  "properties": {
    "type": {
      "const": "console"
    },
    "level": {
      "enum": ["log", "warn", "error"]
    },
    "args": {
      "type": "array",
      "items": {}
    },
    "stack": {
      "type": "string"
    },
    "url": {
      "type": "string"
    },
    "timestamp": {
      "type": "number"
    }
  }
}
```

**Notes**
- `args` preserves raw console arguments as closely as possible.
- `stack` is optional because many console calls do not include a stack trace.
- `url` should identify the page context that emitted the event.

### 2. `NetworkEvent`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/omertt27/Mergen/schema/network-event.json",
  "title": "NetworkEvent",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "type",
    "method",
    "url",
    "status",
    "statusText",
    "duration",
    "timestamp"
  ],
  "properties": {
    "type": {
      "const": "network"
    },
    "method": {
      "type": "string"
    },
    "url": {
      "type": "string"
    },
    "status": {
      "type": "number"
    },
    "statusText": {
      "type": "string"
    },
    "duration": {
      "type": "number"
    },
    "requestBody": {},
    "requestHeaders": {
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    },
    "responseBody": {},
    "responseHeaders": {
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    },
    "error": {
      "type": "string"
    },
    "timestamp": {
      "type": "number"
    }
  }
}
```

**Notes**
- `status` should be set even for HTTP failures; use `error` for transport-level failures.
- Producers may omit bodies or headers if unavailable, redacted, or too large.
- `duration` is measured in milliseconds.

### 3. `ContextSnapshot`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/omertt27/Mergen/schema/context-snapshot.json",
  "title": "ContextSnapshot",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "type",
    "trigger",
    "timestamp",
    "url",
    "title",
    "localStorage",
    "sessionStorage"
  ],
  "properties": {
    "type": {
      "const": "context"
    },
    "trigger": {
      "enum": ["error", "warn", "pageload", "hmr", "baseline", "manual"]
    },
    "timestamp": {
      "type": "number"
    },
    "url": {
      "type": "string"
    },
    "title": {
      "type": "string"
    },
    "activeElement": {
      "type": "string"
    },
    "component": {
      "type": "string"
    },
    "localStorage": {
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    },
    "sessionStorage": {
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    }
  }
}
```

**Notes**
- `ContextSnapshot` is intended to capture immediate browser state around a trigger.
- `component` is optional and may be populated by framework-aware integrations.
- Storage values should be redacted before emission where necessary.

## Ingest Endpoint

### `POST /ingest`

**Headers**

```http
Content-Type: application/json
```

**Body**
- A single event matching one of the schemas above.
- Implementations may also accept batched envelopes in the future, but v1.0 assumes one event per request.

**Response**

```http
204 No Content
```

**Behavior**
- The ingest service should validate payload shape before storing.
- Invalid payloads should be rejected with an appropriate 4xx response.
- A local-first deployment should bind the server to `127.0.0.1` only.

## MCP Tools

The MCP server exposes a small, composable surface area over the retained event buffer.

### `get_recent_logs`

**Parameter schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "get_recent_logs.params",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200,
      "default": 20
    },
    "level": {
      "enum": ["error", "warn", "log"]
    },
    "since": {
      "type": "number",
      "description": "Unix epoch milliseconds"
    }
  }
}
```

**Returns**
- Array of `ConsoleEvent` objects, sorted oldest to newest after filtering.

### `get_network_activity`

**Parameter schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "get_network_activity.params",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200,
      "default": 20
    },
    "status_filter": {
      "type": ["integer", "string"],
      "description": "Specific HTTP status to filter, for example 404 or 401"
    },
    "since": {
      "type": "number",
      "description": "Unix epoch milliseconds"
    }
  }
}
```

**Returns**
- Array of `NetworkEvent` objects, sorted oldest to newest after filtering.

### `clear_buffer`

**Parameter schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "clear_buffer.params",
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

**Returns**
- Confirmation object or message indicating that the in-memory buffer has been emptied.

## Rate Limits

Mergen v1.0 assumes a **100 events/second token bucket** on the ingest endpoint. Implementations may choose different burst sizes, but the reference behavior is:

- steady refill: 100 tokens per second
- one event consumes one token
- requests above the available token count are rejected or dropped

This rate limit is intended to protect local analysis loops from accidental flood conditions such as runaway logging, broken polling loops, or HMR storms.

## Compatibility

Any tool that can POST JSON to `/ingest` is compatible. We welcome pull requests from other browser extension authors.

Examples of compatible producers:
- Chrome extensions
- injected scripts in desktop WebViews
- mobile debugging bridges
- framework devtool adapters
- synthetic repro harnesses

## Versioning

This specification is versioned at the document level as **v1.0**. Events do not currently require an explicit `schemaVersion` field, but implementations may add one in a backward-compatible future revision if multiple event shapes must coexist.

If a future version introduces an event-level schema version, producers should include a top-level field such as:

```json
{
  "schemaVersion": "1.1"
}
```

Until then, compatibility should be determined by shape validation against the event type schemas defined here.

---

GitHub: https://github.com/omertt27/Mergen
