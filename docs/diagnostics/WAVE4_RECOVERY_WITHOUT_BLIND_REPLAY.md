# Wave 4: Recovery without blind replay

## Scope

- Branch: `feat/resilient-mcp-transport`
- Base: `327f2c92c795d1d6d3c32de6de9141e75b2b4a46`
- Wave 3 contract: `docs/diagnostics/WAVE3_RECOVERY_IDEMPOTENCY_CONTRACT.md`
- Goal: recover transport/session/result observation without treating recovery as permission to replay an operation.

Wave 4 does not add generic exactly-once, cross-request deduplication, an operation journal, or a synthetic logical-operation identity.

## Runtime behavior found before Wave 4

### Luna

`LunaJobManager` persisted a local job ID and web-session binding, serialized jobs per web session, and exposed `lastJobId`. However, `run()` automatically launched a second attempt when the first attempt failed, `mutationSeen` was false, and the failure looked transient. `mutationSeen` only becomes true after GWC observes a `file_change` or `command_execution` event. A side effect can therefore occur before the event is observed, so `mutationSeen === false` is not evidence that replay is safe.

On GWC restart, persisted `queued` or `running` Luna jobs were converted to `failed`, which collapsed an uncertain outcome into a known failure. `codexluna_status` and `codexluna_cancel` also accepted a bare `job_id` without checking the current web-session owner.

### Direct terminal jobs

`terminal_start` and `terminal_exec` create one in-memory `TerminalJob` with a random local job ID. `terminal_status`, stdin, and cancellation address that exact job. No code retries or recreates a command after timeout/result uncertainty, and equivalent command payloads are not deduplicated.

The limitation is intentional: if the response containing `job_id` is lost, there is no safe command/args-based lookup. Direct terminal jobs are in GWC memory and are terminated by graceful GWC shutdown, so they are not durable across GWC restart.

### Herdr

Herdr panes are daemon-owned and can outlive GWC. `herdr_pane_run` sends one command to one explicit pane. Observation uses the same pane identity through read, status, and wait. There was no automatic command resend path.

### External MCP

The external MCP bridge calls the selected remote tool once with a bounded request timeout. Timeout/error handling returns an external MCP error and does not call the remote operation again. Remote annotations remain declarative metadata; they are not operation identity or replay authorization.

## Explicit recovery outcome

Wave 4 adds the internal/public Luna recovery classification:

- `known_completion`: GWC observed local completion.
- `known_local_failure`: GWC observed a terminal local failure. This does not imply that no prior side effect occurred and does not authorize replay.
- `running_recoverable`: the same known local job is queued/running and can be observed by its existing identity.
- `ambiguous`: GWC lacks enough evidence to say that the operation did not occur or to say that repeating it is the same logical operation. Local side effects may already have occurred. `ambiguous` is neither success nor automatic failure and never means retryable or safe to replay.

`timed_out` is classified as `ambiguous`. A persisted Luna job found `queued` or `running` after GWC restart is changed to status `ambiguous` with terminal event `runtime_restarted`.

## Implemented changes

### Luna no-blind-replay boundary

The internal transient-looking second attempt was removed. Every `codexluna_start` creates one local job and one execution attempt. A failed/uncertain attempt remains observable but is not automatically replayed, even when no mutation event was observed.

This intentionally narrows recovery rather than disabling it: the caller can still poll the same known job, inspect its outcome, and reuse the durable same-session Luna binding on a later explicitly requested job.

### Luna reacquisition and session scope

`codexluna_session.last_job_id` remains a bounded same-web-session reacquisition aid. If a start response is uncertain, the client is instructed to inspect the current conversation binding and poll that existing job before considering another start.

`last_job_id` is not a logical-operation ID, can be superseded by a later start, does not deduplicate equivalent requests, and must not cross web sessions.

`codexluna_status` and `codexluna_cancel` now resolve the current web session and reject a job owned by another web session. Their public output includes `recovery_outcome`.

### Terminal recovery

No execution mechanism changed because the existing behavior already satisfies the Wave 3 contract: once a job ID is known, recovery polls that exact job and never reconstructs it from command payload. Tool descriptions and MCP instructions now explicitly state the lost-handle limitation and prohibit automatic command/args replay.

### Herdr recovery

No execution mechanism changed. The public contract now explicitly states that ACK/result uncertainty after `herdr_pane_run` is not permission to resend. Recovery preserves pane identity and uses read/status/wait against the same pane.

### External MCP

No bridge execution mechanism changed. The bridge still performs one remote `callTool` for one GWC tool request. MCP instructions now explicitly state that timeout/disconnect/error is not proof that an external mutation did not happen and is not permission for automatic repeat. `readOnlyHint` and `idempotentHint` remain metadata only.

## Retry paths

### Preserved

- Poll/status/read/wait of already known local work.
- Same-session Luna status by known job ID.
- Same-session lookup of `last_job_id` as a reacquisition hint.
- Terminal status/stdin/cancel by exact known terminal job ID.
- Herdr read/status/wait by exact pane ID.
- Transport/session recovery that does not invoke the operation again.

### Restricted or removed

- Removed Luna automatic second execution attempt based on `!mutationSeen` plus transient-looking failure.
- No payload-based terminal reacquisition or replay was added.
- No Herdr command resend was added.
- No external MCP operation retry was added.

## Concurrency and identity

Wave 4 preserves request-instance semantics:

- Equivalent terminal starts create distinct local job IDs and execute independently.
- Existing Wave 1/2 tracing tests continue to require distinct request instances to map to distinct local execution IDs, including request-correlation edge cases.
- Luna status/reacquisition addresses an exact local job ID and validates web-session ownership.
- No global payload map, JSON-RPC-ID dedup, digest dedup, timestamp correlation, or generic `last_*` operation selector was introduced.

## Crash and restart boundaries

| Boundary | Luna | Direct terminal | Herdr | External MCP |
| --- | --- | --- | --- | --- |
| Tunnel reconnect, same GWC process | Known job remains observable | Known job remains observable | Pane remains daemon-owned | Existing bridge process/session remains subject to its own connection lifecycle; no operation replay |
| GWC graceful shutdown | Active Luna child is terminated; persisted incomplete job becomes ambiguous on next startup | Active terminal child is terminated; in-memory handle is lost | Herdr pane is intentionally not terminated | Owned external MCP stdio connections/processes are closed |
| GWC crash/restart | Persisted queued/running job becomes `ambiguous`; binding may survive, execution is not resumed/replayed | No durable recovery promise; handle/process ownership is in-memory | Herdr daemon/pane can survive independently | No generic in-flight result reacquisition or replay promise |
| Different web session | Job/status/cancel access is rejected | No cross-session logical-operation mechanism exists | Explicit Herdr identity/scope rules apply | No GWC cross-request idempotency layer is imposed |

Wave 4 does not promise that process crash and graceful shutdown have identical OS-level cleanup timing. It only defines what GWC may safely claim and replay after restart.

## Public schema changes

- Luna job status now includes `ambiguous`.
- `codexluna_status` accepts optional `web_session_id`, validates job ownership, and returns `recovery_outcome`.
- `codexluna_cancel` accepts optional `web_session_id`, validates job ownership, and returns `recovery_outcome`.
- Tool descriptions/instructions document same-session reacquisition and no-replay boundaries.

No terminal, Herdr, or external-MCP result schema was expanded with speculative ambiguity fields because those layers do not expose a new reliable ambiguity detector in this wave.

## Tests added or strengthened

- A transient-looking Luna failure with an actual side effect but no observed mutation event executes exactly once (`attempts === 1`).
- Interrupted persisted Luna work becomes public `ambiguous`, not false `failed`.
- Luna status rejects a job from another web session and another session does not inherit `last_job_id`.
- Two equivalent concurrent terminal starts remain distinct jobs and produce distinct processes/results.
- Herdr/MCP instructions explicitly forbid automatic resend after uncertain `pane_run` acknowledgement/result.
- Existing request-trace/harness and external-MCP timeout regression tests remain green.

## Known limits

Without an upstream logical-operation/idempotency key, GWC still cannot safely determine that two separate requests are the same logical operation. Therefore it cannot safely:

- recover a terminal job whose initial `job_id` response was lost by matching command/args;
- deduplicate two Luna starts by prompt/settings;
- replay a completed result across distinct requests;
- retry an external mutation after an ambiguous timeout;
- provide generic exactly-once semantics.

## Wave 5 recommendation

If upstream can provide a trusted logical-operation identity/idempotency key with explicit scope and replay semantics, Wave 5 can evaluate a bounded operation journal and result reacquisition keyed only by that authoritative identity. Until then, preserve the Wave 4 boundary: observe known work, recover transport/session state, and never infer replay safety from payload equality or missing evidence.
