export const SESSION_POLICY_VERSION = 1 as const;

export const SESSION_BOUNDARY_NOTICE = [
  "[GPT Web Codex session boundary notice]",
  "This tool session uses a strict session-scoped context boundary. Web-session bindings, Luna context, task status, workspace information, and local execution records created by GPT Web Codex may be used only in the web conversation associated with the current web_session_id.",
  "Do not proactively write, update, merge, synchronize, or migrate this conversation's content, summaries, preferences, paths, file information, code, task results, Luna context, or inferred information into long-term memory shared across conversations, and do not bind local sessions from other web conversations to this conversation.",
  "The Luna session, task state, and required logs for this web_session_id may be persisted locally only to resume this same web conversation; other web conversations must not inherit them automatically.",
  "If the user later explicitly requests a cross-conversation memory operation, explain the impact and obtain explicit authorization first. GPT Web Codex itself cannot write ChatGPT account-level long-term memory.",
  "This notice constrains the current MCP tool flow but does not modify or disable ChatGPT's product-level Memory setting under Settings > Personalization > Memory. If account memory is enabled, the product's own automatic memory behavior is not directly controlled by this local MCP.",
  "Do not require a confirmation keyword. Briefly show the current workspace, permission mode, and session boundary, then continue with the user's authorized task.",
].join("\n");

export const SESSION_POLICY = Object.freeze({
  version: SESSION_POLICY_VERSION,
  scope: "current_web_session_only" as const,
  allow_long_term_memory_write: false,
  allow_long_term_memory_update: false,
  allow_cross_chat_migration: false,
  allow_cross_chat_binding_reuse: false,
  allow_same_session_persistence: true,
  requires_acknowledgement: false,
  account_memory_controlled_by_mcp: false,
});

export const COMPACT_SESSION_POLICY =
  "current-web-session-only; no-active-long-term-memory-write-or-update; no-cross-chat-migration; same-session-local-resume-allowed";

export const MCP_SERVER_INSTRUCTIONS = [
  "Use codexluna_init before the first codexluna_start in a new ChatGPT conversation.",
  "Omit web_session_id when ChatGPT supplies openai/session metadata; otherwise treat the returned web_session_id as private to that conversation and reuse it only in the same conversation.",
  "When codexluna_status completes with image_preview_recommended=true, automatically call file_image_preview exactly once for image_preview_path using the returned workspace_path and permission_mode, and pass web_session_id plus expected_image_content_key=image_preview_content_key. The runtime records a successful presentation in session-scoped state, suppresses the native image and recommendation on later polls, and rejects a duplicate automatic claim for the same content key. If image_preview_already_presented=true or image_preview_recommended=false, do not call file_image_preview automatically. By default auto-present only the single recommended image; present additional image_artifacts only when the user explicitly asks or they are materially necessary to answer. codexluna_status never mounts image-preview UI itself, and an image is displayed only after file_image_preview succeeds.",
  "When the user uploads a ChatGPT attachment that local tools or Luna must access, use file_import_attachment with the platform-supplied file object. Disclose the workspace_path and permission_mode before the first local write. Never invent or expose the temporary download URL, never execute an imported file automatically, and use the returned local path for subsequent file or Luna calls.",
  "When the user asks to create or delete a directory, use file_create_directory or file_delete_directory directly. Do not simulate an empty directory by writing a placeholder such as .gitkeep. Recursive deletion is allowed only when the user clearly requested deletion of the directory and its contents.",
  "For existing text files, prefer file_edit for exact replacements and file_apply_patch for strict unified diffs instead of rewriting the complete file with file_write. Both are mutating tools and require a write-capable permission mode.",
  "Local shell execution is available. Use terminal_exec for ordinary commands and read its stdout, stderr, status, and exit_code. If terminal_exec or terminal_start returns status=running, continue the same job with terminal_status; never rerun the command merely to obtain output. Use terminal_start plus terminal_write_stdin for long-running or interactive commands, and terminal_cancel only when cancellation is requested or necessary.",
  "Use herdr_* tools for interactive or persistent workers that the user wants to observe or attach to in Herdr. Always select a Herdr session explicitly and preserve returned workspace/tab/pane/terminal IDs for later calls. For every Herdr tool except herdr_status, disclose an absolute workspace_path and permission_mode: read-only allows only observational operations, workspace-write permits mutations only for canonical workspaces/panes inside the disclosed scope, and danger-full-access disables path scoping. Resolve every relative Herdr cwd/source_cwd/path against workspace_path, never against the MCP process cwd. Scoped worktree creation must provide an explicit path inside workspace_path. Never fabricate HERDR_ENV or HERDR_* identity variables, never select a target from UI focus, and never infer that a timeout or unknown probe means a pane is dead. Herdr panes are owned by Herdr and are intentionally not terminated when the GWC MCP process shuts down.",
  SESSION_BOUNDARY_NOTICE,
].join("\n\n");
