# Contributing to GPT Web Codex

This is a **shell-first** fork of GPT Web Codex. Work should prioritize dependable, observable local execution and recovery over autonomous delegation. Codex Luna remains optional and always requires explicit user approval.

## Design priorities

- **Direct tools first:** use `file_*` and `terminal_*` for straightforward local work.
- **Herdr for persistence:** prefer explicit Herdr session/workspace/tab/pane IDs and durable, visible PTYs for interactive tasks. Do not pretend that prompt-level scope is an OS sandbox.
- **External MCP by configuration:** do not auto-discover untrusted executables or inherit the complete process environment.
- **No implicit delegation:** do not start Luna or switch model routes merely because a task is hard or slow.
- **No blind replay:** after uncertain transport status, do not resubmit commands or browser operations unless their outcome has been safely established.
- **Security claims require evidence:** never describe workspace scoping as protection from arbitrary shell commands, or experimental conversation policy as authenticated multi-tenant isolation.
- **No ChatGPT UI scraping:** use documented MCP/Tunnel integration, not automated collection of ChatGPT conversation content through DOM or hidden endpoints.

## Before submitting changes

1. Use a separate Git worktree when changing runtime or security-sensitive code. Preserve users' existing tunnel IDs, keys and protected wrappers.
2. Add focused tests for state machines, identity, lifecycle, retries and permission boundaries. Avoid tests that touch live accounts, browser profiles or scientific data.
3. Run `bun run check-version`, `bun run typecheck`, `bun test tests`, `bun run launcher:typecheck` and `bun run launcher:test` with the pinned **Bun 1.3.14**. Document failing or platform-dependent tests rather than hiding them.
4. Keep secrets, local profiles, shell histories, research datasets and outputs out of the repository. Review `git diff --check` and `git status` before committing.
5. Update the README/CHANGELOG when public behavior or safety assumptions change.

Do not automatically rebuild or replace a user's running GWC installation simply to test source changes. Prefer disposable fixtures and explicitly authorized, supervised rollouts with rollback.

See [Architecture](docs/architecture.md), [Herdr](docs/herdr.md), [External MCP](docs/external-mcp.md), [Session Capability Profiles](docs/session-capabilities.md) and [Security policy](SECURITY.md).

## Versions and releases

Use conventional Semantic Versioning: `vMAJOR.MINOR.PATCH`. An annotated Git tag is a source milestone, not a published binary release. Pushing `v*` triggers a GitHub Actions release workflow; package, launcher and CLI versions must agree before doing so.
