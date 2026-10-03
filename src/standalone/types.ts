export type LunaSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type LunaReasoning = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type LunaJobStatus = "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";
export type RecoveryOutcome = "known_completion" | "known_local_failure" | "running_recoverable" | "ambiguous";

export interface ImagePreviewPresentation {
  contentKey: string;
  previewId: string;
  presentedAt: string;
}

export interface LunaSessionBinding {
  webSessionId: string;
  lunaSessionId?: string;
  workspacePath?: string;
  permissionMode?: LunaSandbox;
  model?: string;
  reasoning?: LunaReasoning;
  fast?: boolean;
  timeoutMs?: number;
  sessionPolicyVersion?: number;
  createdAt: string;
  updatedAt: string;
  lastJobId?: string;
  imagePreviewPresentations?: ImagePreviewPresentation[];
}

export interface LunaJob {
  id: string;
  webSessionId: string;
  promptChars: number;
  wantsImagePreview?: boolean;
  imageArtifacts?: string[];
  recommendedImageArtifacts?: string[];
  cwd: string;
  model: string;
  reasoning: LunaReasoning;
  fast: boolean;
  sandbox: LunaSandbox;
  timeoutMs: number;
  status: LunaJobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lunaSessionId?: string;
  pid?: number;
  exitCode?: number | null;
  terminalEvent?: string;
  cancelRequestedAt?: string;
  finalMessage?: string;
  error?: string;
  mutationSeen: boolean;
  eventCount: number;
  attempts: number;
  logPath: string;
}

export interface HerdrOwnershipState {
  workspaces: Record<string, Record<string, string>>;
  panes: Record<string, Record<string, string>>;
}

export interface LunaState {
  version: 1;
  sessions: Record<string, LunaSessionBinding>;
  jobs: Record<string, LunaJob>;
  herdrOwnership: HerdrOwnershipState;
}

export interface StartLunaJobInput {
  webSessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  reasoning?: LunaReasoning;
  fast?: boolean;
  sandbox?: LunaSandbox;
  timeoutMs?: number;
}
