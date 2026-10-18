# Optional Chromium browser bridge (Linux)

This is an **opt-in** recipe for using Chrome DevTools MCP with an independent Chromium profile. GWC's core does not require Chromium, and the example does not modify the runtime's user/session policies.

## Prerequisites and security

- Linux with a running graphical user session and `systemd --user`.
- Chromium at `/usr/bin/chromium`, a Python 3 interpreter, and `npx` on `PATH`.
- Chrome DevTools MCP `1.10.1`, the version tested with the optional wrapper.
- A **dedicated Chromium profile**; never aim CDP at your everyday browser profile.
- The CDP endpoint `127.0.0.1:9333` must be unused. **CDP does not authenticate arbitrary local clients**: a local process with access may inspect logged-in pages.

The example runs with the same local OS permissions as your graphical session. It is **not** an OS sandbox, does not enforce command blocking, and cannot protect browser cookies against other processes running as that user.

## Start and wake Chromium independently of terminals

From a **checked-out repository**, create a separate profile and install the optional user service:

```sh
mkdir -p "$HOME/.local/share/gwc-browser-agent" "$HOME/.config/systemd/user"
chmod 700 "$HOME/.local/share/gwc-browser-agent"
python3 -B scripts/diagnostics/gwc-agent-browser-control.py --install
```

The service remains **disabled at login** by design. Wake it explicitly:

```sh
python3 -B "$HOME/.local/state/gwc-agent-browser/control.py" --start
```

The controller checks private file ownership, the **loaded systemd ExecStart**, browser-service MainPID/OS user, the exact dedicated profile and flags, and Linux kernel ownership of the loopback CDP listening socket. A browser-shaped `/json/version` response **does not establish identity**. It refuses any foreign or manually started Chrome already using port `9333`, even if that Chrome has a valid CDP endpoint. Close the non-managed instance yourself (after saving work) and wake the dedicated service instead. The check is not an OS security boundary against a hostile process running as the same local user.

## Optional MCP auto-wake

For users who want the first authorized Chrome MCP call to wake the browser automatically, the repository includes `scripts/diagnostics/chrome-stdio-on-demand-proxy.py`. In your **private** `~/.codex-chatgpt-web/external-mcp.json`, configure the optional `chrome` stdio server to launch:

```text
/usr/bin/python3 -B /ABSOLUTE/PATH/TO/REPOSITORY/scripts/diagnostics/chrome-stdio-on-demand-proxy.py -- -y chrome-devtools-mcp@1.10.1 --browserUrl=http://127.0.0.1:9333 --redactNetworkHeaders --no-usage-statistics
```

The corresponding `external-mcp.json` entry is:

```json
{
  "version": 1,
  "servers": {
    "chrome": {
      "enabled": true,
      "required": false,
      "transport": "stdio",
      "command": "/usr/bin/python3",
      "args": [
        "-B",
        "/ABSOLUTE/PATH/TO/REPOSITORY/scripts/diagnostics/chrome-stdio-on-demand-proxy.py",
        "--",
        "-y",
        "chrome-devtools-mcp@1.10.1",
        "--browserUrl=http://127.0.0.1:9333",
        "--redactNetworkHeaders",
        "--no-usage-statistics"
      ],
      "inherit_env": ["PATH"],
      "env": {},
      "startup_timeout_ms": 60000,
      "call_timeout_ms": 120000
    }
  }
}
```

Replace the placeholder with the real absolute path to this checkout; never put a private runtime key in `args` or `env`. The wrapper validates its pinned arguments. The backend process only connects to the dedicated profile; it does not launch a Puppeteer-controlled user-profile browser.

If the browser is closed, the wrapper attempts the private systemd wake action **before forwarding** `tools/call`. Even if CDP is already reachable, it first requires a positive `--check-owned` attestation from the private controller; merely finding a Chrome on port `9333` is insufficient. A failed ownership check or wake returns a tool error without executing the browser request. It never blindly replays a browser operation after an uncertain outcome.

**Existing installations:** this stricter version must be deployed together with its matching private controller and systemd unit. The controller deliberately refuses to overwrite differing previously installed private scripts/units. Plan a supervised backup and upgrade of those files, without deleting your Chromium profile or modifying a running protected GWC tunnel. An older installed controller does not satisfy the new ownership attestation and the new wrapper will fail closed until the upgrade is performed.

External MCP startup catalogs are initialized when the GWC process starts, so changing `external-mcp.json` requires a **controlled restart** of your own runtime. Do not copy private tunnel IDs, runtime keys, protected profile paths or operator-specific backup procedures from other environments.

## Stop and verify

```sh
systemctl --user status gwc-agent-browser.service
systemctl --user stop gwc-agent-browser.service
```

Stopping the browser does not stop GWC. Cookies remain in the dedicated local profile unless cleared manually. Use direct access to the graphical browser to sign in to allowed sites; never provide credentials inside shell commands or ChatGPT tool arguments.

Run targeted tests before enabling the optional wrapper:

```sh
python3 -B -m unittest discover -s tests -p 'test_gwc_agent_browser_systemd.py'
python3 -B -m unittest discover -s tests -p 'test_chrome_stdio_on_demand_proxy.py'
```

This is a **portable example**. Actual availability depends on the host's graphical session and external MCP configuration.