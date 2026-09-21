# Wave 0 resilient MCP transport diagnostic protocol

This protocol is intentionally diagnostic-only. It does not change the launcher,
tunnel supervisor, MCP server, transports, Herdr integration, direct tools, or
external MCP bridge.

## Evidence location

Real reproductions must write under this worktree:

```text
diagnostics/wave0-runs/<run-id>/
```

The directory is excluded only through the local Git exclude file and must not
be committed. Keeping it inside the worktree lets reviewers audit the complete
raw evidence without depending on `~/.local/state`.

A completed run directory is expected to contain at least:

- `metadata.json`
- `samples.ndjson`
- `process-events.log`
- `ip-monitor.log`
- `journal-network.ndjson`
- `journal-proton.ndjson`
- `tunnel-events.ndjson`
- `tunnel-health.ndjson`
- `runtime-status-before.json`
- `runtime-status-after.json`
- `recorder-result.json`
- `observations.ndjson`
- `summary.md`

## Mandatory recorder ownership rule

The recorder must be launched from a persistent Herdr pane with
`herdr_pane_run`. Do not launch it with `terminal_start` or
`terminal_exec`.

The reason is lifecycle ownership. Direct terminal jobs are GWC-owned and may
be terminated when `DirectToolService.shutdown()` tears down owned process
trees. A Herdr pane is owned by the persistent Herdr daemon instead.

The recorder enforces this rule at runtime. At startup it records its own
PID/PPID/starttime and complete parent chain and refuses to run if either the
GWC MCP process or tunnel-client appears in that ancestry. The evidence is
stored in:

```text
metadata.json -> recorder_independence
```

A valid real run must have:

```json
"independent_of_gwc_and_tunnel": true
```

The Herdr command that submits the recorder is expected to return while the
recorder keeps running. This is deliberate: the recorder must not depend on a
later MCP call to stop. It exits automatically after `--duration`.

## Target-process precondition

A run is classifiable only if recorder startup finds exactly one:

- tunnel-client for profile `codex-chatgpt-web`;
- GWC `.../app/cli.js mcp --state-path ...` process;
- Herdr server.

The GWC process must also have the unique tunnel-client in its live ancestry.
The matcher is structural rather than tied to one absolute GWC installation
path. If any required role has zero or multiple matches, or the ownership
relationship is absent, the recorder exits non-zero **before creating the run
directory**. Missing observability is therefore never interpreted as a stable
process.

A valid run persists this startup proof in:

```text
metadata.json -> target_precondition
```

## Process identity and topology

Process restart is determined from:

```text
(PID, /proc/<pid>/stat field 22 starttime)
```

PPID is not part of process identity.

A PPID change with the same PID/starttime is recorded separately as
`parent_relationship_change`; it is not a restart. A true identity change is
recorded as `process_identity_change`.

The recorder also stores ancestry for the GWC MCP process and tunnel-client in
the initial metadata, on topology/identity changes, and in the final result.
This lets a reviewer distinguish:

- GWC restart;
- GWC survival with reparenting;
- tunnel restart;
- simultaneous restart without proven causality;
- direct or indirect tunnel -> GWC ownership.

A classification of B or C does not by itself prove that stdio caused a GWC
restart. Any recommendation to decouple stdio requires the ancestry/ownership
evidence to support that causal interpretation.

## Observation layers

Keep these variables separate:

1. network/routing;
2. tunnel-client process identity;
3. GWC MCP process identity;
4. Herdr daemon identity;
5. connector usability;
6. the specific deliberate MCP invocation.

`runtimes status` is contextual evidence only. It may require control-plane
observation and must never be used as proof that the local tunnel process died.
Process survival is decided from `/proc` identity. Local `/healthz` and
`/readyz` are separate loopback observations.

## Lateral connector/invocation evidence

Each run has `observations.ndjson`, appended with:

```bash
python scripts/diagnostics/record_wave0_observation.py ...
```

Use it to record, separately:

- when the run is armed;
- the instruction to press Proton Connect;
- the deliberate invocation start, if any;
- the invocation's terminal outcome;
- a visible `Session terminated` observation, if one occurs;
- the first post-transition connector probe;
- the connector probe result.

The recorder's projected tunnel log retains `request_id`,
`cmd_request_id`, and `rpc_request_id`. During analysis, correlate the
single deliberate invocation using its isolated invocation window, tool
start/end observation, local tagged-process lifecycle, and ordered tunnel
events. Do not assume the relevant dispatcher event is closest to invocation
start: the current tunnel log may emit that event near tool completion. When a
unique correlation is available, append the request IDs to
`observations.ndjson`. If correlation is ambiguous, record
`outcome=ambiguous`; do not guess.

A later successful connector call is evidence only that the connector became
usable again. It is not evidence that an earlier invocation survived.

## Read-only deliberate invocation

For Runs 2 and 3, use:

```text
scripts/diagnostics/read_only_invocation_probe.py
```

through a deliberate MCP `terminal_exec` call. The probe performs repeated
reads of `/proc` and filesystem metadata for a bounded duration. It does not
write files or mutate the system.

Give it a unique non-secret `--tag`, and launch the recorder with the same
`--watch-pattern`. The recorder will then preserve the local process
identity/lifecycle of that invocation independently of the remote MCP response.

This provides three distinct observables:

- remote invocation result;
- local probe-process lifecycle;
- later connector usability.

The probe may use short sleeps only to pace repeated read-only work; its
evidence is the repeated reads and independently observed process lifecycle,
not the sleep itself.

## Run 1: IDLE

1. Proton must be disconnected and stable.
2. Confirm one read-only MCP call works before arming the run.
3. Choose a unique **not-yet-existing** output path under
   `diagnostics/wave0-runs/`. Do not pre-create it; the recorder is the sole
   authority that creates the run directory with `exist_ok=False`.
4. Launch the autonomous recorder in a Herdr pane for about 90 seconds.
5. Verify at least 10 seconds of samples already exist and
   `proton0` is absent.
6. Append `run_armed` and `vpn_connect_instruction`.
7. No deliberate MCP invocation may be active when the user presses Connect.
8. Instruct the user: `READY FOR PROTON RUN 1 — press Connect now`.
9. When the user next confirms they pressed Connect, append
   `vpn_connect_user_confirmed`. This is lateral evidence only.
10. Do not use the MCP path merely to poll during the outage.
11. After the connector becomes usable, make one new read-only connector call
    and record that result separately.
12. Let the recorder terminate by duration.
13. Preserve the complete run directory in the worktree.
14. Treat the recorder's physical network evidence as authoritative. A real
    Connect reproduction must finish with
    `recorder-result.json -> transition_evidence.transition_valid = true`.
    The validity rule requires all of the following:
    - initial `proton0` absent and final `proton0` present;
    - a sustained public-reachability outage lasting at least 2,000 ms with
      multiple unreachable samples and an observed recovery;
    - that outage starts before the first appearance of `proton0`, and
      `proton0` appears either during it or no more than 3,000 ms after the
      first recovered sample;
    - an observed IPv4 default-route or `ip rule` change.
    A TCP hiccup, an outage long before Proton, or an outage that begins after
    `proton0` already appeared is not associated evidence. If no associated
    outage satisfies these conditions, the run is **INVALID / NOT
    CLASSIFIABLE**, regardless of PID stability or a manual Connect
    instruction/confirmation.

## Run 2: READ-ONLY around transition

1. Return Proton to disconnected/stable state.
2. Launch a fresh recorder in an independent Herdr pane.
3. Use a unique invocation tag and pass it to both `--watch-pattern` and the
   read-only invocation probe.
4. Record `invocation_start`.
5. Tell the user to press Connect and immediately issue one bounded read-only
   MCP `terminal_exec` probe intended to overlap the transition.
6. Record the exact tool outcome as one of:
   `success`, `session_terminated`, `timeout`, `error`, or
   `ambiguous`.
7. After recovery, perform and record a separate connector-usability probe.
8. Do not reinterpret the later probe as survival of the original invocation.

## Run 3: READ-ONLY LONG-RUNNING

1. Return Proton to disconnected/stable state.
2. Launch a fresh independent recorder with a unique watch tag.
3. Start the read-only invocation probe through MCP with a duration comfortably
   longer than the expected 7-8 second network interruption.
4. Once the tagged local probe process is visible in `samples.ndjson`, instruct
   the user to press Connect.
5. Record the remote invocation outcome.
6. Independently inspect the tagged process lifecycle in the recorder:
   - continued running after remote termination;
   - completed normally;
   - disappeared when GWC disappeared;
   - indeterminate.
7. After recovery, record a separate connector-usability probe.

## Network and journal privacy boundary

No environment dump is captured.

Command lines are redacted for token/key/authorization-like arguments.
Any textual `Authorization:` or `Authorization=` value is redacted in full
through end-of-line, regardless of authentication scheme (Basic, Digest,
AWS-style, custom, or otherwise).

Tunnel-client log ingestion is a field whitelist and sanitizes string values.

NetworkManager and Proton journals are converted to NDJSON containing only:

- realtime timestamp;
- unit;
- priority;
- sanitized message;
- recorder observation timestamp.

Runtime status is projected to local process/readiness/control-plane health
fields only. Raw runtime-status JSON is not persisted.

Raw route/interface/socket observations remain because they are required by the
experiment, but no credentials or authorization material should be present.

## Classification rules

First require both:

- `metadata.json -> target_precondition.valid = true`;
- `recorder-result.json -> transition_evidence.transition_valid = true`.

If either is false, the run is **INVALID / NOT CLASSIFIABLE** and must not be
mapped to A/B/C/D.

For a valid run, use only strong process identity:

- A: tunnel same + GWC same;
- B: tunnel changed + GWC changed;
- C: tunnel changed + GWC same;
- D: tunnel same + GWC changed.

"Same" means same PID and same starttime. PPID-only changes are topology
changes, not restart.

Do not force one global classification if the three runs differ.

No stdio -> HTTP recommendation is justified merely because the network or
connector experienced an outage. It requires evidence that GWC lifecycle is
actually coupled to tunnel lifecycle in a way a persistent localhost transport
would address.
