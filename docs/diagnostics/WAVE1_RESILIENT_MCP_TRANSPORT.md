# Wave 1 resilient MCP transport causal attribution

Wave 1 is diagnostic-only. It does not implement request deduplication, replay,
retry, session reacquisition, transport redesign, or any Wave 2 resilience
behavior.

## Result

Wave 1 now has a strong one-to-one correlator across the tunnel-client -> MCP
boundary. For controlled tagged terminal_exec calls, an opt-in diagnostic
tunnel-client build injects a UUID into MCP request metadata under:

    io.openai.gwc/wave1-dispatch-id

GWC records that UUID as boundary_dispatch_id at received,
execution_started, execution_finished, and response_returned.

The accepted physical Proton run on 2026-09-29 reproduced two executions of the
same controlled tagged command. The two executions were reached through two
different tunnel commands and two different boundary dispatch IDs:

| Execution | tunnel request_id | cmd_request_id | JSON-RPC id | boundary_dispatch_id | local PID | Classification |
|---|---|---|---:|---|---:|---|
| #1 | cmd_5e10430d_a380_45b4_902b_093fb2dc041b | 3c53f827-65e8-4c4c-959d-f6ad0c9b8266/djiq | 0 | 9db797f1-3da2-4977-99ca-5d2da8d47a9b | 430355 | original |
| #2 | cmd_12ba0814_d1c3_4356_9e15_07af93618e26 | 3c53f827-65e8-4c4c-959d-f6ad0c9b8266/f9gm | 0 | 16cd4241-de04-4564-bf17-baf15249eadf | 454159 | B: new tunnel request, same RPC id |

This rules out the local-only explanations targeted by Wave 1:

- not A: the repeated execution does not reuse one tunnel request_id;
- not D: one tunnel command is not dispatched twice inside GWC;
- classification B is directly demonstrated: a fresh tunnel request with the
  same JSON-RPC id reaches GWC and starts a fresh local execution.

The decisive ordering is that request #2 had already reached tunnel-client
and was entering local dispatch at 18:30:09.577, while the Proton kill switch
did not begin until 18:31:42.063. Therefore the second equivalent request
already existed locally before the physical outage; that outage cannot have
originated its arrival at tunnel-client. The 18:30:09.577 timestamp is not the
wire created_at value, which remains unknown.

The strongest supported statement is therefore only:

    two distinct upstream/tunnel requests carry the same controlled payload
      -> each has its own tunnel request_id
      -> each gets its own boundary_dispatch_id
      -> each reaches GWC once
      -> each starts one local execution

Local evidence does not establish the relationship between those two upstream
requests. In particular, it does not prove that request #2 is a retry, replay,
or redelivery of the same authoritative logical operation. Their complete
cmd_request_id values are distinct and opaque; the shared textual prefix has no
documented identity semantics in v0.0.10.

## Classification vocabulary

Wave 1 uses the following request-level classifications:

- A: the same tunnel command request_id is redelivered;
- B: a new tunnel command request_id carries the same JSON-RPC id;
- C: a new tunnel command request_id carries a new JSON-RPC id;
- D: one tunnel command is dispatched locally more than once;
- E: a caller/product retry demonstrated outside the tunnel/control-plane
  boundary;
- F: another demonstrated cause.

The accepted strong-correlation run demonstrates B. It does not demonstrate E:
there is no captured caller/product identity or explicit upstream evidence that
establishes request #2 as a retry of request #1.

## Exact tunnel-client version and source

The diagnostic client is based on the exact active v0.0.10 source corresponding
to:

    0.0.10+105e17a79a36e4e5c897fd698ed2b8dbf935b144

The source archive and extracted source tree are kept under the Git-ignored
Wave 1 evidence tree. The versioned diagnostic delta is:

    scripts/diagnostics/tunnel-client-wave1-boundary.patch

Relevant v0.0.10 behavior confirmed from source:

- a polled command carries request_id, shard_token, command_type, channel,
  created_at, headers, and a JSON-RPC body;
- request_id is the tunnel command identity;
- cmd_request_id is caller/control-plane correlation, not documented as an
  idempotency key;
- rpc_request_id is the JSON-RPC id;
- tunnel_request_id is the HTTP response-POST identity;
- poll failures retry with backoff;
- PostResponse performs one HTTP request per invocation and has no local
  response replay loop;
- HTTP 200 is confirmed successful response delivery;
- HTTP 404 is logged as "response already fulfilled or unknown request" and is
  treated as terminal/non-error by the dispatcher;
- HTTP 404 does not distinguish already accepted from unknown/expired and
  therefore cannot authorize blind replay of a mutating operation;
- "dispatcher forwarded command to MCP server" is emitted only after
  forwardResponses returns, so it is an end-of-processing marker, not a
  dispatch-start marker.

### Local HTTP deadline

v0.0.10 constructs one http.Client with:

    Timeout = PollDeadlineTimeoutOrDefault()

The defaults are:

    poll timeout = 30 s
    poll deadline guardrail = 5 s
    resulting local HTTP client deadline = 35 s

The same http.Client is used for PostResponse. Therefore the approximately
35-second wait observed in the older 2026-09-22 fault run is the local
tunnel-client HTTP deadline. It is not evidence of an MCP operation deadline,
caller deadline, control-plane retry interval, or request-specific
response_timeout.

There is no request-specific response_timeout field in the v0.0.10 command
wire shape.

## Strong boundary correlator

The diagnostic v0.0.10 patch is disabled unless:

    TUNNEL_CLIENT_WAVE1_TRACE=1

For a controlled tagged terminal_exec request it:

1. generates one UUID immediately before forwarding the JSON-RPC request to
   stdio;
2. merges that UUID into request params._meta under
   io.openai.gwc/wave1-dispatch-id;
3. logs only the UUID and controlled trace tag, while existing structured log
   context supplies request_id, cmd_request_id, and rpc_request_id;
4. leaves untagged requests unchanged;
5. fails open to the original request if diagnostic injection fails.

The patch does not log the raw command.

GWC tracing is enabled only when CODEX_CHATGPT_WEB_MCP_TRACE_FILE is set. GWC
reads RequestHandlerExtra._meta, validates the UUID, and writes
boundary_dispatch_id into its existing gwc-mcp-trace/v1 events.

This produces the direct join:

    tunnel request_id
      -> cmd_request_id / rpc_request_id
      -> boundary_dispatch_id
      -> GWC received
      -> local execution id
      -> local PID/starttime
      -> GWC response_returned

The focused tests also verify that two SDK calls with distinct metadata UUIDs
retain the correct UUID through every trace phase.

## Privacy properties

The GWC tracer records:

- wall clock and monotonic clock;
- GWC PID and /proc starttime;
- MCP SDK RequestHandlerExtra.requestId;
- tool name;
- controlled non-secret trace tag when present;
- deterministic digest of controlled sanitized fields;
- boundary_dispatch_id when present;
- DirectToolService execution/job id;
- local PID and process starttime when available;
- terminal status and exit code;
- phases received, execution_started, execution_finished, and
  response_returned.

The raw command is never written by the tracer. The digest is not computed from
the raw command or arbitrary user input. Trace-file failures are fail-open.

No public MCP tool, catalog entry, schema, or tools/list surface is added by
this instrumentation.

## Observability boundary in v0.0.10

The following proposed endpoints do not exist in v0.0.10:

    /health/control-plane
    /health/response-delivery
    /health/queue
    /health/dispatcher
    /health/mcp

Wave 1 uses the available safe surfaces instead:

    /healthz
    /readyz
    /api/status
    /api/log-level
    /metrics

plus structured tunnel-client logs, the independent recorder, and the GWC
NDJSON tracer.

The status endpoint exposes client instance identity, uptime,
channel/transport state, and the stdio child PID, but not child_generation or
initialize_epoch. Mcp-Session-Id was not present in the correlated safe events.
Those values are not inferred or invented.

## Baselines

### Original 2026-09-22 normal baseline

Tag: W1_BASE_20260922_A.

The baseline produced exactly one chain:

    one tunnel command
      -> rpc_request_id 0
      -> one GWC received phase
      -> one local execution
      -> one execution result
      -> one response POST
      -> HTTP 200

Correlated identities:

    tunnel request_id:   cmd_487b11cf_64ac_4426_b9d3_2435ada46281
    cmd_request_id:      212b2489-60b1-49ef-b893-5aca910a44ab/siku
    rpc_request_id:      0
    local execution id:  da962e91-21d0-42b4-bd5a-005178d0a896
    local PID:           2891542
    response HTTP id:    req_6ba0696e751f491aba9bf38834e4c4ae
    response status:     200

This baseline showed that the original GWC tracer itself did not create an
extra local dispatch.

### Strong-correlator baseline on 2026-09-29

Tag: W1_REVIEW_BASE.

The same boundary UUID was present on both sides:

    tunnel request_id:     cmd_899feaa5_3184_451d_a42b_a394de0e60cd
    cmd_request_id:        e81df2a8-d157-4c5e-b73c-4f96d1991063/514j
    rpc_request_id:        0
    boundary_dispatch_id:  835b472c-033c-4953-a0ff-4111b6a6f825
    GWC execution id:      f35fa727-2a57-467d-9e60-c80fc1feae15
    local PID:             1372754

GWC recorded received -> execution_started -> execution_finished ->
response_returned with the same boundary_dispatch_id.

A later post-recovery baseline repeated the same result with
boundary_dispatch_id ef8d3bc9-499d-4013-82a1-50f306f349a8.

## Historical 2026-09-22 Proton run and its limitation

Tag: W1_FAULT2C_161452.

The physical transition itself was valid:

    kill-switch window: 7409 ms
    initial proton0: absent
    kill switch observed: yes
    final proton0: present
    public reachability restored: yes

The first execution was fully traced by GWC:

    received:            16:22:43.563
    execution_started:   16:22:43.592
    execution_finished:  16:23:03.732
    response_returned:   16:23:03.733
    GWC PID/starttime:   111178 / 31408210
    local execution id:  d1f2872f-0569-4547-a751-b49fcd0556ff
    local PID/starttime: 159328 / 31471676
    SDK request id:      0

Tunnel-client attempted one response POST. At 16:23:38.737 the local HTTP
client ended with:

    Client.Timeout exceeded while awaiting headers

The correct interpretation is:

- the local execution completed;
- tunnel-client made one PostResponse HTTP attempt;
- the client did not observe response headers before its approximately
  35-second local HTTP deadline;
- remote/control-plane acceptance of that result is unknown.

This must not be described as proven failed delivery.

Immediately after that timeout the stdio MCP command exited and the managed
runtime was later replaced. Herdr survived.

The recorder then observed two additional exact tagged shells. However the
replacement GWC was the installed, uninstrumented runtime, so those later
executions lacked a direct tunnel request_id -> GWC receive -> local PID
correlator. The older report inferred mappings using trace tag, cmd_request_id,
RPC ordering, and time. Those inferred mappings are retained only as historical
context and are not used for the final A/B/C/D classification.

## Independent no-Proton equivalent-request control on 2026-09-29

Tag: W1_REVIEW_NOTIFY_181737.

This run did not contain a physical Proton transition: the recorder observed no
proton0 and no pvpnksintrf0. It nevertheless reproduced two executions with
strong boundary identity.

Request #1:

    request_id:            cmd_6320ff88_729f_4002_a38d_c207067b11e1
    cmd_request_id:        3c53f827-65e8-4c4c-959d-f6ad0c9b8266/krbk
    rpc_request_id:        0
    boundary_dispatch_id:  a9bab347-4b24-49e0-8400-55e7dab72374
    local PID:             353145

Request #2:

    request_id:            cmd_5c0bec59_b578_44d5_afc4_1340a4176bdf
    cmd_request_id:        3c53f827-65e8-4c4c-959d-f6ad0c9b8266/5gki
    rpc_request_id:        0
    boundary_dispatch_id:  002934c1-bf48-4b11-8de2-e2dc28e91fc3
    local PID:             378376

Each response POST received HTTP 404, represented by v0.0.10 as:

    response already fulfilled or unknown request

This control independently demonstrates classification B without any Proton
transition. It shows that two distinct tunnel requests carrying the same
controlled payload can reach GWC and produce two local executions without a VPN
fault. It does not establish that the second request is a retry/replay of the
same logical operation.

## Accepted physical Proton run on 2026-09-29

Tag: W1_PHYS_FINAL_182843.

Raw evidence directory, intentionally ignored by Git:

    diagnostics/wave1-runs/session-20260929/
      review-physical-final-20260929T182843+0200/

The recorder captured:

    initial proton0: absent
    initial pvpnksintrf0: absent
    kill-switch first: 18:31:42.063
    kill-switch last:  18:31:48.782
    proton0 first:     18:31:42.263
    public reachability failures observed: yes
    final proton0: present

Throughout the accepted sample window, process identity did not change:

    tunnel-client: 307525 / 324601
    GWC:           307546 / 324606
    Herdr:          74505 / 153936

Therefore this accepted run does not depend on runtime replacement or
post-restart inference.

### Request #1

Tunnel boundary:

    time:                  18:29:08.589
    request_id:            cmd_5e10430d_a380_45b4_902b_093fb2dc041b
    cmd_request_id:        3c53f827-65e8-4c4c-959d-f6ad0c9b8266/djiq
    rpc_request_id:        0
    boundary_dispatch_id:  9db797f1-3da2-4977-99ca-5d2da8d47a9b

GWC boundary and execution:

    received:              18:29:08.591
    execution_started:     18:29:08.592
    execution_finished:    18:32:00.949
    response_returned:     18:32:00.949
    local execution id:    c06499b7-ca32-4181-be19-f634ffebef1b
    local PID/starttime:   430355 / 466605

The same boundary_dispatch_id is present at the tunnel boundary and every GWC
trace phase.

The shell intentionally remained active through the Proton transition and
returned after the kill switch had ended, matching the temporal shape of the
older fault run.

Tunnel-client's response POST then received HTTP 404 at 18:32:01.121:

    response already fulfilled or unknown request

That is terminal from the v0.0.10 dispatcher's perspective but does not reveal
whether the result had already been accepted or the request was unknown/expired.

### Request #2

A second tunnel command carrying the same controlled tagged input had already
reached tunnel-client and was entering local dispatch at:

    local dispatch time:   18:30:09.577
    request_id:            cmd_12ba0814_d1c3_4356_9e15_07af93618e26
    cmd_request_id:        3c53f827-65e8-4c4c-959d-f6ad0c9b8266/f9gm
    rpc_request_id:        0
    boundary_dispatch_id:  16cd4241-de04-4564-bf17-baf15249eadf

Critically, this timestamp is about 92.5 seconds before the first observed
kill-switch sample at 18:31:42.063.

After request #1 returned, GWC received request #2 at 18:32:01.034 and started
a fresh local execution:

    local execution id: 5420dbc0-2ec0-4172-bbc2-691c9f574c50
    local PID/starttime: 454159 / 483850

The second GWC response_returned event occurred at 18:35:01.036 with
terminal_status=running because the terminal_exec wait window elapsed while its
local process remained active. Tunnel-client then received HTTP 404 for its
response POST at 18:35:01.216.

### Physical-run classification

This is classification B:

    new tunnel request_id
      + same rpc_request_id
      + new boundary_dispatch_id
      + new GWC received
      + new local execution

It is not A and not D.

Most importantly, request #2 had already reached tunnel-client before the
Proton outage began. The physical outage therefore did not originate the
observed second request's local arrival.

## Causal conclusion

Wave 1 now directly demonstrates that the duplicate local execution is produced
above the local GWC dispatch boundary.

The accepted physical run establishes:

1. one tunnel request maps one-to-one through a unique boundary_dispatch_id to
   one GWC receive and one local execution;
2. the repeated execution arrives through a different tunnel request_id and a
   different boundary_dispatch_id;
3. the repeated request preserves JSON-RPC id 0, so the demonstrated
   classification is B;
4. tunnel-client, GWC, and Herdr all retain the same process identities across
   the physical Proton transition;
5. the second tunnel command had already reached tunnel-client and entered
   local dispatch before that Proton transition began.

The no-Proton control independently reproduces the same structural B pattern.

Therefore the strongest supported causal statement is:

    the duplicate local execution is already present above the GWC dispatch
    boundary: two distinct upstream/tunnel requests carrying the same
    controlled payload each map one-to-one to one GWC receive and one local
    execution.

This excludes local GWC double-dispatch and shows that the accepted Proton
outage did not originate the second request's arrival at tunnel-client. Wave 1
does not establish whether request #2 is a retry/replay/redelivery of request
#1 according to any authoritative logical-operation identity, nor which
upstream component emitted either request.

## Response-delivery semantics

Response delivery must remain separate from local execution.

Confirmed cases:

- normal baseline: HTTP 200, accepted response delivery;
- historical 2026-09-22 fault request: one PostResponse attempt; local
  http.Client timeout after about 35 seconds while awaiting headers; remote
  acceptance unknown;
- no-Proton B control: both response POSTs returned HTTP 404;
- accepted physical B run: both response POSTs returned HTTP 404.

For v0.0.10, HTTP 404 means only:

    already fulfilled or unknown request

It is not evidence that this specific response was accepted, and it is not
evidence that it was rejected before execution. It cannot safely authorize a
blind replay of a mutating tool.

## Wave 2 implication, without implementing Wave 2

Wave 2 should be identity/idempotency-first, not transport-restart-first.

The evidence says that tunnel request_id and JSON-RPC id alone are not enough
to decide whether two equivalent requests represent one logical operation. A
fresh tunnel request can preserve the same RPC id, but Wave 1 captured no
authoritative logical-operation identity spanning the two requests.

Before implementation, Wave 2 must decide:

- which identity domain is authoritative for one logical tool operation;
- whether that identity is supplied by an upstream layer or must be derived
  locally from a stronger contract;
- where dedup/idempotency state may safely live across runtime/session changes;
- how mutating tools differ from read-only tools when first-attempt acceptance
  is unknown;
- what result, if any, may be replayed safely after an already-completed
  execution;
- how long an idempotency record remains authoritative;
- how HTTP 404 ambiguity affects response replay and recovery.

No deduplication, replay cache, response retry, session reacquisition, or
transport behavior is implemented by Wave 1.

## Raw evidence and privacy

Raw runs are kept below diagnostics/wave1-runs/ and are Git-ignored. They may
contain local PIDs, routes, runtime paths, and tunnel correlation IDs.

Because the original recorder allowlist omitted wave1_dispatch_id and trace_tag,
the still-present primary tunnel-client log was used once to preserve verbatim,
read-only source extracts for the accepted physical run, the no-Proton control,
and the strong baseline. Each extract has a SHA-256 sidecar; the run-level
extracts also record provenance. The accepted physical run now contains:

    tunnel-boundary-events.raw.ndjson
    tunnel-boundary-events.raw.ndjson.sha256
    tunnel-boundary-events.provenance.txt

The recorder allowlist now preserves wave1_dispatch_id and trace_tag for future
diagnostic runs.

The versioned artifacts contain no API key value, authorization header,
environment dump, or arbitrary raw user command.

## Remaining uncertainty

Still unresolved by local evidence:

- what relationship, if any, exists between the two observed upstream requests,
  including whether one is a retry/replay/redelivery of the other;
- which upstream/product component emitted each request;
- the authoritative logical-operation identity, if one exists above the tunnel
  request and JSON-RPC ids;
- request-specific created_at and Mcp-Session-Id for the correlated commands;
- child_generation and initialize_epoch, which v0.0.10 does not expose;
- whether a 404 response corresponds to an already accepted result or an
  unknown/expired request in any individual case.

These limits are material. Wave 1 intentionally does not infer beyond them.

## Verification

Final verification after the diagnostic and documentation corrections:

- focused Bun tracer tests: 3 passed, 0 failed, 41 expectations;
- Python diagnostics tests: 22 passed;
- TypeScript typecheck: passed;
- runtime bundle build: passed;
- tunnel-client diagnostic patch dry-run against pristine v0.0.10 source:
  passed;
- tunnel-client diagnostic Go tests for pkg/dispatcher/internal: passed;
- git diff --check for the working diff: passed;
- git diff --check from Wave 1 base
  82072f87cc5742d1d229dfe95d20289973e9768c through the corrected tree:
  passed;
- diagnostics/wave1-runs/session-20260929/final-gates.txt ends with RC=0.
