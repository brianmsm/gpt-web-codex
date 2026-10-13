import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  loadSessionCapabilityConfig,
  parseSessionCapabilityConfig,
  SESSION_CAPABILITIES_CONFIG_ENV,
  verifyPrivateCapabilityFile,
} from "./config";

const SESSION_KEY = /^chatgpt:[0-9a-f]{64}$/;

function option(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(key + " requires a value");
  args.splice(index, 2);
  return value;
}

function flag(args: string[], key: string): boolean {
  const index = args.indexOf(key);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function requireSessionKey(value: string | undefined): string {
  if (!value || !SESSION_KEY.test(value)) {
    throw new Error("--session-key must be chatgpt:<64 lowercase hex characters>");
  }
  return value;
}

const verifyLocalPolicyFile = verifyPrivateCapabilityFile;

function publicSummary(configPath: string, sessionKey?: string) {
  const config = loadSessionCapabilityConfig(configPath);
  if (!config) throw new Error("Capability configuration not found");
  const profileName = sessionKey ? config.bindings.get(sessionKey) : undefined;
  const profile = profileName && profileName !== "legacy" ? config.profiles.get(profileName) : undefined;
  return {
    config_sha256: config.digest,
    default_policy: config.defaultPolicy,
    catalog_mode: config.catalogMode,
    configured_sessions: config.bindings.size,
    max_external_sessions: config.maxExternalSessions,
    profiles: [...config.profiles.values()].map(item => ({
      name: item.name,
      version: item.version,
      native_tool_count: item.nativeTools.size,
      external_tool_count: item.externalTools.size,
      has_dedicated_external_mcp: Boolean(item.externalConfigPath),
    })).sort((a, b) => a.name.localeCompare(b.name)),
    ...(sessionKey ? {
      session_key: sessionKey,
      configured_profile: profileName ?? config.defaultPolicy,
      configured_native_tools: profile ? [...profile.nativeTools].sort() : null,
      configured_external_tools: profile ? [...profile.externalTools].sort() : null,
    } : {}),
    live_client_discovery_verified: false,
    authenticated_upstream_identity_verified: false,
    note: "Offline administrative policy inspection. This is not a runtime or ChatGPT isolation attestation.",
  };
}

export function bindCapabilityProfile(
  configPath: string,
  sessionKey: string,
  name: string,
  replace = false,
): { config_sha256: string; session_key: string; profile: string; restart_required: true } {
  const path = resolve(configPath);
  requireSessionKey(sessionKey);
  // Coordinate concurrent administrator invocations. A stale lock after a
  // process crash requires explicit local supervisor intervention.
  const lockPath = path + ".lock";
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch {
    throw new Error("Capability policy configuration is locked by another or interrupted administrator");
  }
  try {
    verifyLocalPolicyFile(path);
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const current = parseSessionCapabilityConfig(raw, path);
    if (name !== "legacy" && !current.profiles.has(name)) {
      throw new Error("Unknown capability profile: " + name);
    }
    const existing = current.bindings.get(sessionKey);
    if (existing && existing !== name && !replace) {
      throw new Error("Session is already bound to " + existing + "; use --replace for an explicit change");
    }
    const updated = {
      ...(raw as Record<string, unknown>),
      session_bindings: {
        ...Object.fromEntries(current.bindings),
        [sessionKey]: name,
      },
    };
    const validated = parseSessionCapabilityConfig(updated, path);
    // Temp file + fsync + atomic rename preserve a complete policy on error.
    const stagedPath = path + ".tmp-" + randomUUID();
    let fd: number | undefined;
    try {
      fd = openSync(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, JSON.stringify(updated, null, 2) + "\n", "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      verifyLocalPolicyFile(path);
      renameSync(stagedPath, path);
      if (process.platform !== "win32") chmodSync(path, 0o600);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(stagedPath); } catch { /* temp file already moved or absent */ }
      throw error;
    }
    // Directory sync may be unsupported by some filesystems; the atomic
    // replacement has already completed, so do not falsely report failure.
    if (process.platform !== "win32") {
      let directoryFd: number | undefined;
      try {
        directoryFd = openSync(dirname(path), constants.O_RDONLY);
        fsyncSync(directoryFd);
      } catch {
        // Best effort directory durability.
      } finally {
        if (directoryFd !== undefined) closeSync(directoryFd);
      }
    }
    return {
      config_sha256: validated.digest,
      session_key: sessionKey,
      profile: name,
      restart_required: true,
    };
  } finally {
    closeSync(lockFd);
    unlinkSync(lockPath);
  }
}

export function runSessionCapabilitiesAdmin(args: string[]): void {
  const remaining = [...args];
  const command = remaining.shift();
  if (!command || !["check", "bind"].includes(command)) {
    throw new Error(
      "Usage: gpt-web-codex capabilities <check|bind> --config PATH "
      + "[--session-key chatgpt:SHA256] [--profile NAME] [--replace]",
    );
  }
  const configPath = option(remaining, "--config")
    ?? process.env[SESSION_CAPABILITIES_CONFIG_ENV];
  if (!configPath) throw new Error("Specify --config PATH or set " + SESSION_CAPABILITIES_CONFIG_ENV);
  const sessionKey = option(remaining, "--session-key");
  const profile = option(remaining, "--profile");
  const replace = flag(remaining, "--replace");
  if (remaining.length) throw new Error("Unsupported capability options: " + remaining.join(" "));
  let report: unknown;
  if (command === "check") {
    if (profile || replace) throw new Error("check does not accept --profile or --replace");
    if (sessionKey) requireSessionKey(sessionKey);
    verifyLocalPolicyFile(resolve(configPath));
    report = publicSummary(configPath, sessionKey);
  } else {
    if (!profile) throw new Error("bind requires --profile NAME");
    report = bindCapabilityProfile(configPath, requireSessionKey(sessionKey), profile, replace);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
