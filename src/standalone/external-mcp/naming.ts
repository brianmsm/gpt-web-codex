export const EXTERNAL_MCP_PUBLIC_TOOL_NAME_MAX = 64;

const PUBLIC_SAFE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const ALIAS_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ASCII_PRINTABLE = /^[\x20-\x7E]+$/;

export function normalizeExternalMcpAlias(alias: string): string {
  const trimmed = alias.trim();
  if (!trimmed || !ALIAS_SOURCE.test(trimmed)) {
    throw new Error(
      `External MCP alias ${JSON.stringify(alias)} is invalid; use letters, digits, ".", "_" or "-", starting with a letter or digit`,
    );
  }
  const normalized = trimmed.replaceAll(".", "_");
  if (!PUBLIC_SAFE.test(normalized)) {
    throw new Error(`External MCP alias ${JSON.stringify(alias)} cannot be represented safely`);
  }
  return normalized;
}

export function normalizeExternalToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || !ASCII_PRINTABLE.test(trimmed)) {
    throw new Error(`External MCP tool name ${JSON.stringify(name)} cannot be represented safely`);
  }
  const normalized = trimmed.replace(/[^A-Za-z0-9_-]+/g, "_");
  if (!PUBLIC_SAFE.test(normalized)) {
    throw new Error(`External MCP tool name ${JSON.stringify(name)} cannot be represented safely`);
  }
  return normalized;
}

export function externalMcpPublicToolName(alias: string, toolName: string): string {
  const normalizedAlias = normalizeExternalMcpAlias(alias);
  const normalizedTool = normalizeExternalToolName(toolName);
  const publicName = `${normalizedAlias}__${normalizedTool}`;
  if (publicName.length > EXTERNAL_MCP_PUBLIC_TOOL_NAME_MAX) {
    throw new Error(
      `External MCP public tool name is too long (${publicName.length} > ${EXTERNAL_MCP_PUBLIC_TOOL_NAME_MAX}): ${publicName}`,
    );
  }
  return publicName;
}

export function assertUniqueExternalAliases(aliases: string[]): void {
  const seen = new Map<string, string>();
  for (const alias of aliases) {
    const normalized = normalizeExternalMcpAlias(alias);
    const previous = seen.get(normalized);
    if (previous !== undefined) {
      throw new Error(
        `External MCP aliases collide after normalization: ${JSON.stringify(previous)} and ${JSON.stringify(alias)} -> ${normalized}`,
      );
    }
    seen.set(normalized, alias);
  }
}
