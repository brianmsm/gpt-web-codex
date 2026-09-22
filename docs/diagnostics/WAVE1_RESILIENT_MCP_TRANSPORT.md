# Wave 1 resilient MCP transport causal attribution

Wave 1 is diagnostic-only. It does not implement request deduplication, replay,
retry, session reacquisition, transport redesign, or any Wave 2 resilience
behavior.

## Result

The duplicate local execution seen in Wave 0 is reproduced and attributed above
the local GWC dispatch boundary.

The accepted Proton fault run produced three exact executions of the same tagged
terminal_exec command. The correlated wire sequence for the same caller-side
cmd_request_id was:

| Local execution | tunnel request_id | cmd_request_id | JSON-RPC id | Classification |
|---|---|---|---:|---|
| #1 | cmd_5495a840_0d57_43e1_9dbe_791ced7781bf | 82562ce5-bca1-4eb5-9831-b86a80ffc1c4/y8ht | 0 | original |
| #2 | cmd_8bcf9c01_550c_47d2_b3c2_3a2a064f4b09 | 82562ce5-bca1-4eb5-9831-b86a80ffc1c4/y8ht | 0 | B: new tunnel request, same RPC id |
| #3 | cmd_50ef2372_5662_4d4d_b70b_40ff8f543436 | 82562ce5-bca1-4eb5-9831-b86a80ffc1c4/y8ht | 1 | C: new tunnel request, new RPC id |

This rules out both local-only explanations targeted by Wave 1:

- not A: the duplicate executions do not reuse one tunnel request_id;
- not D: one tunnel request is not being dispatched locally more than once.

The stable cmd_request_id ties the sequence to one caller-side correlation,
while fresh tunnel request IDs prove redelivery/retry above the local GWC tool
dispatch. The evidence does not distinguish which remote/product component owns
retry scheduling, so it is intentionally not attributed more narrowly to
ChatGPT, the control plane, or another caller-side layer.

## Exact tunnel-client version and source

The active bundled client used for the diagnostic was:

    0.0.10+105e17a79a36e4e5c897fd698ed2b8dbf935b144

The v0.0.10 source archive corresponding to commit
105e17a79a36e4e5c897fd698ed2b8dbf935b144 was inspected locally under the
ignored Wave 1 evidence tree.

Relevant v0.0.10 behavior:

- a polled command has a tunnel request_id, JSON-RPC body, channel, created_at,
  headers, and shard token;
- JSON-RPC correlation is logged as rpc_request_id;
- caller/control-plane correlation is logged as cmd_request_id;
- response POST HTTP correlation is logged separately as tunnel_request_id;
- poll failures retry with backoff;
- PostResponse itself performs one HTTP request per invocation; it has no
  response replay loop in v0.0.10;
- HTTP 200 is successful response delivery;
- HTTP 404 is treated as an already-fulfilled/unknown request and returns
  success to the dispatcher;
- the "dispatcher forwarded command to MCP server" INFO log occurs only after
  forwardResponses returns, including any response POST wait. Therefore that
  timestamp is an end-of-processing marker, not dispatch-start time.

There is no request-specific response_timeout field in the v0.0.10 command wire
shape. Individual created_at values are not emitted in the safe
request-correlated logs used here, so neither value is invented in this report.

## GWC request tracer

Wave 1 adds opt-in diagnostic tracing for terminal_exec through the environment
variable CODEX_CHATGPT_WEB_MCP_TRACE_FILE.

Tracing is disabled by default. The schema is gwc-mcp-trace/v1 and records:

- wall clock and monotonic clock;
- GWC PID and /proc starttime;
- the actual MCP SDK RequestHandlerExtra.requestId;
- tool name;
- an explicit non-secret trace tag when present;
- a deterministic digest of sanitized controlled fields;
- the real DirectToolService execution/job id;
- local PID and process starttime when available;
- terminal status and exit code;
- phases received, execution_started, execution_finished, and response_returned.

The raw command is never written by the tracer. The digest does not hash the raw
command or arbitrary user input. It is built only from controlled sanitized
fields such as tool, cwd/workspace, wait timeout, permission mode, and the
explicit safe trace tag. Trace-file failures are fail-open and do not change the
tool result.

No public MCP tool, catalog entry, schema, or tools/list surface was added or
changed by the tracer.

## Observability boundary in v0.0.10

The following local endpoints requested during planning do not exist in
v0.0.10:

    /health/control-plane
    /health/response-delivery
    /health/queue
    /health/dispatcher
    /health/mcp

Wave 1 used the available safe surfaces instead:

    /healthz
    /readyz
    /api/status
    /api/log-level
    /metrics

plus structured tunnel-client logs and the GWC NDJSON tracer.

The status endpoint exposes client instance identity, uptime,
channel/transport state, and the stdio child PID, but not a child_generation or
initialize_epoch. Those fields are therefore recorded as unavailable rather
than inferred.

Mcp-Session-Id was not present in the correlated safe events. No session id is
invented.

## Normal baseline

Tag: W1_BASE_20260922_A.

The baseline produced exactly one chain:

    one tunnel command
      -> rpc_request_id 0
      -> one GWC received phase
      -> one local execution
      -> one execution result
      -> one response POST
      -> HTTP 200 delivery

Correlated identities:

    tunnel request_id:   cmd_487b11cf_64ac_4426_b9d3_2435ada46281
    cmd_request_id:      212b2489-60b1-49ef-b893-5aca910a44ab/siku
    rpc_request_id:      0
    local execution id:  da962e91-21d0-42b4-bd5a-005178d0a896
    local PID:           2891542
    response HTTP id:    req_6ba0696e751f491aba9bf38834e4c4ae
    response status:     200

The GWC trace spans 12:22:43.419 to 12:22:45.500 Europe/Madrid. The response
was accepted by the control plane at 12:22:45.667.

This baseline demonstrates that the tracing layer does not itself create an
extra local dispatch or response attempt.

## Accepted Proton fault run

Raw evidence directory, intentionally ignored by Git:

    diagnostics/wave1-runs/session-20260922/
      fault2c-20260922T161452+0200/

Tag: W1_FAULT2C_161452.

The existing Wave 0 physical-transition evaluator was re-used against the fault
samples and returned:

    transition_valid: true
    classification_allowed: true
    kill_switch_window_ms: 7409
    initial proton0: absent
    initial pvpnksintrf0: absent
    proton0 observed during kill switch: true
    final proton0: present
    final pvpnksintrf0: absent
    final public reachability: true
    IPv4 default route changed: true
    ip rule changed: true

The kill-switch interval was observed from 16:22:44.035 through
16:22:51.444 Europe/Madrid.

### First execution

GWC directly traced the first execution:

    received:            16:22:43.563
    execution_started:   16:22:43.592
    execution_finished:  16:23:03.732
    response_returned:   16:23:03.733
    GWC PID/starttime:   111178 / 31408210
    local execution id:  d1f2872f-0569-4547-a751-b49fcd0556ff
    local PID/starttime: 159328 / 31471676
    SDK request id:      0

The independent recorder sees the same tagged shell from 16:22:44.035 through
16:23:03.518, so the local command survived the complete physical Proton
kill-switch interval.

Tunnel-client then received the MCP response at 16:23:03.736 for:

    request_id:      cmd_5495a840_0d57_43e1_9dbe_791ced7781bf
    cmd_request_id:  82562ce5-bca1-4eb5-9831-b86a80ffc1c4/y8ht
    rpc_request_id:  0

The response POST did not complete. At 16:23:38.737 it ended with:

    Client.Timeout exceeded while awaiting headers

Thus the observed response-delivery wait after the local response was about
35.0 seconds. This is an observed duration, not a claimed command
response_timeout field.

Immediately afterward the stdio MCP command exited and tunnel-client logged
"stdio MCP command failed; requesting tunnel-client shutdown" at
16:23:38.754.

### Runtime replacement and local health

The recorder observed the following identity transition:

    tunnel-client 111154/31408202 -> absent -> 166168/31479572
    GWC           111178/31408210 -> absent -> 166185/31479579
    Herdr         34847/86787     -> unchanged

The component sampler saw /healthz and /readyz become unavailable at
16:23:39.103 and return HTTP 200 at 16:24:02.636. The new tunnel-client
reported a different client_instance_id.

This restart occurs after the failed response delivery and the stdio child exit;
Wave 1 records that ordering but does not claim Proton alone directly killed the
local processes.

### Second execution: classification B

After the new GWC started, the independent recorder saw the exact same tagged
shell again:

    PID/starttime: 166289 / 31479628
    parent GWC:    166185
    first seen:    16:24:03.166
    last seen:     16:24:23.106

The same caller correlation later completes under a fresh tunnel request:

    request_id:      cmd_8bcf9c01_550c_47d2_b3c2_3a2a064f4b09
    cmd_request_id:  82562ce5-bca1-4eb5-9831-b86a80ffc1c4/y8ht
    rpc_request_id:  0

Because the tunnel request identity changed while the JSON-RPC id stayed 0,
this is classification B: new tunnel request, same RPC id.

### Third execution: classification C

A third exact tagged shell then ran under the same replacement GWC:

    PID/starttime: 171918 / 31483772
    parent GWC:    166185
    first seen:    16:24:44.804
    last seen:     16:25:04.500

Its correlated caller sequence advances to:

    request_id:      cmd_50ef2372_5662_4d4d_b70b_40ff8f543436
    cmd_request_id:  82562ce5-bca1-4eb5-9831-b86a80ffc1c4/y8ht
    rpc_request_id:  1

This is classification C: new tunnel request and new RPC id.

The remote invocation as observed by the caller timed out; the local evidence
therefore must not be reinterpreted as a successful original invocation.

## Causal conclusion

Wave 1 demonstrates that the duplicate execution is not created by one GWC
handler dispatching a single tunnel command twice. Distinct tunnel request IDs
exist for the repeated executions, and one retry preserves the RPC id while a
later retry advances it.

The strongest supported attribution is therefore:

    caller/control-plane retry or redelivery boundary
      -> fresh tunnel request
      -> GWC receives another request
      -> another real local execution

The local runtime has no evidence, in this run, that would allow it to know that
these fresh requests represent the same logical operation unless it is given or
derives an idempotency identity above the individual tunnel request_id /
JSON-RPC id pair.

## Wave 2 implication, without implementing Wave 2

Wave 2 should be scoped around request identity and idempotency across transient
response-delivery failure and runtime/session reacquisition. It should not begin
from a premise that GWC internally double-dispatches one request.

Questions Wave 2 must answer before implementation include:

- what identity is authoritative for recognizing a replay of one logical tool
  operation across fresh tunnel request IDs and possibly fresh RPC IDs;
- where the idempotency/dedup state may safely live across GWC/tunnel restarts;
- how mutating tools differ from read-only tools when the caller cannot know
  whether the first execution completed;
- what response can be replayed safely after an already-completed execution;
- how long any dedup/idempotency record may remain authoritative;
- how session reacquisition interacts with the above identity.

No deduplication, replay cache, response retry, session reacquisition, or
transport change is implemented in Wave 1.

## Raw evidence and privacy

Raw runs are kept below diagnostics/wave1-runs/ and are Git-ignored. They may
contain local PIDs, routes, runtime paths, and tunnel correlation IDs, so only
this sanitized interpretation is versioned.

No API key value, authorization header, environment dump, or raw arbitrary tool
command is added to the versioned evidence.

## Response-delivery outcomes and remaining uncertainty

Response delivery is intentionally kept separate from local execution:

- baseline: one response POST was confirmed HTTP 200;
- fault execution #1: the local result existed, but its response POST ended in
  Client.Timeout after about 35 seconds;
- fault executions #2 and #3: after the managed runtime was relaunched, the
  supervisor restored the original INFO-level profile. The available INFO logs
  preserve request/cmd/RPC correlation and end-of-processing markers, but do
  not contain the DEBUG HTTP-200 delivery event. Their response acceptance is
  therefore not claimed;
- the caller-visible outcome for the original remote invocation remained
  timeout.

The mapping of executions #2 and #3 uses the exact repeated trace tag observed
by the independent recorder, the stable caller-side cmd_request_id, the ordered
RPC ids, and the v0.0.10 source ordering showing that the INFO "forwarded"
message is emitted after response forwarding returns. No raw command body is
taken from tunnel logs.

Still unresolved by local evidence:

- which remote/product component schedules the retry/redelivery;
- whether execution #2's response reached the control plane before its context
  ended;
- whether execution #3's response reached the control plane;
- request-specific created_at and Mcp-Session-Id for the correlated commands;
- child_generation and initialize_epoch, which v0.0.10 does not expose.

## Verification

Final verification after the documentation update:

- Bun focused tests: 22 passed, 0 failed, 302 expectations;
- Python diagnostics tests: 21 passed;
- TypeScript typecheck: passed;
- git diff --check: passed;
- runtime bundle build: passed;
- relocatable standalone MCP smoke: RELOCATABLE_STANDALONE_MCP_SMOKE_OK.
