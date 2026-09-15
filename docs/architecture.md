# GPT Web Codex architecture

The product has five runtime boundaries:

1. The Electron launcher owns a persistent ChatGPT browser profile and normal conversation tabs.
2. An OpenAI Tunnel carries MCP calls from the selected ChatGPT connector to the local runtime.
3. The standalone MCP server exposes high-level Luna jobs, direct file/terminal tools, and the optional external Herdr bridge.
4. The Luna job manager runs `codex exec --json`, persists the Luna session id, job state, and web-session binding, and serializes work per web session.
5. Herdr, when installed and selected explicitly, remains the independent owner of its workspaces and PTYs; GWC discovers the session/socket and controls explicit IDs without adopting Herdr process ownership.

The stable address-bar conversation URL is the web session identity. Tabs are not identities. Returning to the same conversation restores the same Luna session after launcher or MCP process restarts.

The launcher supervisor starts only the standalone MCP tunnel runtime. There is no Responses proxy, Codex model provider, model-catalog injection, or Codex routing lifecycle.

Browser automation remains shared by sign-in verification, smoke testing, connector verification, and the visible memory-boundary bootstrap. Startup restores the last stable `/c/` conversation without injecting prompts; the bootstrap runs only from the explicit new-conversation action. These browser-maintenance paths do not provide a Codex model route.

Long Luna jobs are asynchronous. The MCP call returns a job id; status is read separately. A default 15-minute job timeout requests cancellation of the owned child process tree but preserves the web-to-Luna session binding for later continuation.

The three local permission modes map explicitly to Codex sandbox flags. `workspace-write` is the default; `read-only` and `danger-full-access` are caller-selectable. Network access is permitted in write and full-control modes.

## Herdr ownership boundary

The Herdr bridge is not part of `DirectToolService` and does not use Luna. GWC discovers named Herdr sessions through `herdr session list --json`, then uses Herdr 0.8.2 Socket API protocol 20 directly over the selected Unix socket. It never fabricates `HERDR_ENV` or contextual `HERDR_*` variables and never chooses a target from UI focus.

A normal GWC shutdown stops only processes owned by the Luna/direct-process managers. It deliberately has no Herdr shutdown hook, so a Herdr pane can survive an MCP process restart and be resumed by its real `session`/`workspace_id`/`tab_id`/`pane_id`/`terminal_id`. See [Herdr bridge](herdr.md).
