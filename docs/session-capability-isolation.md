# Session Capability Profiles: security boundaries

**Experimental.** This feature restricts GWC tool-name dispatch. It does **not** provide authenticated multi-tenant isolation or an OS security sandbox.

## Trust boundaries

| Question | Evidence-based status |
| --- | --- |
| Can the MCP dispatcher reject tools not on a configured exact allowlist? | **Yes, within GWC**, verified in synthetic tests for native and external tools. |
| Can GWC prove an `openai/session` claim came from the authentic ChatGPT session? | **No**, a raw MCP client can forge that metadata. |
| Can ChatGPT discover different per-chat tool lists using the same connector? | **Not guaranteed**. A previously observed real client omitted per-chat metadata on `tools/list`. |
| Are external MCP stdio processes independent? | **Conditionally** for separately launched bridges; a shared catalog/global server is not isolated by tool-name filtering. |
| Does `workspace-write` prevent a shell from reading outside that directory? | **No**. Filesystem scoping of a tool target is not an OS sandbox for an arbitrary command. |
| Are Herdr PTYs terminated when GWC restarts? | **Not necessarily**; Herdr owns its own long-lived PTYs. |
| Are other ChatGPT apps, the account's Memory and built-in tools restricted? | **No**, they are outside this MCP server. |
| Is blind scientific evaluation by mutually untrusted raters proven secure? | **No**; external OS and identity controls would be required. |

## Implementation guarantees and limitations

`catalog_mode: "shared"` intentionally exposes one tool catalog; exact call permissions can still differ per claimed session. This can be useful for ordinary tool workflows but does not conceal tool names. `catalog_mode: "per_session"` can filter on trustworthy discovery metadata, which must be demonstrated by each client.

An authorized `terminal_exec` or `herdr_pane_run` may execute destructive operations. GWC does **not** provide a general shell-command denylist, mandatory command-by-command approval, or a universal filesystem/network sandbox. Use a disposable workspace and low-privilege user, OS confinement such as Bubblewrap/containers, and an independently enforced external gateway when strong isolation is required.

Missing session metadata when a restrictive capability policy is active must fail closed. A failed/ambiguous MCP result is not evidence that a side-effecting operation was never executed; never blindly replay commands after timeouts.

## Safe verification

Use only **synthetic** sample data and explicitly scoped test MCP servers. This project includes tests for allowlist enforcement, cross-session denial, deliberately forged metadata, stdio lifecycle and process ownership. Their success is a narrow GWC-side result, not an independent attestation of security at the OpenAI-account or OS level.

```sh
bun run typecheck
bun test tests/session-capabilities.test.ts tests/session-capabilities-admin.test.ts
```

See [configuration](session-capabilities.md), [operator setup](session-capabilities-operations.md), and [security policy](../SECURITY.md).