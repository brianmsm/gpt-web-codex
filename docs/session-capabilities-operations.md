# Operating Session Capability Profiles

This is a **generic, opt-in procedure** for administrators of GPT Web Codex. It contains no live deployment state, conversation IDs, tunnel identifiers or operator-specific paths.

## Before enabling

Session Capability Profiles restrict **tool names**, not the permissions of commands inside a shell. They do not authenticate arbitrary `openai/session` metadata, sandbox a command, or prevent access to other ChatGPT tools. Do not use them as strict isolation between mutually untrusted users or research evaluators.

Always test with synthetic material and a dedicated local MCP configuration. Back up your existing launcher configuration and runtime first. Do not change a running GWC tunnel from a model-controlled shell without explicit operator authorization.

## Administrator workflow

1. Copy [the example configuration](../session-capabilities.example.json) to a private file owned by the local user. On Linux, protect its directory with mode `0700` and the JSON file with `0600`.
2. Adjust `default_policy`, `catalog_mode`, and the exact `native_tools` / `external_tools` allowlists. The default example is designed to leave unbound conversations in legacy mode.
3. Validate the file locally:

   ```sh
   gpt-web-codex capabilities check --config /path/to/private/session-capabilities.json
   ```

4. Start or safely restart the GWC runtime with `CODEX_CHATGPT_WEB_SESSION_CAPABILITIES_CONFIG` pointing to that private file. Use your existing launcher/supervisor rather than replacing a configured tunnel.
5. From a conversation that is not yet restricted, call `capability_identity`. It returns a conversation identifier, not an authentication token or permission assignment.
6. From an **administrator-controlled terminal**, not from ChatGPT:

   ```sh
   gpt-web-codex capabilities bind \
     --config /path/to/private/session-capabilities.json \
     --session-key chatgpt:<64-lowercase-hex> \
     --profile diagnostics-only
   ```

7. Restart GWC via its existing owner/supervisor, then verify both an allowed and a denied call with a synthetic client. Inspect denials at `tools/call` rather than relying only on what appears in the catalog.

## Important limits

- `shared` mode can display a global tool catalog even when per-conversation calls are blocked.
- `per_session` requires trustworthy identity metadata on `tools/list`. Do not assume ChatGPT provides it.
- A client that can forge the underlying session metadata can impersonate another conversation.
- `read-only` and `workspace-write` are tool-specific argument modes, **not an OS sandbox** for a running shell.
- Do not add sensitive credentials, researcher materials or machine-specific paths to example configurations in Git.

To disable this opt-in feature, use your **own authorized supervisor procedure** to remove the environment override and restart safely. Keep a backup and do not assume that stopping GWC terminates processes owned by Herdr.

See [the overview](session-capabilities.md) and [the security boundaries](session-capability-isolation.md).