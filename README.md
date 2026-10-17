# GPT Web Codex

**ChatGPT-to-local-workspace bridge, shell-first.**

An independent, community-maintained fork · **v2.3.0** · [MIT license](LICENSE)

[![CI](https://github.com/brianmsm/gpt-web-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/brianmsm/gpt-web-codex/actions/workflows/ci.yml)
[English](README.md) · [简体中文 (legacy translation)](README.zh-CN.md)

GPT Web Codex connects an ordinary ChatGPT conversation to tools running on **your own computer** through an OpenAI Secure MCP Tunnel. It prioritizes direct local tools and **persistent, observable shell sessions in [Herdr](docs/herdr.md)**. Codex Luna remains available as a separate, explicitly opted-in worker, not the default execution engine.

This is a substantially evolved fork of [m4j2rpf766-crypto/gpt-web-codex](https://github.com/m4j2rpf766-crypto/gpt-web-codex), itself based on [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web). Thanks to the original maintainers and contributors. This project is **not affiliated with or endorsed by OpenAI**.

> **Security warning:** This is a powerful local execution bridge, **not a hardened command sandbox**. A model using permitted shell tools can execute destructive commands, modify files outside the intended project, access secrets visible to the OS user, or send data over the network. There is **no general destructive-command blocklist or mandatory command-by-command human approval gate** for persistent shells. Do not expose it to untrusted users, prompts, or repositories; read [Security](#security-read-this-first) before connecting it.

## Why this fork?

The priority is **local tools first, persistent shells when needed, agent delegation by choice**:

| Capability | What you get |
| --- | --- |
| **Direct local operations** | `file_*` tools, foreground/background `terminal_*` commands, bounded output, explicit workspace scope. |
| **Herdr persistent shell** | Real, user-visible PTYs, workspaces, tabs and panes. Processes can outlive a ChatGPT response or GWC runtime restart because Herdr owns them. |
| **External MCP servers** | An allowlisted MCP client bridge over stdio or Streamable HTTP; remote tools appear as `alias__tool`. |
| **Browser tools (optional)** | Use Chrome DevTools MCP with an isolated Chromium profile. A Linux `systemd --user` integration can wake it on the first authorized browser-tool call. |
| **Codex Luna (optional)** | `codexluna_*` jobs with durable conversation binding and explicit opt-in; no silent model/provider rerouting. |
| **Session capability profiles (experimental)** | Per-conversation *tool-name* rules with known identity and isolation limitations. Not a multi-tenant security boundary. |

### How it works

```text
ChatGPT conversation
      │  approved MCP tool call
      ▼
OpenAI Secure MCP Tunnel
      │
      ▼
GWC standalone MCP runtime
      ├─ file_* / terminal_*        direct local work
      ├─ herdr_*                   persistent, visible PTYs
      ├─ <alias>__<tool>           external MCP servers
      │     └─ optional Chrome DevTools MCP → dedicated Chromium
      └─ codexluna_*              optional Codex delegation
```

**Persistent does not mean automatic replay.** GWC distinguishes new work from previously running/uncertain work. Herdr shells persist in Herdr; ordinary direct-terminal and Luna job lifecycles have different boundaries. See [Architecture](docs/architecture.md) and [Recovery semantics](docs/diagnostics/WAVE4_RECOVERY_WITHOUT_BLIND_REPLAY.md).

## Quick start

**Requirements:** a trusted Windows or Linux computer (the source has been manually exercised on Ubuntu and Omarchy/Arch), a ChatGPT account or workspace **eligible to connect custom MCP servers**, an OpenAI **Secure MCP Tunnel** and a Tunnel Runtime Key with **Tunnels: Read + Use**, and **Bun 1.3.14** for building from source. Herdr and Codex CLI are optional, according to the tools you want. macOS has CI coverage but is not a manually validated deployment target.

**1. Download and install source dependencies.**

```bash
git clone https://github.com/brianmsm/gpt-web-codex.git
cd gpt-web-codex
bun install --frozen-lockfile
```

> The source release requires Bun 1.3.14. Check with `bun --version`. Packaged desktop launchers bundle their runtime, but a published binary release and this source checkout are different things.

**2. Create your tunnel and restricted runtime key.**

In the OpenAI Platform, create a [Secure MCP Tunnel](https://platform.openai.com/settings/organization/tunnels) and a [Runtime Key](https://platform.openai.com/settings/organization/api-keys) with only the required **Tunnels: Read + Use** permissions. Store the key in a private file (`chmod 600` on Linux); do not paste it into ChatGPT or pass it as a command-line argument.

**3. Configure GWC (new installations only).**

```bash
bun run src/cli.ts setup \
  --full --mcp-only \
  --tunnel-id 'tunnel_YOUR_ID' \
  --runtime-key-file '/path/to/private/runtime-key' \
  --acknowledge-unofficial

bun run launcher:dev
```

The launcher owns the normal local runtime lifecycle. If you already have a **protected or customized running GWC tunnel**, **do not rerun setup or click “Reconnect saved tunnel” blindly**: setup can replace a pinned wrapper or change runtime ownership. See [Linux deployment](docs/linux.md) and make a verified backup first.

**4. Add the connector in ChatGPT.**

In supported ChatGPT accounts, go to **Plugins → Add custom MCP server** (the location/name may vary), select **Tunnel**, supply your Tunnel ID, review the tool permissions and create the connection. Existing installations may use the historic name *WebGPT Luna Standalone*; you do not need to rename it.

Open a ChatGPT conversation, select or mention the connector and try a **harmless read-only task** such as listing a known disposable project directory. A passing local `doctor` check alone does not establish that ChatGPT can call the MCP tools.

Official instructions: [Connecting custom MCP servers in ChatGPT](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt). Availability, allowed actions and approvals depend on your account/workspace.

## Using a persistent Herdr shell

Herdr is an **optional separate application**. GWC bridges to its session/socket and addresses explicit workspace, tab and pane IDs rather than imitating keystrokes in an arbitrary window.

1. Install and start Herdr, then confirm `herdr session list --json` works. The tested integration targets **Herdr 0.8.2 / Socket API protocol 20**.
2. In a ChatGPT conversation, ask GWC to open an **authorized local workspace in Herdr** and run a non-destructive command in its pane.
3. Inspect or attach to the same session in Herdr. The terminal process remains visible and can be reacquired after the ChatGPT reply finishes or GWC reconnects.

The `workspace_path` and `permission_mode` arguments scope which Herdr workspace/pane can be selected; **they do not sandbox commands inside that shell**. See [Herdr guide](docs/herdr.md).

For one-shot operations, prefer direct `file_*` or `terminal_exec` instead of opening a persistent shell.

## External MCP and browser configuration

GWC can act as an MCP *client*. Create `~/.codex-chatgpt-web/external-mcp.json` (optional) using [external-mcp.example.json](external-mcp.example.json):

```json
{
  "version": 1,
  "servers": {
    "my-tools": {
      "transport": "stdio",
      "command": "/absolute/path/to/trusted-mcp-server",
      "args": [],
      "inherit_env": ["PATH"],
      "required": false,
      "tools": { "allow": ["status", "search"] }
    }
  }
}
```

GWC does **not** discover random local MCP servers automatically. Configure only trusted servers, pass only necessary environment variables, and restart the **GWC MCP runtime safely** to update its startup catalog. For HTTP servers, see [External MCP bridge](docs/external-mcp.md).

An **optional Omarchy/Hyprland Chrome DevTools recipe** runs Chromium with a separate profile and loopback CDP, supervised by `systemd --user`. The integration can wake the browser just before an authorized Chrome MCP tool call. It is not enabled by default for other machines. See [Chrome auto-wake setup and boundaries](docs/chrome-browser.md). Do not expose a CDP port publicly; any local process with access to it can control that browser.

## Security: read this first

**Do not treat “workspace-write”, a tool annotation, or a conversation-level instruction as a secure OS sandbox.**

- **Arbitrary commands:** `terminal_exec`, `terminal_start`, `herdr_pane_run` and `herdr_pane_send` can execute commands with the permissions of the local user or Herdr process. **There is no general protection against `rm -rf`, overwriting a repository, credential access or network exfiltration.** No built-in mandatory human confirmation exists for each shell command.
- **Persistent execution:** A Herdr pane can continue after the model stops replying. Losing a tool result does not prove that the command failed; **never blindly replay** side-effecting operations.
- **Prompt injection:** Files, websites, terminal output and external MCP results can contain hostile instructions. Review instructions before allowing tools to mutate your system.
- **Access control:** Session Capability Profiles limit listed tools by conversation when configured, but do not authenticate arbitrary clients or constrain an already-authorized shell's filesystem/network reach. `danger-full-access` deliberately disables path scoping.
- **Browser/credentials:** A Chrome DevTools connection can expose logged-in sessions. Keep tunnel keys and profiles private; use a dedicated browser profile, a low-privilege OS account or stronger isolation for risky workloads.

Use this project only on **systems and data you control**. Prefer read-only tasks, backups, narrow tool allowlists and an OS-level sandbox/container. See [Security policy](SECURITY.md), [Security model](docs/security-model.md) and [Session Capability Profiles](docs/session-capabilities.md).

## OpenAI compatibility and terms

OpenAI [documents custom MCP server connections and Secure MCP Tunnel](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt). GWC uses that integration to accept **tool calls initiated inside ChatGPT**. It does **not** automate ChatGPT's conversation web UI to extract model responses, scrape chat histories, imitate user input or bypass rate limits. The separate Chromium integration operates on **user-authorized third-party websites**, not as a ChatGPT scraping engine.

OpenAI's [app guidance](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) and [Terms of Use](https://openai.com/policies/terms-of-use/) (or the [Europe terms](https://openai.com/policies/eu-terms-of-use/) if applicable) still apply: custom MCP support is **not** a blanket authorization for every command, write action, automation or account/plan. Automated extraction and circumvention of platform safeguards are restricted. Users are responsible for authorization, tool safety and applicable terms. **We do not claim a formal OpenAI security review, endorsement or legal/compliance certification.**

## Development and release

```bash
bun run check-version
bun run typecheck
bun test tests
bun run launcher:typecheck
bun run launcher:test
```

Version **v2.3.0** follows standard semantic versioning. See [CHANGELOG.md](CHANGELOG.md) for the fork's changes and validation scope. The release workflow first stages binary assets as a private **GitHub Release draft**. The maintainer must review its CI results, signatures and checksums before manually publishing. A source version/tag is not evidence that an installer has already been published.

Contributions are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). The MIT license and required third-party notices are in [LICENSE](LICENSE) and [LICENSES](LICENSES).
