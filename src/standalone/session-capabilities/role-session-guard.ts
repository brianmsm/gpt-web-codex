import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Reusable, opt-in per-app/session gate for stdio MCP servers.
 *
 * The default-deny binding must be owned by a local supervisor. No model tool
 * can mutate the binding. The client may discover tool schemas before the
 * session identity is available (ChatGPT's actual tools/list behavior).
 *
 * Trust limit: a raw MCP client can forge openai/session. An HMAC fingerprint
 * conceals the raw identifier; it does NOT authenticate its upstream source.
 */
export const ROLE_SESSION_ID_PREFIX = "rater-session:";
export const ROLE_SESSION_FINGERPRINT = /^rater-session:[A-Za-z][A-Za-z0-9_-]{0,31}:[a-f0-9]{64}$/;
const SCOPE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export interface RoleSessionGuardSettings {
  readonly role: string;
  readonly privateKeyPath: string;
  readonly bindingFilePath: string;
}

function secureFile(path: string, label: string): Buffer {
  if (!isAbsolute(path)) throw new Error(label + " must be an absolute path");
  // Read the same file descriptor we checked, avoiding a symlink-swap race
  // between lstat(path) and a separate readFileSync(path) operation.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(label + " must be a regular file, not a symlink");
    if (process.platform !== "win32" && (
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )) {
      throw new Error(label + " must be private and owned by the MCP user");
    }
    if (stat.size > 4096) throw new Error(label + " is larger than the maximum safe policy size");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function denied(reason: "missing_identity" | "enrollment_required" | "forbidden" | "invalid_binding",
                fingerprint?: string): CallToolResult {
  const code = "SYNTHETIC_RATER_" + reason.toUpperCase();
  return {
    isError: true,
    content: [{ type: "text", text: code + (fingerprint ? " session_fingerprint=" + fingerprint : "") }],
    structuredContent: {
      authorization: "denied",
      reason,
      ...(fingerprint ? { session_fingerprint: fingerprint } : {}),
    },
  };
}

export class RoleSessionGuard {
  private readonly secret: Buffer;
  private readonly bindingFilePath: string;
  private readonly role: string;

  constructor({ role, privateKeyPath, bindingFilePath }: RoleSessionGuardSettings) {
    if (!SCOPE_NAME.test(role)) throw new Error("Role capability scope must use a static supervisor-assigned name");
    this.role = role;
    this.secret = secureFile(privateKeyPath, "HMAC key");
    if (this.secret.length !== 32) throw new Error("HMAC key must have exactly 32 bytes");
    this.bindingFilePath = bindingFilePath;
    // Refuse to start if a supervisor-owned binding file is missing/insecure.
    void this.authorizedFingerprint();
  }

  private authorizedFingerprint(): string | null {
    const value = secureFile(this.bindingFilePath, "Authorized session binding").toString("utf8").trim();
    if (!value) return null;
    if (!ROLE_SESSION_FINGERPRINT.test(value) || !value.startsWith(ROLE_SESSION_ID_PREFIX + this.role + ":")) {
      throw new Error("Authorized session binding contains an invalid fingerprint");
    }
    return value;
  }

  fingerprint(meta: Record<string, unknown> | undefined): string | null {
    const raw = meta?.["openai/session"];
    if (typeof raw !== "string" || !raw.trim() || raw.length > 4096) return null;
    return ROLE_SESSION_ID_PREFIX + this.role + ":"
      + createHmac("sha256", this.secret).update(raw.trim(), "utf8").digest("hex");
  }

  private authorize(name: string, meta: Record<string, unknown> | undefined): CallToolResult | null {
    let bound: string | null;
    try {
      bound = this.authorizedFingerprint();
    } catch {
      // Runtime tampering after boot: fail closed rather than accept a stale grant.
      return denied("invalid_binding");
    }

    const fingerprint = this.fingerprint(meta);
    if (!fingerprint) return denied("missing_identity");

    if (!bound) {
      // Only an enrollment diagnostic returns a candidate. It never returns
      // study data, role, PID, output paths or any evaluator-specific content.
      // Once bound, the candidate is not exposed to rejected conversations.
      return name === "study_identity"
        ? denied("enrollment_required", fingerprint)
        : denied("forbidden");
    }

    const permitted = timingSafeEqual(
      Buffer.from(fingerprint.slice(-64), "hex"),
      Buffer.from(bound.slice(-64), "hex"),
    );
    return permitted ? null : denied("forbidden");
  }

  install(server: McpServer): void {
    const raw = server.server;
    const previous = raw.setRequestHandler.bind(raw) as unknown as
      (schema: any, handler: (request: any, extra: { _meta?: Record<string, unknown> }) => unknown) => void;
    raw.setRequestHandler = ((schema: any, handler: any) => {
      if (schema === CallToolRequestSchema) {
        return previous(schema, (request: any, extra: { _meta?: Record<string, unknown> }) =>
          this.authorize(request.params?.name ?? "", extra?._meta)
          ?? handler(request, extra));
      }
      // Nothing except the catalog/initialization may become an alternate
      // evaluation pathway. An SDK handler for resources/prompts/completions
      // would have to be explicitly reviewed if added later.
      const method: unknown = schema?.shape?.method?.value;
      if (typeof method === "string" &&
          !["initialize", "ping", "tools/list"].includes(method)) {
        return previous(schema, () => {
          throw new Error("SYNTHETIC_RATER_NON_TOOL_METHOD_DENIED");
        });
      }
      return previous(schema, handler);
    }) as typeof raw.setRequestHandler;
  }
}
