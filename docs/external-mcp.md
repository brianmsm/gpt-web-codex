# External MCP bridge

GPT Web Codex can act as an MCP client as well as an MCP server. External MCP servers are initialized before GWC publishes its tool catalog to ChatGPT, and allowed remote tools are exposed directly as normal GWC tools.

The bridge is generic. It has no server-specific adapters and does not auto-discover executables, ports, browsers, sockets, or installed MCP packages.

## Supported transports

Version 1 supports:

- MCP over stdio;
- MCP Streamable HTTP.

Legacy SSE, resources, prompts, sampling, elicitation, OAuth UI, roots workflows, task-required tools, hot reload, and server-specific adapters are not supported by this version.

## Configuration

By default GWC reads `~/.codex-chatgpt-web/external-mcp.json`. If `CODEX_CHATGPT_WEB_HOME` changes GWC's configuration directory, the file follows that directory instead. Set `CODEX_CHATGPT_WEB_EXTERNAL_MCP_CONFIG` to an absolute or user-relative path to override the external-MCP file directly.

The file is strict JSON with `version: 1`. Unknown fields and unsupported transports are rejected. See `external-mcp.example.json`.

### stdio example

```json
{
  "version": 1,
  "servers": {
    "my-app": {
      "transport": "stdio",
      "command": "/usr/bin/my-app-mcp",
      "args": [],
      "inherit_env": ["PATH"],
      "env": {
        "MY_APP_MODE": "readonly"
      },
      "tools": {
        "allow": ["status", "search"],
        "deny": ["dangerous_reset"]
      },
      "startup_timeout_ms": 15000,
      "call_timeout_ms": 60000
    }
  }
}
```

GWC does **not** pass its complete process environment to stdio servers. The child receives the MCP SDK's minimal execution baseline, values named explicitly in `inherit_env`, and literal values in `env`. Put secret inheritance behind an explicit `inherit_env` entry; GWC never infers it.

### Streamable HTTP example

```json
{
  "version": 1,
  "servers": {
    "research": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:8765/mcp",
      "required": false,
      "tools": {
        "allow": ["search", "status"]
      }
    }
  }
}
```

URLs may use HTTP or HTTPS. Credentials embedded in URLs are rejected. Interactive OAuth is outside the v1 scope.

## Naming and discovery

For a configured alias `research` and a remote tool `search`, ChatGPT sees:

```text
research__search
```

The bridge keeps the original remote name internally and uses it for `tools/call`. Only the public name is normalized. Aliases, normalized aliases, public tool names, and collisions with native GWC tools are validated at startup. GWC never resolves a collision by silently adding suffixes or hashes.

Tool discovery uses the external server's `tools/list`, including pagination. GWC then applies policy and registers the resulting catalog before connecting its own MCP server to ChatGPT.

## Tool policy

Policy is applied before exposure:

- omitted `allow`: every discovered tool is a candidate;
- `allow: []`: no remote tools are exposed;
- present `allow`: only exact listed remote names are candidates;
- `deny`: removes matching candidates;
- `deny` wins when a name appears in both lists.

There is no generic `external_mcp_call` bypass.

## Required and optional servers

`required` defaults to `false`.

- A failed optional server becomes unavailable; other external servers and native GWC tools continue starting.
- A failed required server aborts GWC startup.
- Naming/schema rejection follows the same required/optional rule.

`enabled` defaults to `true`. A disabled server is not started.

## Schema and result forwarding

GWC uses `@modelcontextprotocol/sdk` 1.x. Remote object input/output JSON Schemas are preserved in the catalog without converting them to a reduced `z.record(z.unknown())` shape. Constraints such as `required`, string/integer types, numeric bounds, `minLength`, nested arrays/objects, and `additionalProperties` survive the bridge.

Calls forward the original argument object to the original remote tool name. Compatible `content`, `structuredContent`, and `isError` are preserved; MCP image content stays image content rather than becoming visible base64 text.

Standard tool title, description, input/output schema, and annotations are forwarded. Arbitrary remote `_meta` is **not** forwarded in tool definitions or call results. GWC attaches only its own safe no-auth metadata at the outward boundary.

## Status and lifecycle

The native read-only tool `external_mcp_status` reports sanitized state for each configured server: alias, enabled/required state, transport, lifecycle, discovered/exposed tool counts, bounded errors, and an owned stdio PID when useful. It does not return configured environment values, tokens, authorization headers, passwords, or complete sensitive configuration.

Startup and calls have independent timeouts. Stdio children created by GWC are owned by GWC and are closed on GWC shutdown; the SDK escalates from stdin close to bounded termination when necessary. Streamable HTTP clients are closed, but GWC never attempts to kill the remote HTTP server.

## Chrome DevTools MCP as an example

Chrome DevTools MCP is not part of the bridge architecture and is not a GWC dependency. It can be configured like any other stdio MCP after choosing and testing an exact package version:

```json
{
  "version": 1,
  "servers": {
    "chrome": {
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@<tested-version>",
        "<connection-options>"
      ],
      "inherit_env": ["PATH"],
      "tools": {
        "allow": [
          "<observational-tool-names-discovered-from-tools-list>"
        ]
      }
    }
  }
}
```

Keep the package version and connection flags explicit. Browser compatibility and the actual tool names belong to the third-party MCP version being used; the GWC bridge does not hardcode them.
