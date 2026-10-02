# Wave 3 recovery, retry, deduplication, and idempotency contract

Status: design-only. Wave 3 does not change production behavior, retry policy, tunnel behavior, public schemas, or transports.

Base evidence: Waves 0, 1, and 2 through commit `fa22f1a11b6efdcec2691aa5185e7c3d98324b2b`.

## Executive contract

The safe contract is intentionally narrower than "exactly once":

> GWC can reason about one concrete request instance that entered one tool handler. It cannot currently prove that two distinct upstream requests represent the same logical operation.

Consequences:

1. A request instance is an occurrence of one MCP tool-handler invocation. It is not defined globally by JSON-RPC ID, tunnel `request_id`, `cmd_request_id`, payload equality, timing, or any current diagnostic identifier.
2. A logical operation is the caller's semantic intention across zero or more transport/request attempts. GWC has no authoritative logical-operation identity today.
3. GWC must not perform cross-request deduplication by payload, digest, JSON-RPC ID, tunnel identity, timing, or local execution identity.
4. The current safe default is no cross-request deduplication and no new automatic replay of mutations.
5. A remote timeout or termination is an observation about the caller/control plane, not proof that local execution failed.
6. Local completion is proof only of local completion. It is not proof that the caller observed or accepted the result.
7. A late result may be retained for diagnosis or request-specific recovery, but it must not be claimed by a later equivalent request unless that request presents an authoritative logical-operation identity.
8. Job-oriented APIs improve recovery because work receives a stable local handle before observation/polling, but losing the response that contains the first job ID is still ambiguous unless the handle can be independently reacquired.
9. Safe cross-request deduplication requires a caller/control-plane `logical_operation_id` / idempotency key that is born before the first dispatch and remains stable across retries.
10. Even with such a key and a durable local journal, generic exactly-once side effects are not guaranteed. A crash after an external side effect but before durable completion remains ambiguous unless the downstream side effect is itself idempotent/keyed or can commit atomically with the journal.

The recommended Wave 4 is therefore **recovery without blind replay**: make ambiguous outcomes explicit, prefer/reacquire existing job handles where possible, do not auto-replay mutations, and add cross-request journal/dedup only after a trustworthy upstream operation key exists.

## 1. Evidence inherited from Waves 0-2

### Wave 0: local lifecycle is not the primary failure

Wave 0 established during the real Proton transition that:

- tunnel-client survives;
- the GWC MCP runtime survives;
- the Herdr daemon survives;
- already-started local children can survive;
- connector/invocation state must be kept separate from process/network state;
- a later successful connector probe does not prove an earlier invocation survived;
- the evidence does not justify stdio -> HTTP as the primary fix.

The Wave 0 recorder also established the important ownership distinction that direct terminal jobs are GWC-owned, while Herdr pane processes are daemon-owned and may persist independently of the GWC process.

Primary evidence:

- `docs/diagnostics/WAVE0_RESILIENT_MCP_TRANSPORT.md`
- `diagnostics/wave0-runs/WAVE0-RESULTS.md`

### Wave 1: the duplicate exists above the GWC dispatch boundary

Wave 1 directly correlated:

```text
Request A
  -> tunnel request A
  -> boundary dispatch A
  -> GWC receive A
  -> local execution A

Request B
  -> tunnel request B
  -> boundary dispatch B
  -> GWC receive B
  -> local execution B
```

The accepted physical run classified the repeated execution as a **new tunnel request with the same JSON-RPC ID**, not an internal double-dispatch of one GWC request.

The no-Proton control also produced two distinct tunnel requests and two local executions for equivalent controlled input. Therefore Proton is not required for the observed duplicate-request shape.

Critically, Wave 1 did **not** establish that Request B was a retry/replay of the same logical operation as Request A.

Wave 1 also established response-delivery semantics:

- HTTP 200 from the response POST is evidence of accepted response delivery at that boundary;
- a local response POST timeout leaves remote/control-plane acceptance unknown;
- the observed HTTP 404 "response already fulfilled or unknown request" is semantically ambiguous without stronger upstream evidence.

Primary evidence:

- `docs/diagnostics/WAVE1_RESILIENT_MCP_TRANSPORT.md`
- versioned summaries under `diagnostics/wave1-runs/`

### Wave 2: strong intra-request identity, no cross-request logical identity

Wave 2 classified the system as **Case C: partial identity**.

For a request-specific path, GWC can strongly correlate:

```text
request_received
  -> boundary_dispatch_id
  -> execution_started
  -> local_execution_id
  -> execution_finished
  -> response_returned
```

The later stdio response boundary is weaker:

```text
response_created
  -> response_handed_to_stdio
```

At those transport events, current tracing has only `jsonrpc_request_id`. If two live requests reuse that JSON-RPC ID, GWC cannot uniquely attribute those response-side events back to one `boundary_dispatch_id` or `local_execution_id`.

Wave 2 also established that none of the observed identities is an authoritative logical-operation key:

- JSON-RPC ID;
- tunnel `request_id`;
- `cmd_request_id`;
- `boundary_dispatch_id`;
- local execution/job ID;
- input digest;
- tool + arguments.

Primary evidence:

- `diagnostics/wave2-runs/identity-semantics.md`
- `diagnostics/wave2-runs/run-a-control.ndjson`
- `diagnostics/wave2-runs/run-b-equivalent-dispatches.ndjson`

## 2. Identity assumptions

### 2.1 Request instance

For this contract, a **request instance** is one concrete occurrence of an MCP tool handler being entered by GWC.

Conceptually:

```text
R := one handler-entry occurrence
```

This definition deliberately does not equate `R` with a field value.

A JSON-RPC ID correlates a JSON-RPC request with its response in the SDK. MCP SDK 1.30.0 places `request.id` into `RequestHandlerExtra.requestId` and copies the same ID into the response. Wave 1 proves that two distinct tunnel requests may still reuse the same JSON-RPC ID.

Therefore:

```text
same(jsonrpc_request_id)  !=  same(request instance)
```

and:

```text
different(request instance)  !=  different(logical operation)
```

The second relation is unknown without a higher identity.

### 2.2 Logical operation

A **logical operation** is the semantic intention that an authoritative caller wants performed once under a defined idempotency contract.

Conceptually:

```text
O := caller-defined semantic operation
attempts(O) := {R1, R2, ...}
```

Today GWC cannot construct `O` from the observed fields.

Payload equality is evidence of equivalence, not identity:

```text
tool(A) == tool(B) and args(A) == args(B)
does not imply
logical_operation(A) == logical_operation(B)
```

Two intentionally repeated user actions may be byte-for-byte identical and still be two distinct logical operations.

### 2.3 Identity scope of current fields

| Field | Valid scope | Not valid as |
|---|---|---|
| `jsonrpc_request_id` | JSON-RPC request/response correlation in its actual transport context | global operation ID or idempotency key |
| tunnel `request_id` | one tunnel request | identity stable across a distinct upstream retry |
| full `cmd_request_id` | observed control-plane/tunnel correlation | logical-operation ID; stability not documented |
| shared `cmd_request_id` prefix | observed textual relationship only | retry/attempt identity |
| `boundary_dispatch_id` | one diagnostic tunnel -> GWC dispatch | cross-dispatch operation ID |
| `local_execution_id` / job ID | one local execution/job object | identity of caller intent |
| input digest | controlled equality signal | idempotency key |
| tool + args | semantic payload | logical identity |
| trace tag | diagnostic correlation | production operation identity |

## 3. Invocation state machine

The state model has two independent axes. A single scalar "succeeded/failed" state is insufficient.

### 3.1 Local execution/result state

```text
RECEIVED
  |
  +-> NOT_STARTED
        |
        +-> RUNNING
              |
              +-> COMPLETED_LOCALLY
              |      |
              |      +-> RESULT_CREATED
              |             |
              |             +-> RESULT_HANDED_TO_TRANSPORT
              |
              +-> FAILED_LOCALLY
              |
              +-> CANCELLED_LOCALLY
```

For asynchronous/job APIs, a useful intermediate concept is:

```text
JOB_CREATED
  -> JOB_RUNNING
  -> JOB_COMPLETED | JOB_FAILED | JOB_CANCELLED | JOB_TIMED_OUT
```

A job creation response and the job's eventual execution are different events.

### 3.2 Remote observation/delivery state

Remote state is orthogonal:

```text
REMOTE_ACTIVE
  |
  +-> RESULT_DELIVERED          only with a positive boundary that proves it
  |
  +-> RESULT_DELIVERY_UNKNOWN  no conclusive acceptance evidence
  |
  +-> REMOTE_TIMEOUT           caller/control-plane timed out
  |
  +-> REMOTE_TERMINATED        caller/invocation terminated
```

`REMOTE_TIMEOUT` and `REMOTE_TERMINATED` are observations, not local execution results.

The following state is valid and was materially observed in Wave 1:

```text
COMPLETED_LOCALLY
+
RESULT_DELIVERY_UNKNOWN
```

Likewise, this is possible:

```text
RUNNING
+
REMOTE_TIMEOUT
```

### 3.3 Result handoff is not delivery

Wave 2's `response_handed_to_stdio` means the stdio transport accepted the write according to the local SDK/Node boundary. It does not prove:

- tunnel-client consumed the bytes;
- tunnel-client response POST succeeded;
- control-plane accepted the response;
- the original caller observed the result.

The name must remain weaker than `RESULT_DELIVERED`.

## 4. Operation classes

Classification is semantic, not inferred solely from annotations.

MCP annotations such as `readOnlyHint`, `destructiveHint`, and `idempotentHint` are declarative metadata. They are neither cryptographic guarantees nor request/logical-operation identities, and GWC must not upgrade them into either without an independent contract.

### A. Read-only / observational

Examples include status/read/list/inspect tools such as:

- `file_read`;
- `file_list`;
- `file_search`;
- `terminal_status`;
- `herdr_status`;
- `herdr_pane_read`;
- `herdr_pane_wait`;
- `herdr_pane_status`;
- `external_mcp_status`;
- `codexluna_status`;
- `codexluna_session`.

A second equivalent observation is often acceptable, but **read-only does not mean pure**. A read may:

- return different state at a later time;
- consume rate limits or remote resources;
- create audit/log observability;
- be expensive;
- expose a user-visible presentation side effect.

A concrete local warning is `file_image_preview`: it is annotated `readOnlyHint: true` and `idempotentHint: true`, yet automatic presentation uses session-scoped state to record whether content has already been presented. This is a useful example of why annotations are not a mathematical purity proof.

Safe default: observational retries may be allowed only when the concrete tool contract says re-observation is acceptable. `readOnlyHint` alone is insufficient.

### B. Idempotent mutation

An idempotent mutation has a contract under which repeating the same intended operation reaches an equivalent side-effect state.

Current GWC has real examples that are explicitly annotated idempotent:

- `file_create_directory`: creating an already-existing directory is allowed and returns `created: false`;
- `terminal_cancel`: cancellation of an already terminal job returns its current state without creating another process effect.

These examples do **not** justify generic mutation replay. Their idempotence is tool-specific and scoped to the referenced target/job.

Even for an idempotent mutation:

- the result payload may differ between first and repeated invocation;
- concurrent external changes may matter;
- the target identity must itself be stable;
- an external implementation may not honor the hint.

Safe default: automatic replay requires an explicit tool-level idempotency contract plus stable target identity. Do not infer it from "looks safe".

### C. Non-idempotent or replay-unsafe mutation

Examples include:

- `terminal_start`;
- `terminal_exec`;
- `terminal_write_stdin`;
- `herdr_pane_run`;
- `herdr_pane_send`;
- worktree/tab/pane creation;
- attachment/file writes and edits unless a stronger operation-specific contract exists;
- external MCP actions whose semantics are not independently guaranteed;
- send/append/create-without-stable-key style operations.

For these, ambiguous completion must fail closed with respect to **automatic replay**. A timeout is not permission to repeat.

### D. Long-running / job-oriented operations

Current examples:

- `terminal_start` -> `terminal_status`;
- `terminal_exec`, when the wait window expires, returns the existing `job_id` and explicitly instructs the caller to poll rather than start the command again;
- `codexluna_start` -> `codexluna_status`;
- Herdr daemon-owned persistent panes plus read/wait/status operations.

These APIs provide better recovery properties than one long synchronous call because a stable local handle can separate execution from later observation.

However the handle is useful only if the caller obtains or can reacquire it.

#### Terminal jobs

`DirectToolService.startTerminal()` generates one UUID and stores the process in an in-memory map. `terminal_status(job_id)` can observe that same job while the GWC runtime remains alive.

Limits:

- direct terminal jobs are GWC-owned;
- GWC shutdown terminates running direct jobs;
- the terminal job map is not durable across GWC restart;
- if the response containing `job_id` is lost, there is no operation-key lookup that can recover that job ID.

#### Luna jobs

`codexluna_start` creates a UUID job record before asynchronous execution, and the state store persists jobs and `lastJobId` per conversation binding. This provides better reacquisition than a purely synchronous call.

Important limits:

- if the `codexluna_start` response is lost, `codexluna_session` can expose `last_job_id` for the same conversation binding, but that is not a general logical-operation lookup and can be superseded by a later start;
- queued/running jobs found after a standalone runtime restart are marked failed with `runtime_restarted`; they are not resumed as the same execution;
- one `codexluna_start` request creates one job, but the job manager can perform a second internal attempt after a transient failure when it has not observed a mutating event. Therefore "one request means exactly one underlying process attempt" is not a valid global guarantee.

#### Herdr

Herdr panes are daemon-owned rather than GWC-owned, so work in a pane can survive a GWC outage/restart. Explicit session/workspace/pane identity and Herdr's status/read/wait operations improve reacquisition.

However:

- `herdr_pane_run` is non-idempotent and may have accepted/executed a command before its response is lost;
- resending the same command is unsafe merely because the caller did not observe the acknowledgement;
- a caller-chosen completion sentinel can help observe one already-submitted finite command when the pane identity is known, but the sentinel is correlation evidence, not a cross-request logical-operation identity.

#### External MCP bridge

The bridge forwards exposed remote tool annotations but does not prove their semantics. It performs a synchronous `callTool` with a timeout and rejects tools that require task-augmented execution.

Therefore an external MCP timeout may be ambiguous for side-effecting tools. The bridge has no generic job reacquisition or idempotency-key mechanism today.

## 5. Guarantee definitions and current guarantees

### At-most-once local per received request instance

Definition:

> For one request-instance handler entry, GWC itself does not intentionally invoke the top-level native tool dispatch twice.

This is the strongest useful default statement for ordinary native tool handlers.

It must be qualified:

- it is scoped to one handler-entry occurrence, not a JSON-RPC ID value;
- it is not a durable guarantee across GWC crash/restart;
- a second upstream request is a second request instance;
- a tool implementation may itself contain lower-level retry behavior, as Luna jobs currently do under restricted conditions;
- external MCP servers may have their own execution/retry semantics beyond GWC's visibility.

### At-least-once

GWC does not currently guarantee at-least-once execution of a logical operation. A request may fail before reaching GWC and there is no GWC-owned end-to-end retry contract that guarantees eventual execution.

### Effectively-once

GWC does not currently provide effectively-once semantics across distinct request instances. It lacks an authoritative cross-request operation key and a corresponding dedup/result-replay journal.

### Exactly-once

GWC does not provide generic exactly-once semantics.

Even a future operation key + durable journal would not make arbitrary external side effects exactly once across crashes unless the side effect can be atomically committed with the journal or the downstream operation itself accepts a stable idempotency key.

### Unknown / ambiguous

An outcome is **ambiguous** whenever evidence cannot determine the fact needed for safe recovery.

Examples:

- local execution may have occurred but caller timed out;
- local execution completed but result delivery is unknown;
- a job may have been created but the response containing the handle was lost;
- an external MCP call timed out after the remote server may have committed a side effect.

Ambiguity is a first-class state. It must not be coerced into either success or failure.

## 6. Recovery matrix

"Execute a new request" below means as an automatic recovery action for the same presumed logical operation. It does not prevent an upstream user from intentionally issuing a new distinct operation.

| Observed state | New read-only observation | New idempotent mutation | New non-idempotent mutation | Return/replay prior result? | Can GWC know it is same logical operation today? | Missing identity / evidence | Safe default |
|---|---|---|---|---|---|---|---|
| Request known not to have reached GWC | Usually acceptable under tool contract | Only under explicit tool contract | Safe relative to this GWC only if non-arrival is actually proven | No prior result exists | No | authoritative operation identity still absent | caller may submit a new request; do not call it a retry dedup |
| RECEIVED / NOT_STARTED | Re-observation may be acceptable, but races are possible | Do not start a duplicate automatically | Do not start duplicate automatically | No | No | logical operation ID and durable state | allow original to proceed or deterministically cancel; do not race it |
| RUNNING | Prefer status/reacquisition when handle exists | Prefer status/reacquisition | Never blind replay | No completed result yet | No | logical operation ID; stable job handle if applicable | observe existing work |
| COMPLETED_LOCALLY | Re-observation can be issued if semantics permit | Do not infer need for replay | Never blind replay | Only to the same proven operation/handle | No | remote acceptance + logical operation ID | mark delivery separately; outcome may be ambiguous |
| RESULT_CREATED | Same as above | Same as above | Same as above | Request-specific result exists locally | No | logical operation ID; durable result association | continue delivery; no cross-request claim |
| RESULT_HANDED_TO_TRANSPORT | Same as above | Same as above | Same as above | Local handoff does not prove remote acceptance | No | remote acknowledgement + logical operation ID | do not equate handoff with delivered |
| RESULT_DELIVERY_UNKNOWN | Re-observe if acceptable | Retry only with explicit idempotency contract/key | Never automatic replay | Replay only when future request proves same logical operation | No | authoritative operation key | expose ambiguity |
| REMOTE_TIMEOUT / REMOTE_TERMINATED while local state unknown/running | Prefer status/reacquisition | Prefer status/reacquisition; no replay | Never automatic replay | Only if already associated with proven operation | No | local state + operation identity | timeout is not failure proof |
| Second equivalent request arrives | Treat as a distinct request instance | Treat as distinct unless explicit key says retry | Treat as distinct unless explicit key says retry | Never substitute A's result for B by payload alone | No | shared authoritative logical-operation key | Option 0 semantics today: no cross-request dedup |

A critical asymmetry follows:

- If GWC **knows** a request never reached it, there was no GWC-side local effect.
- From an ordinary caller timeout, GWC/caller usually **does not know** that non-arrival fact.

Therefore "timeout -> retry" is not a safe equivalence.

## 7. Duplicate distinct request semantics

Consider:

```text
Request A
  tool = file_edit
  args = X
  request_id = A

Request B
  tool = file_edit
  args = X
  request_id = B

A != B
no shared logical_operation_id
```

Correct interpretation:

1. A and B are two distinct request instances.
2. Equal tool + args establishes payload equivalence only.
3. GWC cannot know whether B is:
   - a retry of A;
   - an intentional second identical user action;
   - a control-plane duplicate;
   - a separate caller action;
   - a test/control.
4. GWC must not suppress B because it resembles A.
5. GWC must not return A's result as B's result.
6. GWC must not call them the same operation.
7. Under current Option 0 semantics, if both requests are delivered as ordinary calls, each is dispatched independently. That is semantically clean but can duplicate a mutation if upstream intended B as a retry.
8. A future safety layer may deduplicate only when A and B carry the same authoritative logical-operation key under a defined trust/TTL contract.

For `file_edit`, replay may fail because the old text no longer exists, or may act on later state if the same pattern reappears. Neither outcome makes payload-based dedup safe.

## 8. Late-result semantics

Scenario:

```text
local execution completes
  ->
remote invocation times out/terminates
  ->
result becomes late or delivery remains uncertain
```

### 8.1 Current semantics

Today there is no generic production late-result journal for arbitrary tools.

A late local completion must therefore be interpreted as:

```text
local outcome known
remote observation possibly unknown
```

not as automatic success or failure.

### 8.2 Future retention contract

If a future journal is implemented, retain enough information to distinguish:

- request-instance identity;
- logical-operation key, if one exists;
- operation descriptor for consistency checking;
- local state;
- result/error;
- creation/completion timestamps;
- delivery/acknowledgement state;
- expiry.

Retention must be bounded.

The TTL should satisfy:

```text
journal TTL >= authoritative upstream retry/recovery horizon
```

while remaining within privacy/storage limits.

Wave 3 cannot choose a defensible numeric TTL because the upstream retry horizon is not currently documented. A numeric TTL is therefore an open contract item, not something to invent.

### 8.3 Which identity owns the result?

Without a logical-operation key, a result may be retained under its request-specific/local execution identity for diagnosis or direct handle-based observation.

That does **not** make it claimable by a later equivalent request.

A future request may claim/replay a stored result only if it presents the same trusted logical-operation key in the same identity namespace. Payload equality may be used as a consistency guard and mismatch detector, but never as the primary identity.

### 8.4 No logical-operation identity

If no logical-operation identity exists:

- retain a late result only for request-specific diagnosis/reacquisition where a stable handle already exists;
- do not bind it to a future equivalent payload;
- do not auto-replay the result to another request;
- do not auto-execute a new non-idempotent mutation merely because the original caller timed out.

The externally meaningful state remains **ambiguous**.

## 9. Job-oriented recovery

Prefer:

```text
start
  -> stable job/operation handle
  -> status/poll/reacquire
```

over one long synchronous call when the work can outlive the request/transport observation window.

Benefits:

- execution can continue independently from polling;
- callers can re-observe work instead of re-running it;
- status calls can be read-only;
- result retrieval can be separated from initial acceptance;
- local state can survive a transient response-path failure when the job store/owner survives.

### The hard start-response-loss case

```text
job created locally
  ->
response containing job_id is not observed by caller
```

Without a stable logical-operation key or independent lookup path, the caller cannot know whether a new `start` would create duplicate work.

This remains ambiguous even though the internal job model is better than a long synchronous call.

Current relative properties:

| API | Stable handle | Handle storage | Work owner | Reacquisition if start response lost |
|---|---|---|---|---|
| `terminal_start` | UUID `job_id` | GWC memory | GWC | no general lookup by operation; weak |
| `terminal_exec` after wait timeout | UUID `job_id` in returned response | GWC memory | GWC | good only if caller received handle |
| `codexluna_start` | UUID `job_id` | durable standalone state | GWC/Luna manager | partial: same conversation can inspect `last_job_id`; not an operation-key lookup |
| Herdr pane | session/workspace/pane IDs | Herdr daemon | Herdr | comparatively strong when workspace/pane can be rediscovered; submitted command may still be ambiguous |
| external MCP call | remote-defined, if any | opaque | external server | no generic GWC recovery contract |

Job APIs reduce the need for replay. They do not solve identity by themselves.

## 10. Required upstream identity contract

Safe cross-request deduplication requires an identity that does not exist today.

Call it conceptually:

```text
logical_operation_id
```

or:

```text
idempotency_key
```

### 10.1 Generator

The key must be generated by the authoritative caller/control-plane layer **before the first transport dispatch** of the logical operation.

A GWC-generated ID after receipt is too late to tell whether a later independent request is the same upstream intention.

### 10.2 Stability

The key must remain unchanged across:

- network retry;
- control-plane redispatch;
- tunnel reconnect/reacquisition;
- JSON-RPC re-encoding;
- GWC re-delivery attempt for that same logical operation.

### 10.3 Deliberate repeated user actions

Two voluntarily repeated actions with identical tool and arguments must receive different logical-operation keys.

```text
same payload + new user action => new logical_operation_id
same logical operation + retry => same logical_operation_id
```

### 10.4 Uniqueness namespace

The key must be unique at least within a namespace that prevents collision/cross-caller result disclosure, conceptually:

```text
(authenticated principal / conversation or operation namespace, logical_operation_id)
```

The exact principal boundary is an upstream design question.

### 10.5 Lifetime and reuse

The key's validity must cover the full retry/recovery horizon.

After expiry, reuse should be forbidden. A reused key with a different operation descriptor must be rejected, not treated as a new operation.

### 10.6 Propagation

The key must cross:

```text
caller/control-plane
  -> tunnel command
  -> JSON-RPC metadata
  -> GWC request context
  -> optional downstream idempotency mechanism
```

It should not overload JSON-RPC `id`.

A transport-controlled metadata field is preferable to ordinary tool arguments because tool arguments are application payload and may be user-controlled.

### 10.7 Trust assumptions

GWC must know why it trusts the key's namespace and origin.

If arbitrary callers can forge another caller's operation key, a dedup/result-replay journal can become a cross-operation result disclosure mechanism.

Therefore a production design needs:

- authenticated or otherwise trusted key issuer;
- namespace binding;
- authorization/scope consistency;
- operation descriptor consistency checks.

### 10.8 Consistency guard

A payload digest may be stored **alongside** the key to detect misuse:

```text
same key + incompatible operation descriptor => reject
```

The digest remains a guard, not identity.

## 11. Design options

### Option 0: no cross-request deduplication

Contract:

> Execute each distinct request instance that GWC receives according to the tool's ordinary semantics.

Advantages:

- matches current evidence;
- no false merging of intentional identical actions;
- requires no invented identity;
- simple and auditable.

Risk:

- if upstream retries a non-idempotent mutation as a distinct request, it can execute twice.

Assessment: **safe baseline semantics today**. It exposes an upstream retry risk rather than hiding it with an unsafe heuristic.

### Option 1: deduplicate by payload/tool or input digest

Advantages:

- easy to implement;
- catches some visibly equivalent duplicates.

Failure modes:

- merges two intentional identical actions;
- payload may contain nondeterministic/defaulted fields;
- equivalent semantics may have non-identical payloads;
- identical payloads may target changing state;
- requires arbitrary temporal windows;
- can return stale/wrong results to a distinct operation.

Assessment: **rejected** as logical identity.

### Option 2: deduplicate by current transport identity

Candidates:

- JSON-RPC ID;
- tunnel `request_id`;
- full `cmd_request_id`.

Failure modes:

- Wave 1 proves distinct tunnel requests can reuse one JSON-RPC ID;
- tunnel `request_id` changes between the observed duplicate requests;
- full `cmd_request_id` changes and its shared prefix has no documented logical-operation contract;
- transport identity describes transport objects, not caller intent.

Assessment: **rejected for cross-request deduplication**. These identifiers remain useful within their actual correlation scope.

### Option 3: upstream logical-operation/idempotency key

With a trusted stable key, GWC could safely recognize:

```text
R1 and R2 are attempts of O
```

This enables:

- concurrent duplicate suppression;
- returning "already running" for the same operation;
- replaying a completed stored result to a retry;
- rejecting same-key/different-operation misuse.

Without durable storage, this remains process-lifetime protection only.

Assessment: **required prerequisite for safe cross-request dedup**.

### Option 4: local durable journal + logical-operation key

Conceptual states per key:

```text
CLAIMED
  -> RUNNING
  -> COMPLETED(result)
  -> DELIVERED? / DELIVERY_UNKNOWN

or

CLAIMED
  -> FAILED
  -> AMBIGUOUS
```

Possible behavior:

- first request atomically claims the key;
- concurrent same-key request observes RUNNING rather than re-executing;
- completed same-key request replays the stored result;
- same key with mismatched operation descriptor is rejected;
- records have bounded TTL.

Crash durability is useful but does not create generic exactly-once semantics.

Critical crash gap:

```text
journal says RUNNING
  ->
external side effect commits
  ->
process crashes before journal records COMPLETED
```

After restart, GWC knows replay may duplicate the effect but may not know the result. The correct state is **AMBIGUOUS**, unless:

- the downstream side effect accepts the same idempotency key and can be queried/replayed safely; or
- side effect and journal update share an atomic transaction.

Assessment: **good future mechanism after Option 3 identity exists**, but not a reason to claim exactly-once.

## 12. Rejected unsafe approaches

### Dedup by tool + args

Rejected because semantic equality does not establish operation identity. It can suppress an intentional repeated action.

### Dedup by input digest

Rejected for the same reason. A digest compresses payload equality; it does not add identity semantics.

### Global dedup by JSON-RPC ID

Rejected. Wave 1 observed two distinct tunnel requests with the same JSON-RPC ID, and Wave 2 showed response-boundary ambiguity when concurrent requests reuse one ID.

### Global dedup by tunnel request_id

Rejected. It identifies one tunnel request; it does not remain stable across a distinct upstream retry.

### Blind replay of mutations

Rejected. Timeout/termination cannot prove that the first mutation did not execute.

### Assume success because local execution finished

Rejected. Local completion does not prove response delivery or caller observation.

### Assume failure because caller saw timeout/termination

Rejected. The local process may still be running or may already have completed.

### Assume readOnlyHint means pure function

Rejected. Hints are classification metadata, not proof of absence of all observable effects. GWC does not enforce retry safety from them, and external MCP annotations are forwarded from remote servers.

### Treat temporal proximity as identity

Rejected. Time ordering/proximity is useful evidence but cannot distinguish an intentional repeated action from a retry.

### Treat diagnostic IDs as production idempotency keys

Rejected. `trace_tag`, `boundary_dispatch_id`, and local execution IDs were created for narrower diagnostic/local scopes and are not stable across logical retries.

## 13. Recommended minimal Wave 4

Wave 4 should **not** begin with generic deduplication.

Recommended scope:

### 13.1 Make ambiguous outcomes first-class

Define an internal recovery/outcome vocabulary that can distinguish at least:

- not started;
- running;
- completed locally;
- failed locally;
- result handed to local transport;
- delivered where positively proven;
- delivery unknown;
- remote timeout/terminated;
- ambiguous.

Do not convert timeout into failure or local completion into delivered.

### 13.2 No new automatic replay for mutations

Keep non-idempotent mutations non-replayable by default.

Do not add payload-based dedup as a compensating mechanism.

### 13.3 Prefer existing job/status recovery

For long-running work:

- return/preserve job handles as early as possible;
- after a wait timeout, poll the same handle instead of starting again;
- use `codexluna_session`'s existing conversation binding/`last_job_id` only as a bounded reacquisition aid, not as proof of logical identity;
- use Herdr session/workspace/pane discovery to reacquire surviving daemon-owned work when identifiers/scope are known;
- do not resend `herdr_pane_run` merely because its acknowledgement was lost.

### 13.4 Audit current internal retry semantics

The Luna manager currently permits one second attempt after a transient failure if no mutating event was observed. Wave 4 should document/test that this heuristic is sufficiently conservative for the intended contract, because it is an existing lower-level retry inside one job.

This is not a request to remove it automatically; it is a request to make its guarantee explicit.

### 13.5 Add no cross-request result replay until upstream key exists

If a generic request journal is added before an upstream operation key exists, keep it request-specific/diagnostic only. Do not use it to merge future equivalent requests.

### 13.6 Define the upstream key integration separately

The first true cross-request dedup implementation should start only after there is a documented source and propagation path for a trusted `logical_operation_id`.

Then a later wave can add:

- durable claim before dispatch;
- running/completed/ambiguous journal states;
- same-key consistency guard;
- bounded TTL;
- result replay for completed operations;
- explicit behavior for crash-after-side-effect ambiguity.

### Minimal implementation outcome

A successful minimal Wave 4 can improve recovery materially **without claiming exactly once**:

```text
reacquire/observe existing work where possible
+
surface ambiguity
+
never blind-replay mutations
+
wait for trustworthy logical-operation identity before cross-request dedup
```

This is the smallest change aligned with the evidence from Waves 0-2.

## 14. Open questions

1. Can the caller/control plane provide an authoritative logical-operation/idempotency key?
2. Does the shared `cmd_request_id` prefix have any documented meaning, and if so is it stable across retries? It must not be used until documented.
3. What authenticated principal/session namespace should own an operation key?
4. What is the maximum upstream retry/recovery horizon? This determines a defensible journal TTL.
5. Can the tunnel propagate a trusted operation key without exposing it as ordinary user tool arguments?
6. What exactly does the observed HTTP 404 "response already fulfilled or unknown request" mean in the control-plane lifecycle?
7. Should response-side tracing gain a stronger request-specific correlator than JSON-RPC ID for concurrent same-ID diagnostics? This would improve observability but still would not create logical identity.
8. Should terminal jobs gain durable/discoverable handles across GWC restart, or is their GWC-owned lifecycle intentional?
9. Is `codexluna_session.last_job_id` sufficient as a practical reacquisition aid after a lost start response, or should jobs be queryable by an eventual logical-operation key?
10. Is the existing Luna transient second-attempt heuristic conservative enough when "mutationSeen" is based on observed event types?
11. Can external MCP servers propagate their own idempotency keys/task handles in a way GWC can preserve without falsely upgrading remote annotations to guarantees?
12. Which result classes may be safely persisted in a future journal, for how long, and with what privacy/redaction requirements?
13. For an Option 4 journal, which operations have a downstream transactional/idempotency mechanism that could reduce the RUNNING-after-crash ambiguity?
14. Should explicit user-facing/operator diagnostics distinguish `LOCAL_COMPLETED_REMOTE_UNKNOWN` from ordinary failure to make recovery decisions auditable?

## Definition-of-done answers

1. **What is "one request" in GWC?** One concrete MCP tool-handler entry occurrence, not a globally unique JSON-RPC-ID value.
2. **What is one logical operation?** One authoritative caller intention that may span multiple request attempts and requires its own stable identity.
3. **Why are they not equivalent today?** No observed identity remains authoritative and stable across distinct upstream requests.
4. **What does GWC guarantee per received request?** One top-level native handler dispatch per request instance under the current handler path, subject to tool-internal retry semantics such as Luna's restricted second attempt.
5. **What can GWC not guarantee between distinct requests?** Same logical operation, deduplication, effectively-once, or exactly-once.
6. **How are operation classes treated?** Observations may be re-observed under their concrete contract; explicitly idempotent mutations may be replay-safe only within that contract; non-idempotent mutations are not blindly replayed; long jobs prefer handle/status recovery.
7. **How is a late result treated?** Preserve local truth separately from delivery truth; do not hand it to an equivalent future request without authoritative operation identity.
8. **When is execution ambiguous?** Whenever local effect/result or remote acceptance cannot be jointly determined well enough to make replay safe.
9. **What identity enables safe dedup?** A trusted upstream logical-operation/idempotency key born before first dispatch, stable across retries, uniquely namespaced, TTL-bound, and propagated unchanged to GWC.
10. **What is the minimum recommended Wave 4?** Ambiguity-aware recovery and job reacquisition without automatic mutation replay or heuristic cross-request dedup.
