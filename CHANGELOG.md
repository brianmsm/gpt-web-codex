# Changelog

All maintained release versions follow [Semantic Versioning](https://semver.org/). Development experiment suffixes such as `-herdr` are no longer used for normal releases. Release artifacts are published only after the cross-platform GitHub Actions workflow completes.

## [2.3.0] — 2026-10-17

**Fork milestone: shell-first local MCP.** This version reflects the current direction of the fork rather than an upstream release or a Codex model-provider integration.

### Highlights

- **Local work first:** direct file and terminal operations are available without delegating to Codex. Luna remains explicit opt-in.
- **Persistent Herdr bridge:** use user-visible workspaces, worktrees, tabs and PTYs. Herdr owns long-lived processes; recovery uses concrete pane identities and avoids blind command replay.
- **External MCP client bridge:** explicitly configured stdio and Streamable HTTP backends with allow/deny tool lists, explicit environment inheritance and prefixed tool names.
- **Experimental Session Capability Profiles:** per-conversation tool-name rules with opt-in policy files, diagnostics and live synthetic verification; not an authenticated multi-tenant or filesystem security boundary.
- **Linux browser option:** isolated Chromium profile, loopback Chrome DevTools MCP, `systemd --user` wake on demand, plus an optional pinned stdio wrapper to wake Chrome before an authorized browser-tool call.
- **File and media workflows:** local file mutations, ChatGPT attachment import, image inspection and restorable preview cards.
- **Operational recovery:** generic diagnostics and safe recovery semantics; distinct job/lifecycle boundaries and explicit no-blind-replay guidance.
- **Project identity and docs:** a rewritten shell-first README, fork-specific package/update URLs and explicit warnings about the absence of general destructive-command protection.
- **Dependency security:** upgraded the MCP SDK to 1.32.1, sharp to 0.35.5 and vulnerable transitive HTTP/URL dependencies. The pinned Bun audit reports **no known vulnerabilities** at the time of release testing.

### Security warning

**This release is functionally more capable, not automatically safer.** The persistent shell, direct terminal and external tools have no general command blocklist, no mandatory per-command human approval, and no universal OS sandbox. Authorized PTY commands can still delete files or access resources allowed by the underlying OS user. Prompt injection, data access and accidental side effects remain risks. Read [SECURITY.md](SECURITY.md) and [docs/security-model.md](docs/security-model.md).

### Compatibility and limits

- Package/launcher/CLI version: `2.3.0`. New source installs require **Bun 1.3.14**.
- Linux desktop integration was tested with Omarchy/Arch; an earlier packaged baseline was manually tested with Ubuntu 26.04 and Windows. **This does not claim 2.3.0 binaries are tested or published on every OS.**
- Herdr bridge target: `0.8.2` / Socket API protocol `20`. Herdr is optional.
- Chrome MCP tested with `chrome-devtools-mcp@1.10.1`; the systemd wake recipe is specific to a Linux GUI session and is not installed by default.
- Session capability policies cannot make a powerful shell safe for mutually untrusted users. Authenticated per-chat identity and actual OS isolation require independent measures.
- Migrating from an existing GWC installation should not blindly rerun `setup` or replace a pinned protected runtime. Follow the existing environment's documented supervisor/rollback procedure.

### Validation

On Linux with pinned Bun 1.3.14, `bun run verify` passed: **419 core tests passed, 4 skipped, 0 failed; 79 launcher tests passed, 0 failed**. It also passed version sync, dependency audit (0 known vulnerabilities), TypeScript checks, launcher build, runtime bundle creation, third-party notices generation and relocatable standalone MCP smoke test. Cross-platform binary publishing still depends on the GitHub Actions release workflow.

### Release and publication

The final reviewed source snapshot will be identified by annotated tag `v2.3.0` after the public branch has been approved. **Local tags do not constitute a GitHub Release.** Pushing the final version tag triggers `.github/workflows/release.yml`, which requires the tag to match `package.json` and stages successful binaries as a **draft** for manual inspection. Check CI results, artifact checksums and platform signatures before making a release public.

## Earlier history

The fork previously used `v2.2.11-herdr.*` tags for incremental testing on top of the 2.2.11 codebase. Older commits and tags remain in Git for traceability; the public release line now uses conventional versions such as `v2.3.0`.

The upstream `m4j2rpf766-crypto/gpt-web-codex` repository has its own version history (including later 2.2.x tags) that should **not** be interpreted as binary releases of this fork.
