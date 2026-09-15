# Herdr bridge

GPT Web Codex can use Herdr as an external owner of persistent, user-visible PTYs. This bridge is intentionally separate from direct terminal jobs and Luna jobs.

Validated implementation target: **Herdr 0.8.2, Socket API protocol 20**.

## Runtime model

```text
ChatGPT Web
    │ MCP
    ▼
GPT Web Codex standalone runtime
    ├── file_*        direct filesystem access
    ├── terminal_*    direct short/owned processes
    ├── codexluna_*   Luna jobs
    └── herdr_*       explicit external Herdr control
              │
              ├── herdr session list --json   session/socket discovery only
              └── Unix Socket API protocol 20
                         │
                         ▼
                      Herdr
                         │
                  workspace/worktree
                         │
                        tab
                         │
                        pane
                         │
                     real PTY
```

The preferred Git layout is:

```text
main checkout                     integration/review
├── linked worktree A  ≈ Herdr workspace A
├── linked worktree B  ≈ Herdr workspace B
└── linked worktree C  ≈ Herdr workspace C
```

A Herdr **tab** is an activity inside a workspace. A **pane** is the concrete PTY/process surface. A tab is not a worktree.

## Transport and identity

GWC discovers named sessions with the machine-readable external command:

```bash
herdr session list --json
```

After an explicit session is selected, all workspace/tab/pane operations use Herdr's Unix Socket API directly. Herdr 0.8.2 uses newline-delimited JSON requests and responses over the session socket.

GWC does **not** set or require `HERDR_ENV=1` and does not fabricate `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`, or `HERDR_SOCKET_PATH`. Those variables belong to processes that were actually launched in Herdr. The bridge is an external client instead.

Targets are explicit. Responses preserve the real identities returned by Herdr, including the relevant `session`, `workspace_id`, `tab_id`, `pane_id`, `terminal_id`, worktree path, and branch when Herdr supplies them. Later calls reuse those IDs rather than UI focus or "last created" state.

## MCP tools

| Tool | Class | Input | Purpose |
| --- | --- | --- | --- |
| `herdr_status` | read | `session?` | Discover sessions and probe server/version/protocol health. |
| `herdr_workspace_open` | mutate, idempotent | `session`, `cwd`, `label?` | Reuse the unique workspace matching an exact checkout/pane cwd or create one with `focus:false`. |
| `herdr_worktree_create` | mutate | `session`, `source_cwd`, `branch`, `base?`, `path?`, `label?` | Create a linked Git worktree and its Herdr workspace. |
| `herdr_tab_create` | mutate | `session`, `workspace_id`, `cwd?`, `label?` | Create an activity tab and return its root pane. |
| `herdr_pane_split` | mutate | `session`, `target_pane_id`, `direction`, `cwd?`, `ratio?` | Create another real PTY by splitting an explicit pane. |
| `herdr_pane_run` | mutate | `session`, `pane_id`, `command` | Send a command plus Enter atomically to an explicit pane. |
| `herdr_pane_read` | read | `session`, `pane_id`, `source?`, `lines?`, `strip_ansi?` | Read terminal output without inferring liveness from an empty result. |
| `herdr_pane_send` | mutate | `session`, `pane_id`, `text?`, `keys?` | Send interactive text and a bounded set of special keys. |
| `herdr_pane_wait` | read/wait | `session`, `pane_id`, `match`, `match_type?`, `source?`, `lines?`, `timeout_ms?` | Use Herdr's wait-for-output mechanism rather than GWC polling. |
| `herdr_pane_status` | read | `session`, `pane_id` | Read pane identity plus shell/foreground-process information when available. |

There is deliberately no generic `herdr_call(method,args)` tool and no destructive `close`, `remove`, `kill`, or `stop` tool in the MVP.

The bridge distinguishes `healthy`, `failed`, `unknown`, and `not_found` where the Herdr response allows it. A transport timeout or `pane.wait_for_output` timeout maps to `unknown`, not to a dead process. Observational failures never cause cleanup.

## Ownership and restart behavior

Herdr owns Herdr PTYs. GWC does not persist a second ownership database for them and has no Herdr shutdown hook. Closing or restarting the standalone GWC MCP process therefore does not ask Herdr to terminate panes.

To resume after a GWC restart, rediscover the same Herdr session and call `herdr_pane_read`, `herdr_pane_send`, or `herdr_pane_status` with the previously returned `pane_id`. The real terminal stays in Herdr as long as Herdr itself keeps that workspace/pane alive.

This differs from `terminal_start`, whose child process is owned by `DirectToolService`, and from Luna subprocesses, which are owned by the Luna job manager.

## Herdr 0.8.2 lifecycle caveat for worktree groups

Herdr groups a repository's source/main workspace with its linked-worktree workspaces. In Herdr 0.8.2, closing the **source/parent workspace** closes the whole worktree workspace group. Closing an individual linked-worktree workspace closes only that linked workspace.

Because this behavior can terminate multiple PTY surfaces at once, GWC does not expose workspace-close or worktree-remove operations in the MVP. Keep the integration/source workspace open while linked worker workspaces must remain available.

## Real local smoke test

Requirements:

- `herdr` on `PATH` (validated with 0.8.2);
- the selected Herdr session running;
- project dependencies installed with the pinned Bun version for release validation.

Run:

```bash
GWC_HERDR_SESSION=default bun run smoke:herdr
```

The smoke test creates a disposable Git repository under `/tmp`, opens its source checkout as an integration workspace, asks Herdr to create a linked worktree/workspace, starts a real PTY worker, reads and writes it through MCP, closes the first MCP client, starts a fresh MCP client, and proves that the fresh process can read and write the **same pane ID**. It ends only the test worker loop; the Herdr shell/workspace is intentionally left open for visual inspection.

The receipt includes:

- `integration_workspace_id`;
- `worker_workspace_id`;
- `tab_id`;
- `pane_id`;
- `terminal_id`;
- branch and worktree path;
- health before/after the MCP restart.

The test never sends Herdr close/remove/kill operations.

## Inspecting the same PTY in Herdr

Given a receipt such as `session=default`, `worker_workspace_id=wQ`, `tab_id=wQ:t1`, `pane_id=wQ:p1`:

```bash
herdr --session default workspace get wQ
herdr --session default tab get wQ:t1
herdr --session default pane get wQ:p1
herdr --session default pane read wQ:p1 --source recent --lines 80
herdr --session default pane process-info --pane wQ:p1
```

To bring the persistent session into the Herdr application:

```bash
herdr session attach default
```

An already-running Herdr application can also be directed to the exact workspace and tab:

```bash
herdr --session default workspace focus wQ
herdr --session default tab focus wQ:t1
```

Herdr 0.8.2 does not expose a direct absolute `pane focus <pane_id>` command; pane focus is directional. The returned `pane_id` and `terminal_id` still identify the exact PTY for API/MCP operations. In a multi-pane tab, select that identified pane in the Herdr UI. A single-pane tab, including the smoke test tab, opens directly onto that PTY.

## ChatGPT Web rollout

The existing Secure MCP Tunnel can carry these tools; no second tunnel or KAI-like supervisor is required. After building and installing a GWC version containing this bridge, restart the launcher/runtime and **refresh the existing Developer Mode connector/tool definitions** because ChatGPT caches MCP tool contracts. The existing connector name, Tunnel transport, and Authentication `None` configuration can remain unchanged.

Do not replace a working installed launcher merely to test source changes. Validate source tests and `smoke:herdr` first, then build the Linux launcher and install it only when explicitly approved.

## Known limitations

- The bridge is validated against Herdr 0.8.2 / protocol 20. A different protocol is reported unhealthy rather than guessed compatible.
- Session discovery depends on the installed Herdr CLI's `session list --json`; runtime control after discovery goes directly to the socket.
- `herdr_workspace_open` has robust checkout identity for Git/worktree workspaces because Herdr exposes `worktree.checkout_path`. For a non-Git workspace without worktree metadata, matching falls back to exact current pane cwd; if every pane has changed directory, opening by the original cwd may create a new workspace rather than guessing.
- Plain shell panes can legitimately report Herdr `agent_status="unknown"`; process information and pane existence remain separate signals.
- The MVP does not expose destructive Herdr operations or a generic RPC escape hatch.
- The Herdr 0.8.2 CLI can focus a workspace/tab by absolute ID but pane focus itself is directional, as described above.
