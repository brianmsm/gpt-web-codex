import { loadSessionCapabilityConfig } from "../src/standalone/session-capabilities/config";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(name + " requires a value");
  return value;
}
const configPath = argument("--config");
if (!configPath) throw new Error("Usage: bun scripts/inspect-session-capabilities.ts --config FILE [--session-key chatgpt:SHA256]");
const config = loadSessionCapabilityConfig(configPath);
if (!config) throw new Error("Session capabilities were not enabled");
const sessionKey = argument("--session-key");
if (sessionKey && !/^chatgpt:[0-9a-f]{64}$/.test(sessionKey)) {
  throw new Error("--session-key must be chatgpt:<64 lowercase hex characters>");
}
const configured = sessionKey ? config.bindings.get(sessionKey) : undefined;
const profile = configured && configured !== "legacy" ? config.profiles.get(configured) : undefined;
const report = {
  config_sha256: config.digest,
  default_policy: config.defaultPolicy,
  bound_sessions_count: config.bindings.size,
  max_external_sessions: config.maxExternalSessions,
  ...(sessionKey ? {
    session_key: sessionKey,
    configured_profile: configured ?? config.defaultPolicy,
    configured_profile_version: profile?.version ?? null,
    configured_native_tools: profile ? [...profile.nativeTools].sort() : null,
    configured_external_tools: profile ? [...profile.externalTools].sort() : null,
  } : {
    profile_summaries: [...config.profiles.values()].map(item => ({
      name: item.name,
      version: item.version,
      native_tools_count: item.nativeTools.size,
      external_tools_count: item.externalTools.size,
    })),
  }),
  tool_enforcement_verified: false,
  real_chatgpt_catalog_verified: false,
  external_provider_and_memory_controls_verified: false,
  note: "Administrative configuration inspection only. This is NOT a runtime attestation.",
};
console.log(JSON.stringify(report, null, 2));
