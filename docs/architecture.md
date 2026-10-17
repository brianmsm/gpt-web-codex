# GPT Web Codex architecture (v2.3.0)

The fork connects **ChatGPT tool calls to a self-hosted MCP runtime**. Its execution preference is direct local tools first, persistent user-visible Herdr shells when needed, and Codex Luna only after explicit opt-in.

```text
ChatGPT (normal web UI)
      |
      | MCP tools, via OpenAI Secure MCP Tunnel
      v
GWC standalone MCP server (local machine)
      +-- direct file/terminal tools        OS user + workspace parameters
      +-- Herdr bridge                      real Herdr PTYs and worktrees
      +-- configured external MCP servers  stdio or Streamable HTTP
      |      +-- optional Chrome DevTools MCP/browser
      +-- Codex Luna (optional)             codex exec --json jobs
```

## Runtime owners

**Launcher and tunnel.** The Electron launcher is a local lifecycle/configuration control surface. The local standalone MCP server is reached through OpenAI's Tunnel. Normal ChatGPT conversations use that connector; the project's MCP-only mode does not need to drive the ChatGPT conversation DOM. The launcher may still have optional browser maintenance workflows; these are not a way to automate ChatGPT responses.

**Direct tools.** GWC owns local direct terminal jobs, their in-memory job identities and associated output. Jobs may continue beyond a ChatGPT response, but they are **not Herdr PTYs** and are not generally reacquirable after process restart without their documented state. The direct file tools handle imports, reads, mutations and image previews under documented workspace checks.

**Herdr.** Herdr owns its own durable Unix-socket session, workspaces, worktrees, tabs, panes and PTYs. GWC is a client of Herdr's Socket API protocol 20 (tested against Herdr 0.8.2); it does not kill or take over existing Herdr processes when GWC closes. Callers reuse concrete returned IDs, not UI focus or the "last active" pane.

**External MCP.** GWC loads explicitly configured stdio/Streamable HTTP servers when initializing its tool catalog. Discovered tools are prefixed by the configured alias. Server startup and remote tool execution are separate bounded operations. The optional Chromium-on-demand wrapper is specific to one reviewed Linux deployment, not core GWC behavior.

**Codex Luna.** Luna jobs are asynchronous, bound to a web conversation and run through `codex exec --json` only after explicit authorization. This does not change Codex model providers, update `~/.codex/config.toml` or proxy the Responses API.

## Authorization and identity

GWC provides `read-only`, `workspace-write` and `danger-full-access` modes for relevant tools. File/Herdr workspace argument checking limits *tool targets* but **does not isolate shell processes at the OS level**. An authorized shell can generally execute whatever commands the host OS user permits.

Experimental Session Capability Profiles allow exact per-conversation tool-name rules and optional separately launched stdio servers. They are not equivalent to authenticated isolation between mutually untrusted tenants and do not control other ChatGPT apps or Memory. See [Session capabilities](session-capabilities.md) and [Security](security-model.md).

## Recovery without blind replay

An MCP timeout does **not** prove the operation failed. GWC must avoid re-running commands or mutations after uncertain results. The managed local process, Herdr-owned PTY, external MCP process and Luna job have different lifecycles. For the precise boundaries and observed cases, see [Wave 4 recovery semantics](diagnostics/WAVE4_RECOVERY_WITHOUT_BLIND_REPLAY.md).

## Browser boundary

The optional Chrome DevTools MCP bridge can connect to a separate Chromium user-data directory on loopback. A `systemd --user` service may wake the dedicated browser before an authorized Chrome tool call. This arrangement does not expose the browser to the public internet, but any sufficiently privileged local process with CDP access may still read or control its pages. See [Chrome wake diagnostics](chrome-browser.md).

Neither CDP nor the Electron browser maintenance workflows are used to scrape the ChatGPT UI for model responses.
