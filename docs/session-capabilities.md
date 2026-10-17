# Session Capability Profiles

**Status: experimental, opt-in, GWC-side feature.** This is a general permission system for any GPT Web Codex conversation, not a special-purpose research or rater adapter. It does not change existing conversations or MCP tools when disabled. Start with the [general operator guide](session-capabilities-operations.md) for safe opt-in deployment, validation and rollback boundaries.

## What it does

Session Capability Profiles give a GWC operator reusable, versioned per-conversation allowlists. A profile defines:

- **GWC native tools** whose names can be invoked (an exact allowlist);
- **external MCP tools** whose names can be invoked (also exact);
- **an optional private MCP registry** containing stdio servers launched separately for that conversation;
- **a supervisor-owned binding** from the current conversation identifier to the profile.

Denied native/global/external methods are rejected at the MCP dispatcher even if a cached or stale tool catalog names them. **The real ChatGPT client was observed to send a single `tools/list` with no `openai/session`; therefore the recommended experimental `catalog_mode: "shared"` publishes one stable catalog but still rejects unauthorized `tools/call` invocations.** Users can see more tools than they may execute. A second `catalog_mode: "per_session"` retains experimental per-session listings for clients that send a trusted identity with each `tools/list`, but this was **not observed with ChatGPT**.

**Neither mode should be used to claim strict independent evaluator isolation in a single ChatGPT app.** In shared mode the external MCP bridge's global processes and data are shared even when call names are restricted. In both modes, absent session identity on `tools/call` denies access instead of silently inheriting unrestricted privileges.

This feature cannot enforce arbitrary path scopes for `file_read`, `file_write`, `terminal_exec`, Herdr or Luna. A tool allowed by exact name retains its native arguments and authority. For scoped reads or automation, create a purpose-built narrow external MCP and use an OS sandbox. Allowing delegation tools deliberately grants powerful delegation capabilities.

## Use cases

| Profile | Tools allowed | Purpose |
|---|---|---|
| `default` / legacy | Existing GWC tools | Normal work. Enabled implicitly when the feature flag is absent, or selected explicitly by a supervisor |
| `no-tools` | None | A conversation with no callable GWC tools |
| `diagnostics-only` | `herdr_status` | Daemon health without shell or general file access; note that daemon status is global metadata |
| `document-reader` | `reader__list`, `reader__read` | Separate sandboxed, read-only document MCP for a particular conversation |
| `controlled-automation` | `jobs__status`, `jobs__submit` | Task-scoped external MCP with its own authorization and validation |
| `isolated-evaluator` | An application-defined tool set | Blind A/B raters; nothing about A/B is hardcoded into GWC |

These examples show composition, **not ready-made filesystem-safe policies**. The `reader` and `jobs` servers must actually implement the stated restrictions; GWC only enforces which tools can be called.

## Configuration: independent from global external MCP

Use [session-capabilities.example.json](../session-capabilities.example.json) as a minimal, valid starting template. It uses `default_policy: "legacy"` and `catalog_mode: "shared"` so unbound conversations retain the familiar GWC operations while selected chats are restricted at execution. To default-deny unknown conversations in a dedicated instance, use `default_policy: "deny"`; only `capability_identity` is callable for enrollment (although in shared mode the full tool inventory remains visible).

All fields are exact and strict:

```json
{
  "version": 1,
  "default_policy": "legacy",
  "catalog_mode": "shared",
  "max_external_sessions": 8,
  "profiles": {
    "diagnostics-only": {
      "version": 1,
      "native_tools": ["herdr_status"],
      "external_tools": []
    },
    "document-reader": {
      "version": 1,
      "native_tools": [],
      "external_tools": ["research__search"]
    }
  },
  "session_bindings": {}
}
```

The sample `research__search` in shared mode refers to a tool registered in the **normal global** `external-mcp.json`; it is only a permission example, not an automatically installed server. It must be replaced by an actual trusted global tool. Since its backend is shared, do not use it for private A/B evaluator outputs or secrets without independent backend enforcement.

For a **different** MCP client that reliably passes session metadata to `tools/list`, opt in to `"catalog_mode": "per_session"`: here `external_mcp_config` can point to an ordinary version-1 external MCP JSON file containing only session-restricted stdio servers. Each session receives a separately launched bridge, but ChatGPT did **not** demonstrate the required per-conversation discovery. Enabling `external_mcp_config` in `"shared"` mode is rejected at startup rather than exposing an unusable or misleading private server.

Any private MCP registry path in a profile is illustrative; create the appropriate external MCP JSON before validating the profile. This setting is for session-aware clients in `per_session` mode, **not** a way to get per-chat ChatGPT catalogs in `shared` mode. Each bound profile is frozen until a deliberate GWC restart, and the policy digest covers both the selected permissions and the external registry contents. Using the feature does **not** modify unrelated global external MCP server configurations.

## Operations

Prepare a configuration in a protected local directory. Prefer `0700` for the directory and `0600` for the JSON files. GWC refuses symlink-based and group/world-writable capability configurations, while Windows ACL verification still requires the operator. Use the CLI from an administrator-controlled terminal, **not** as a tool offered to restricted model sessions.

```sh
cp session-capabilities.example.json /private/config/session-capabilities.json
chmod 600 /private/config/session-capabilities.json
gpt-web-codex capabilities check --config /private/config/session-capabilities.json
```

Enabling the feature requires an explicit process environment setting and a restart:

```sh
export CODEX_CHATGPT_WEB_SESSION_CAPABILITIES_CONFIG=/private/config/session-capabilities.json
# Start GWC through the existing launcher/runtime management mechanism.
```

To enroll a conversation:

1. In a new, not-yet-restricted conversation, use `capability_identity`. This **reports** the SHA-256-based `chatgpt:...` identifier; it does not assign a policy. The server must actually receive `openai/session` for this to work.
2. From a local supervisor terminal, run:

```sh
gpt-web-codex capabilities bind \
  --config /private/config/session-capabilities.json \
  --session-key chatgpt:<64-lowercase-hex> \
  --profile document-reader
```

3. Restart GWC intentionally; the binding takes effect only then.
4. Inspect the configured binding offline:

```sh
gpt-web-codex capabilities check \
  --config /private/config/session-capabilities.json \
  --session-key chatgpt:<64-lowercase-hex>
```

An existing session cannot silently switch profiles. The admin command rejects changing an existing binding unless the local supervisor supplies `--replace`. Concurrent admin updates use an exclusive local `.lock` file and atomic replacement; if an administrator is interrupted, inspect the stale lock before removing it manually. The application does not expose a policy mutation tool to ChatGPT.

The `capability_identity` tool is also available in legacy mode *only when this opt-in feature is active*. For restricted profiles it is not shown unless explicitly allowlisted, allowing an evaluator catalog to contain exactly the intended tools.

## Discovery modes and practical boundary

| Setting | Catalog visible in ChatGPT | Enforcement | Suitable for |
| --- | --- | --- | --- |
| `catalog_mode: "shared"` | Shared, static inventory for all chats | Exact per-session authorization at `tools/call` | General GWC native/global tools; **not strict A/B** |
| `catalog_mode: "per_session"` | Only tools permitted to a chat, **if** the client sends session metadata during discovery | Exact per-session authorization | Compatible custom clients; not validated with ChatGPT |
| No feature flag | Normal full GWC catalog | Existing GWC policy | Production default |

A `catalog_mode: "shared"` profile can include exact native GWC tools and/or selected globally registered external MCP names. It cannot include a session-private `external_mcp_config`. `catalog_mode: "per_session"` can use private stdio MCP servers, but needs trusted per-chat `tools/list` metadata. The default for **older** configs omitting `catalog_mode` remains `"per_session"` for compatibility with prior experimental tests; always set the mode explicitly when preparing a new config.

## Architecture and isolation

```text
ChatGPT conversation -> GWC MCP boundary -> resolve claimed session
                                            |
                              supervisor-owned policy lookup
                                            |
                         +------------------+------------------+
                         |                  |                  |
                      legacy         restricted profile    unbound/deny
                         |                  |                  |
                  original tools       exact allowlist   enroll identity only
                                            |
                                isolated external stdio MCP
                                            |
                              OS confinement (if required)
```

The runtime reuses the existing SDK registration logic but intercepts both `tools/list` and `tools/call`, and blocks other MCP request types for restricted sessions. In shared mode `tools/list` remains global and is not filtered; in per-session mode both surfaces are filtered. External MCP children are started on demand, keyed by session and capped by `max_external_sessions`. They are stopped on GWC shutdown. Reliable ChatGPT conversation-close events are not available, so automatic immediate per-chat process cleanup is **not** claimed.

## Security and platform boundaries

**Critical:** `openai/session` is request metadata. GWC can hash it and compare it to a supervisor-assigned binding, but cannot by itself prove that ChatGPT or another client has authenticated it. A raw MCP client can forge metadata and impersonate another session. Do not put GWC behind an untrusted raw MCP endpoint and treat this as a multi-tenant security boundary.

Further limitations:

- The real ChatGPT client may cache a global MCP tool list, omit session metadata during discovery, or route catalog requests differently. GWC cannot force per-chat refresh or bind external platform tools.
- Other ChatGPT plugins, browser access, uploaded files, product Memory and conversation context are not disabled by this feature.
- The native GWC tools are not filesystem-sandboxed merely because only some names are allowed. Narrow external MCP gateways should enforce path and operation scope themselves; use Bubblewrap, containers, OS permissions, or equivalent isolation.
- Disabling network in an external sandbox does not prevent an authorized tool's **returned text** from reaching the remote LLM provider.
- Two independent MCP children do not prove independent LLM memories or blinded experimental judgment.

**Go/no-go:** shared-catalog dispatch enforcement passes synthetic tests, but strict ChatGPT A/B evaluator isolation remains **NO-GO with one connector**. Two independent role-specific connectors or two tightly configured direct LLM clients are preferable. Read [security limitations and A/B acceptance gates](session-capability-isolation.md) for the detailed red-team matrix.

## Verification

Run the generic integration tests against synthetic data and with a clean, isolated external MCP configuration:

```sh
bun run typecheck
bun test tests/session-capabilities.test.ts tests/session-capabilities-admin.test.ts
```

Session Capability Profiles enforce exact tool-name authorization at the GWC dispatcher, not OS command confinement or authenticated session identity. A shared catalog may list tools a given session cannot call; per-session discovery requires trustworthy metadata on the `tools/list` request and is not generally established for ChatGPT.

Historical deployment-specific reports, actual conversation identifiers, scientific evaluation workflows, machine-local wrapper paths and runtime keys are intentionally excluded from the public release. Reproduce any security claim with a disposable test harness and narrow fixture. See the [security boundary analysis](session-capability-isolation.md) and [operator guide](session-capabilities-operations.md).
