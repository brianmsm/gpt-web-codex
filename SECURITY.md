# Security policy

**GPT Web Codex v2.3.0 is a high-trust local execution bridge, not a hardened sandbox.** Connect it only to ChatGPT accounts, users, tunnels, computers and workspaces you control. Keep unrelated credentials and sensitive personal data outside the reachable OS account wherever possible.

## Important limitations

- **No general destructive-command protection.** Authorized `terminal_exec`, `terminal_start`, `herdr_pane_run` and `herdr_pane_send` operations may run arbitrary shell commands. There is currently **no universal blocklist** for destructive commands (for example, recursive deletion or overwriting files) and **no mandatory approval before each command**. A shell can access files or the network using its process's OS permissions.
- **A workspace argument is not OS isolation.** GWC checks scope for selected tool operations, but an authorized shell can itself run `cd /`, scripts or programs with broader OS access. `danger-full-access` removes path restrictions. Use a container, restricted user, Bubblewrap or a comparable sandbox for work you do not fully trust.
- **Persistent work can outlive the response.** Herdr owns persistent PTYs. Closing ChatGPT or restarting GWC does not necessarily stop them. A missing acknowledgement is not proof that a command failed. Never blindly repeat side-effecting commands after a timeout.
- **Prompt injection is possible.** Repository files, webpages, tool output and external MCP servers may contain attacker-controlled instructions. Review and constrain what the model can read and execute.
- **Experimental session policies are not multi-tenant isolation.** Session Capability Profiles gate specific tool names and require compatible conversation identity metadata; they do not authenticate arbitrary external clients, restrict filesystem access within allowed shells, control other ChatGPT plugins or change product-level Memory.
- **Browser and connector credentials are sensitive.** Chrome DevTools Protocol access can expose site content and logged-in sessions. Use a dedicated browser profile, bind CDP to loopback and avoid exposing the socket or tunnel to untrusted parties.

ChatGPT may ask for confirmation on some operations, but the exact experience depends on app permissions and platform behavior. **Do not rely on a platform confirmation as the only protection against local shell commands.**

## Safer operating practices

1. Start with read-only tools and a disposable repository. Limit connector permissions and disable shell tools unless needed.
2. Run GWC under a low-privilege OS account; keep backups and enforce filesystem/network containment externally when appropriate.
3. Keep Secure MCP Tunnel runtime keys in private files, with the least permissions required. Never commit keys, browser profiles, local sessions, transcripts or raw diagnostic dumps.
4. Prefer explicit user approval for destructive work. Inspect pending commands, target paths, diffs and cleanup procedures yourself.
5. Review [docs/security-model.md](docs/security-model.md), [docs/session-capabilities.md](docs/session-capabilities.md) and [docs/diagnostics/WAVE4_RECOVERY_WITHOUT_BLIND_REPLAY.md](docs/diagnostics/WAVE4_RECOVERY_WITHOUT_BLIND_REPLAY.md) before enabling persistent work for unfamiliar content.

## Reporting issues

Do **not** post public issues containing ChatGPT cookies, browser storage, tunnel IDs, API/runtime keys, shell command output, paths to private data, or active session identifiers. Redact logs and diagnostic bundles.

If a private GitHub security advisory reporting channel is available, use that. Otherwise, contact the maintainer privately through the [fork repository](https://github.com/brianmsm/gpt-web-codex); do not publicly publish an exploit that exposes other users' credentials.

## Dependency note

As of the v2.3.0 verification, the repo uses MCP SDK 1.32.1, sharp 0.35.5 and patched overrides for known vulnerable transitive dependencies. The pinned Bun audit returned **no known vulnerabilities**, but this result is time-bound and does not mean shell execution is safe. Continue to run dependency audits, frozen-lockfile checks and package smoke tests before publication.

## License and affiliation

This is independently maintained, MIT-licensed software, **not a security-reviewed or endorsed OpenAI product**. It uses supported MCP connection mechanisms where the account/workspace permits them; this does not amount to a guarantee that any particular deployment complies with all applicable platform policies.
