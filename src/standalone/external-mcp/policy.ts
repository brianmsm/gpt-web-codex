import type { ExternalMcpToolPolicy } from "./types";

export function externalMcpToolAllowed(toolName: string, policy: ExternalMcpToolPolicy): boolean {
  const allowed = policy.allow === undefined || policy.allow.includes(toolName);
  if (!allowed) return false;
  return !(policy.deny?.includes(toolName) ?? false);
}