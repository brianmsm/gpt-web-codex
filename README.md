# GPT Web Codex

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/m4j2rpf766-crypto/gpt-web-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/m4j2rpf766-crypto/gpt-web-codex/actions/workflows/ci.yml)

GPT Web Codex is a pure MCP launcher. A normal ChatGPT Web conversation is the planner; Luna executes and verifies local work through `codex exec --json` without changing Codex configuration or routing.

> **Platform status:** Windows and Ubuntu 26.04 x86_64 have completed real-world manual testing. Linux verification covers the AppImage, standalone MCP, terminal and directory tools, Luna execution and session resume, and an actual ChatGPT Web tool call. macOS is covered by automated CI but has not yet been tested manually.

## What it does

- Uses ChatGPT in the user's normal browser; the launcher never embeds or automates ChatGPT.
- Binds each stable ChatGPT conversation URL to one persistent Luna session.
- Exposes asynchronous `codexluna_*` tools, direct file/terminal tools, and an optional explicit Herdr 0.8.2 bridge over MCP.
- Serializes Luna work inside one web session while allowing different web sessions to run independently.
- Supports `read-only`, `workspace-write`, and `danger-full-access` execution modes.
- Keeps long-running jobs alive when the ChatGPT reply finishes; jobs can be polled or cancelled explicitly.
- Returns verified user-relevant image artifacts from completed Luna jobs as native MCP image content for inspection, then directs ChatGPT to create one deduplicated visible card through `file_image_preview` even when the user did not explicitly ask to preview the graph.
- Restores inline image previews after a ChatGPT page refresh from a bounded private local cache without copying Base64 into model-visible structured results.
- Safely imports files uploaded to the current ChatGPT conversation into a user-disclosed local workspace for direct tools or Luna.

## What it does not do

GPT Web Codex does **not** edit `~/.codex/config.toml`, install a model provider, replace the model catalog, proxy the Responses API, or take over Codex routes. You do not select a ChatGPT Web model inside Codex. ChatGPT Web plans; Luna executes locally.

## Runtime flow

```text
normal ChatGPT conversation
        │ MCP tool calls
        ▼
OpenAI Tunnel → standalone local MCP runtime
        │
        ├─ codexluna_init/start/status/cancel/session
        ├─ file_import_attachment / file_read / preview / list / search / write
        ├─ file_create_directory / file_delete_directory
        ├─ terminal_exec / start / status / write_stdin / cancel
        └─ herdr_status / workspace / worktree / tab / pane tools
                 │                              │
                 ▼                              ▼
          codex exec --json (Luna)       Herdr Socket API → real PTYs
```

## Image previews and page refreshes

- Use `file_read` as the preferred path when ChatGPT needs to inspect a local PNG/JPEG/GIF/WebP as native MCP image content. Do not substitute terminal renderers such as `chafa`, `viu`, or `img2txt` unless the user explicitly asked to view the image inside their terminal.
- Use `file_image_preview` when the image should appear as a visible card in the conversation, including an explicit user preview request or a `codexluna_status` automatic recommendation. For model-only inspection, prefer `file_read`.
- For HTML/PDF layout inspection, render only the relevant view or page to PNG/JPEG/WebP and inspect that rendered image with `file_read`; additionally call `file_image_preview` only when the rendered view should be shown inline to the user.
- Luna keeps every verified image path in `image_artifacts`, but automatic presentation uses only images cited in Luna's final answer; an explicit user image request may fall back to the first verified observed image if the final message omitted its path. Purely intermediate images from non-image requests are not auto-presented.
- When a completed `codexluna_status` returns `image_preview_recommended: true`, ChatGPT calls `file_image_preview` once for `image_preview_path`, passing `web_session_id` and `expected_image_content_key=image_preview_content_key`. The status tool itself never mounts UI. A successful preview is recorded in bounded session-scoped runtime state; later polls report `image_preview_already_presented: true`, stop recommending the same content, and do not resend its native image. Duplicate automatic claims are rejected, while an explicit repeat can reuse the existing preview ID.
- Each successfully rendered card persists only its opaque preview ID and small metadata through that card's `window.openai.widgetState`; there is no conversation-global `localStorage`/`sessionStorage` preview ledger. Image bytes stay in the bounded private local preview cache.
- When ChatGPT recreates the card after a page refresh or the conversation is reopened, the component calls the private `file_image_preview_restore` tool with that ID. It never rereads an arbitrary source path.
- Cards created before the refresh-persistence format was introduced cannot be repaired retroactively. Call `file_image_preview` once more to create a restorable card.
- Deleting the local preview cache prevents restoration even when the card's widget state is still available; restoration also requires ChatGPT to rehydrate that card's own widget state.

## Importing ChatGPT attachments

- When a user uploads an image, PDF, source file, CSV, or another attachment to the current conversation, ChatGPT can call `file_import_attachment` to make it available locally.
- The tool accepts only the platform attachment object supplied through `openai/fileParams`; it is not a general URL downloader.
- Calls must disclose `workspace_path`, `permission_mode`, and a destination path. Imports are disabled in `read-only`, and existing files are not overwritten by default.
- Downloads default to a 20 MB limit and can be raised to at most 100 MB. Results contain the local path, byte count, MIME inspection, and SHA-256—not the temporary download URL—and imported files are never executed automatically.
- After import, use `file_read`, `file_image_preview`, or pass the returned local path to `codexluna_start`.
- `file_create_directory` creates empty directories (and parent directories by default). `file_delete_directory` deletes only empty directories unless `recursive: true` is explicitly supplied; it always refuses the disclosed workspace root and link/junction targets.
- `file_list` returns each entry's type, optional file size, and `modified_at` as an ISO 8601 timestamp.
- `terminal_exec` runs ordinary PowerShell/sh commands and waits for bounded stdout, stderr, status, and exit code. Long-running or interactive work uses `terminal_start`, `terminal_status`, `terminal_write_stdin`, and `terminal_cancel` without rerunning the command.
- Use `herdr_*` instead when a persistent/interactively controlled process should live in a real Herdr PTY that the user can observe in the Herdr application. The bridge uses explicit Herdr session/workspace/tab/pane IDs, requires an explicit `workspace_path`/`permission_mode` scope for operational calls, validates protocol 20 before acting, and never fabricates `HERDR_ENV`. See [Herdr bridge](docs/herdr.md).

## Linux deployment

See [Linux deployment and troubleshooting](docs/linux.md) for the complete installation, known-issue, and diagnostic procedure. The easy-to-miss points are:

- Source builds require Bun 1.3.14 with `bun` on PATH; npm 11 may block Bun's install script by default.
- Running an AppImage directly may require Ubuntu's `libfuse2t64`; the project installer uses extract-and-run mode and does not require a FUSE mount.
- If CLI setup creates the configuration while the launcher is already open, restart the launcher so it reloads the configuration and owns the Tunnel.
- For non-interactive Runtime Key setup, use `--runtime-key-file /dev/stdin`; never put the key in command-line arguments.
- OpenAI Platform and ChatGPT browser sessions are independent. Prove the final connection with a real ChatGPT Web tool call, not only the local `doctor` result.

## Development

Requirements: Windows or Linux x86_64, Codex CLI, a ChatGPT account with custom connectors, and an OpenAI Tunnel for MCP. The packaged launcher includes Bun; building from source requires Bun 1.3.14. macOS has not yet been manually tested.

```bash
git clone https://github.com/m4j2rpf766-crypto/gpt-web-codex.git
cd gpt-web-codex
bun install --frozen-lockfile
bun run launcher:dev
```

From the launcher:

1. Enter the Tunnel ID and a Tunnels Read + Use API key.
2. Create a ChatGPT connector named `WebGPT Luna Standalone`, using Tunnel transport and Authentication `None`.
3. Verify the runtime, then use the connector from a normal ChatGPT conversation in Chrome, Edge, Firefox, or another browser.

The connector name remains stable because ChatGPT caches tool contracts. Legacy local data directory names may be retained internally during migration so existing tunnel and Luna session state are not lost.

## Verification

```bash
bun x tsc --noEmit
bun test tests
bun run launcher:typecheck
bun run launcher:test
```

## Security boundary

The launcher keeps tunnel credentials in private local storage and redacts them from logs. It does not keep ChatGPT cookies, browser profiles, or conversation history. Attachment imports accept only validated ChatGPT/OpenAI file origins, pin the actual connection to a validated public address, revalidate redirects, create temporary files beside the destination, and clean up failures. To restore image cards after a page refresh, compressed preview copies are stored under the private standalone runtime directory for up to 90 days, capped at 128 previews; the cache does not retain the source path. `codexluna_init` returns the resolved workspace, permission mode, durable session ID, and a visible session-memory boundary before local execution. That boundary is prompt-level guidance; it cannot change the ChatGPT account's product-level Memory setting.

This is an independent, unofficial local MCP connector. It does not automate ChatGPT's UI and must not expose a tunnel or workspace you do not control.

## License

MIT. See [LICENSE](LICENSE) and [LICENSES](LICENSES).

## Acknowledgements

GPT Web Codex is based on and evolved from the original [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) project. Sincere thanks to miuuyy and every original contributor for making this work possible.
