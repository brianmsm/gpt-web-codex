import { runSessionCapabilitiesAdmin } from "../src/standalone/session-capabilities/admin";

// Backward-compatible development wrapper for the general GWC CLI.
// Packaged deployments should use the 'gpt-web-codex capabilities check' command.
runSessionCapabilitiesAdmin(["check", ...process.argv.slice(2)]);
