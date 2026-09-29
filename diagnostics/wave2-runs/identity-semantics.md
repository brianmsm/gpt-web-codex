# Wave 2 — Request identity and lifecycle semantics

Status: tracing groundwork only.

Scope:

- identify available request identities;
- record lifecycle boundaries when opt-in tracing is enabled;
- do not implement retry, replay handling, deduplication, or idempotency.

## Current evidence

| Layer | Identifier | Status |
|---|---|---|
| Connector/control plane | not observed in GWC | unknown |
| Tunnel | request/cmd/rpc identifiers from Wave 1 recorder | observed externally |
| JSON-RPC | MCP request id exposed as SDK request id | observed |
| MCP session | not yet exposed as stable identity | unknown |
| GWC | SDK request id, tool name, local execution id | observed |
| Local execution | terminal job id and process identity | observed |

## Interpretation

A tunnel request id identifies a transport request. It is not sufficient evidence of a stable logical operation identity. A future retry/deduplication design requires a higher-level identity supplied by an upstream layer or introduced explicitly.

## Tracing

The opt-in lifecycle tracer emits only when `CODEX_CHATGPT_WEB_MCP_TRACE_FILE` is set.

Events include:

- wall clock timestamp;
- monotonic timestamp;
- request identity fields available at the layer;
- dispatch correlation fields when provided.

No command contents, secrets, tokens, or files are recorded.
