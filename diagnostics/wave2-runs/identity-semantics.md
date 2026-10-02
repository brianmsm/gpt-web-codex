# Wave 2 — Request identity and lifecycle semantics

Status: runtime identity/lifecycle tracing wired and validated. This wave remains diagnostic-only: no retry, reconnect, deduplication, idempotency, request journal, exactly-once mechanism, mutation protection, or transport migration is implemented.

## Runtime tracing architecture

Tracing is opt-in through `CODEX_CHATGPT_WEB_MCP_TRACE_FILE`. With the variable unset, no trace file is created and the tracing path returns immediately. Wave 2 emits `gwc-mcp-trace/v2`; Wave 1 evidence remains historical `v1` and is not reinterpreted under the new canonical field names.

For `terminal_exec`, GWC now observes these real runtime boundaries:

1. `request_received` — the MCP tool handler is entered. The SDK `extra.requestId` is recorded canonically as `jsonrpc_request_id`.
2. `execution_started` — the local terminal job exists and its execution UUID/PID are known.
3. `execution_finished` — the owned local job completed. This event is absent if `terminal_exec` returns while the job is still running.
4. `response_created` — the MCP SDK has constructed a JSON-RPC response and calls `StdioServerTransport.send()`.
5. `response_handed_to_stdio` — `StdioServerTransport.send()` resolved after stdout accepted the write immediately or after its `drain` event.

The last event is deliberately **not** called `response_delivered`. It proves only the GWC stdio transport boundary. It does not prove that tunnel-client received the bytes, that `PostResponse` succeeded, that control-plane accepted the result, or that the caller observed it.

The Wave 1 `response_returned` phase remains for continuity and means only: the tool handler produced a result and returned it to the MCP SDK. It occurs before the SDK creates/sends the JSON-RPC response.

## Trace integrity and privacy

Lifecycle fields are explicitly allowlisted. There is no open `Record<string, unknown>` extension point and callers cannot override `schema`, `event_type`, `jsonrpc_request_id`, or other reserved fields through arbitrary identity data.

Recorded identity fields are limited to:

- `jsonrpc_request_id`;
- tool name;
- diagnostic `boundary_dispatch_id`;
- MCP transport session ID when the transport exposes one (stdio currently yields `null`);
- controlled `trace_tag` and sanitized input digest;
- GWC process identity;
- local execution UUID/PID/starttime;
- terminal status and exit code.

No command body, result payload, file contents, Authorization header, token, or arbitrary metadata is serialized.

## Canonical JSON-RPC identity

With MCP SDK 1.30.0, `RequestHandlerExtra.requestId` is explicitly the JSON-RPC request ID and the SDK copies `request.id` into the response `id`. Wave 2 therefore uses one canonical field:

`jsonrpc_request_id`

There is no independently supplied `sdk_request_id` or `jsonrpc_id` in the lifecycle schema.

A JSON-RPC ID is a request/response correlation identifier. It is **not** treated as a logical-operation or idempotency identity. Wave 1 already demonstrated two distinct tunnel requests carrying the same JSON-RPC ID `0` and producing two local executions.

### Correlation limit at the stdio response boundary

The request-specific correlation is strongest from MCP receipt through `response_returned`, where `boundary_dispatch_id`, `trace_tag`, and `local_execution_id` are still present.

At `response_created` and `response_handed_to_stdio`, the stdio transport receives only the already-built JSON-RPC response. The trace can therefore retain `jsonrpc_request_id`, but it no longer has the request-specific dispatch/execution fields.

When `jsonrpc_request_id` is unique among live requests, the response-side events can be associated operationally with that request. When two live requests reuse the same JSON-RPC ID, the current GWC-side evidence cannot attribute each `response_created` / `response_handed_to_stdio` event uniquely to a particular `boundary_dispatch_id` or `local_execution_id`. Completion-time proximity is not treated as an identity contract.

This is a diagnostic finding, not a request for Wave 2 to invent a stronger correlator. It further demonstrates that JSON-RPC identity is insufficient as an authoritative logical-operation identity.

## Identity matrix

| Layer | Identifier | Stable across retry? | Evidence |
|---|---|---|---|
| Connector / caller | none observed | unknown | No caller/product invocation ID is exposed to GWC or captured in Wave 1/2. |
| Control plane | `cmd_request_id` exists at tunnel boundary | not demonstrated | Wave 1 observed full values such as `3c53.../djiq` and `3c53.../f9gm`; the shared prefix is undocumented and the full IDs differ. |
| Tunnel | `request_id` | no for the observed duplicate pair | Wave 1 classification B used two distinct tunnel `request_id` values. |
| JSON-RPC | `jsonrpc_request_id` / tunnel `rpc_request_id` | not a logical-operation key | SDK 1.30.0 maps `extra.requestId == request.id`; Wave 1 observed the same RPC ID `0` on two distinct tunnel requests. |
| MCP session | transport `sessionId` when available | unknown | Stdio transport exposes no stable MCP session ID in these runs; traced value is `null`. |
| GWC boundary | `boundary_dispatch_id` | no for distinct dispatches | Diagnostic UUID injected once per tunnel-to-GWC dispatch; Wave 1 and Run B show distinct values. |
| Local execution | terminal job UUID + PID/starttime | no | Every new `terminal_exec` starts a distinct owned local execution. |

## Run A — control normal

Evidence: `run-a-control.ndjson`.

One controlled invocation produced one complete local chain:

```text
jsonrpc_request_id: 1
boundary_dispatch_id: 11111111-2222-4333-8444-555555555555
trace_tag: wave2-run-a
local_execution_id: df66385f-789e-4433-b499-ce2553b559ba

request_received
  -> execution_started
  -> execution_finished
  -> response_created
  -> response_handed_to_stdio
```

The trace also contains JSON-RPC ID `0` for MCP initialization response transport events. It is not a `terminal_exec` execution.

## Run B — controlled equivalent dispatches

Evidence: `run-b-equivalent-dispatches.ndjson`.

This run intentionally issued the same controlled `terminal_exec` input twice. It is a controlled equivalence test, **not** evidence that the second request was a retry, replay, or redispatch generated by ChatGPT/control-plane/tunnel-client.

Both requests have the same sanitized input digest:

`ad9d21d5def5f5590af9bebe9d77bf6f5849541ede22ec6494bd34a213591188`

but distinct identities:

| Request | JSON-RPC ID | boundary_dispatch_id | local execution ID |
|---|---:|---|---|
| A | 1 | `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee` | `bc6bf6ab-c48d-4590-a5dc-f73aafff4a40` |
| B | 2 | `99999999-8888-4777-8666-555555555555` | `d59fe5d3-ff69-4c9a-b812-9df0a95eeefc` |

Each request independently reached:

`request_received -> execution_started -> execution_finished -> response_created -> response_handed_to_stdio`.

In this controlled run the two requests used distinct JSON-RPC IDs, so the stdio response-side events are distinguishable by `jsonrpc_request_id`. This run does not establish that the same attribution would remain possible if two concurrent requests reused the same JSON-RPC ID.

This demonstrates that equivalent inputs do not create a shared logical-operation identity in GWC.

## Required questions

### 1. Is there a stable identifier between request A and B?

No authoritative logical-operation identifier has been demonstrated. Wave 1 showed that tunnel `request_id` and `boundary_dispatch_id` change. The full `cmd_request_id` also changes. A shared textual `cmd_request_id` prefix was observed, but tunnel-client v0.0.10 does not document it as an operation or idempotency identity.

### 2. Can the same JSON-RPC ID belong to distinct operations?

Wave 1 directly observed two distinct tunnel requests, each causing a distinct local execution, while both carried JSON-RPC ID `0`. Therefore equality of JSON-RPC ID does not prove equality of logical operation.

The SDK uses that value to correlate one JSON-RPC request with its response; Wave 2 assigns it no stronger semantics.

### 3. Can the same `cmd_request_id` change suffix/attempt?

Wave 1 observed the same textual prefix with different full values, for example:

- `3c53f827-65e8-4c4c-959d-f6ad0c9b8266/djiq`
- `3c53f827-65e8-4c4c-959d-f6ad0c9b8266/f9gm`

So the suffix changed. There is no evidence that the suffix specifically means “attempt”, and no documented guarantee that the shared prefix is a stable logical-operation ID.

### 4. Is there an identity above tunnel `request_id`?

`cmd_request_id` is an upstream/control-plane correlation field, but no captured documentation or runtime evidence establishes it (or its prefix) as the authoritative logical-operation identity. No higher caller/invocation ID is exposed to GWC.

### 5. Can a lost result be associated with the execution that produced it?

Locally, the producing execution can be attributed strongly through `response_returned`: `boundary_dispatch_id`, `trace_tag`, and `local_execution_id` remain available on that request path.

The later GWC stdio boundary is weaker. `response_created` and `response_handed_to_stdio` retain only `jsonrpc_request_id`. If that ID is unique among live requests, the response can be associated operationally with the request. If two concurrent requests reuse the same JSON-RPC ID, Wave 2 does not have enough identity at the stdio transport to attribute each response-side event uniquely to the execution that produced it.

That does **not** establish remote acceptance in either case. Wave 1's response-POST evidence remains the authority for tunnel delivery semantics: HTTP 200 proves accepted response delivery; timeout leaves remote acceptance unknown; HTTP 404 remains semantically ambiguous without stronger upstream evidence.

### 6. Is there enough information for safe deduplication?

No. Current identifiers support observation and correlation, not recognition of “the same authoritative logical operation” across distinct requests. Input digest equality is deliberately not an idempotency key.

### 7. Which layer must provide additional identity?

The caller/control-plane boundary must provide a stable logical operation/invocation ID and propagate it unchanged across any retry/redispatch if Wave 3 wants safe cross-request deduplication.

A GWC-generated ID created only after a request arrives can identify that receipt, but cannot by itself tell whether a later independent request represents the same upstream intention unless that identity is echoed back by the upstream contract.

## Classification

**Case C — partial identity.**

Wave 2 has strong request-specific correlation from MCP receipt through local execution and `response_returned`. The later GWC stdio response boundary is observable, but its attribution is only unambiguous while `jsonrpc_request_id` is unique among concurrent live requests. If the same JSON-RPC ID is reused concurrently, `response_created` and `response_handed_to_stdio` cannot be joined uniquely back to a particular dispatch/execution with the identities exposed at that layer.

It also still lacks an authoritative identity that is stable across separate upstream requests/retries. Therefore Wave 3 may reason about per-request lifecycle and ambiguous-result windows, but safe cross-request deduplication requires an additional upstream logical-operation identity (or an equivalent explicit contract). No dedup/journal design is implemented in this wave.
