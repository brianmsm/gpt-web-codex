import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import type { HerdrOwnershipTransfer, ImagePreviewPresentation, LunaJob, LunaReasoning, LunaSandbox, LunaSessionBinding, LunaState } from "./types";

export interface InitializeSessionBindingInput {
  workspacePath: string;
  permissionMode: LunaSandbox;
  model: string;
  reasoning: LunaReasoning;
  fast: boolean;
  timeoutMs: number;
  sessionPolicyVersion: number;
}

export function defaultStandaloneStatePath(home = getConfigDir()): string {
  return join(home, "standalone", "state.json");
}

export function defaultStandaloneLogDir(statePath = defaultStandaloneStatePath()): string {
  return join(dirname(statePath), "logs");
}

function emptyState(): LunaState {
  return { version: 1, sessions: {}, jobs: {}, herdrOwnership: { workspaces: {}, panes: {}, transfers: [] } };
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
}

export class LunaStateStore {
  readonly path: string;
  private state: LunaState;

  constructor(path = defaultStandaloneStatePath()) {
    this.path = resolve(path);
    this.state = this.load();
  }

  private load(): LunaState {
    if (!existsSync(this.path)) return emptyState();
    const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    assertRecord(parsed, "standalone state");
    if (parsed.version !== 1) throw new Error(`Unsupported standalone state version in ${this.path}`);
    assertRecord(parsed.sessions, "standalone sessions");
    assertRecord(parsed.jobs, "standalone jobs");
    if (parsed.herdrOwnership === undefined) {
      parsed.herdrOwnership = { workspaces: {}, panes: {}, transfers: [] };
    }
    assertRecord(parsed.herdrOwnership, "Herdr ownership state");
    const ownership = parsed.herdrOwnership as Record<string, unknown>;
    if (ownership.workspaces === undefined) ownership.workspaces = {};
    if (ownership.panes === undefined) ownership.panes = {};
    if (ownership.transfers === undefined) ownership.transfers = [];
    assertRecord(ownership.workspaces, "Herdr workspace ownership");
    assertRecord(ownership.panes, "Herdr pane ownership");
    if (!Array.isArray(ownership.transfers)) throw new Error("Invalid Herdr ownership transfer audit log");
    for (const [sessionName, value] of Object.entries(ownership.workspaces)) {
      assertRecord(value, `Herdr workspace ownership for session ${sessionName}`);
    }
    for (const [sessionName, value] of Object.entries(ownership.panes)) {
      assertRecord(value, `Herdr pane ownership for session ${sessionName}`);
    }
    return parsed as unknown as LunaState;
  }

  private save(): void {
    atomicWriteFile(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  binding(webSessionId: string): LunaSessionBinding | undefined {
    return this.state.sessions[webSessionId];
  }

  ensureBinding(webSessionId: string): LunaSessionBinding {
    const existing = this.binding(webSessionId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const binding = { webSessionId, createdAt: now, updatedAt: now };
    this.state.sessions[webSessionId] = binding;
    this.save();
    return binding;
  }

  initializeBinding(webSessionId: string, input: InitializeSessionBindingInput): LunaSessionBinding {
    const binding = this.ensureBinding(webSessionId);
    Object.assign(binding, input, { updatedAt: new Date().toISOString() });
    this.save();
    return binding;
  }

  bindLunaSession(webSessionId: string, lunaSessionId: string): void {
    const binding = this.ensureBinding(webSessionId);
    binding.lunaSessionId = lunaSessionId;
    binding.updatedAt = new Date().toISOString();
    this.save();
  }

  herdrWorkspaceOwner(sessionName: string, workspaceId: string): string | undefined {
    return this.state.herdrOwnership.workspaces[sessionName]?.[workspaceId];
  }

  herdrPaneOwner(sessionName: string, paneId: string): string | undefined {
    return this.state.herdrOwnership.panes[sessionName]?.[paneId];
  }

  bindHerdrWorkspace(webSessionId: string, sessionName: string, workspaceId: string): void {
    const bySession = this.state.herdrOwnership.workspaces[sessionName] ??= {};
    bySession[workspaceId] = webSessionId;
    this.ensureBinding(webSessionId);
    this.save();
  }

  bindHerdrPane(webSessionId: string, sessionName: string, paneId: string): void {
    const bySession = this.state.herdrOwnership.panes[sessionName] ??= {};
    bySession[paneId] = webSessionId;
    this.ensureBinding(webSessionId);
    this.save();
  }

  transferHerdrWorkspaceOwnership(input: {
    newOwner: string;
    sessionName: string;
    workspaceId: string;
    workspacePath: string;
    expectedPreviousOwner: string;
    paneIds: string[];
    maxAuditEntries?: number;
  }): HerdrOwnershipTransfer {
    const workspaceOwners = this.state.herdrOwnership.workspaces[input.sessionName] ??= {};
    const currentOwner = workspaceOwners[input.workspaceId];
    if (currentOwner !== input.expectedPreviousOwner) {
      throw new Error(`Herdr workspace owner changed before transfer: expected ${input.expectedPreviousOwner}, received ${currentOwner ?? "unowned"}`);
    }

    const paneOwners = this.state.herdrOwnership.panes[input.sessionName] ??= {};
    for (const paneId of input.paneIds) {
      const owner = paneOwners[paneId];
      if (owner && owner !== input.expectedPreviousOwner && owner !== input.newOwner) {
        throw new Error(`Herdr pane owner changed before transfer: ${paneId}`);
      }
    }

    const transferredAt = new Date().toISOString();
    workspaceOwners[input.workspaceId] = input.newOwner;
    for (const paneId of input.paneIds) paneOwners[paneId] = input.newOwner;

    if (!this.state.sessions[input.newOwner]) {
      this.state.sessions[input.newOwner] = {
        webSessionId: input.newOwner,
        createdAt: transferredAt,
        updatedAt: transferredAt,
      };
    } else {
      this.state.sessions[input.newOwner]!.updatedAt = transferredAt;
    }

    const transfer: HerdrOwnershipTransfer = {
      transferredAt,
      sessionName: input.sessionName,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      previousOwner: input.expectedPreviousOwner,
      newOwner: input.newOwner,
      paneIds: [...new Set(input.paneIds)].sort(),
    };
    const maxAuditEntries = Math.max(1, input.maxAuditEntries ?? 128);
    this.state.herdrOwnership.transfers = [transfer, ...this.state.herdrOwnership.transfers].slice(0, maxAuditEntries);
    this.save();
    return transfer;
  }

  imagePreviewPresentation(webSessionId: string, contentKey: string): ImagePreviewPresentation | undefined {
    return this.binding(webSessionId)?.imagePreviewPresentations?.find(item => item.contentKey === contentKey);
  }

  markImagePreviewPresented(webSessionId: string, contentKey: string, previewId: string, maxEntries = 128): ImagePreviewPresentation {
    const binding = this.ensureBinding(webSessionId);
    const presentation = { contentKey, previewId, presentedAt: new Date().toISOString() };
    const remaining = (binding.imagePreviewPresentations ?? []).filter(item => item.contentKey !== contentKey);
    binding.imagePreviewPresentations = [presentation, ...remaining].slice(0, maxEntries);
    binding.updatedAt = presentation.presentedAt;
    this.save();
    return presentation;
  }

  putJob(job: LunaJob): void {
    this.state.jobs[job.id] = job;
    const binding = this.ensureBinding(job.webSessionId);
    binding.lastJobId = job.id;
    binding.updatedAt = new Date().toISOString();
    this.save();
  }

  updateJob(jobId: string, patch: Partial<LunaJob>): LunaJob {
    const current = this.state.jobs[jobId];
    if (!current) throw new Error(`Unknown Luna job: ${jobId}`);
    const updated = { ...current, ...patch };
    this.state.jobs[jobId] = updated;
    this.save();
    return updated;
  }

  job(jobId: string): LunaJob | undefined {
    return this.state.jobs[jobId];
  }

  recoverInterruptedJobs(): number {
    let changed = 0;
    const now = new Date().toISOString();
    for (const job of Object.values(this.state.jobs)) {
      if (job.status !== "queued" && job.status !== "running") continue;
      Object.assign(job, {
        // Keep the persisted v1 status vocabulary backward-compatible with herdr.3.
        // terminalEvent carries the restart uncertainty; newer runtimes expose it as recovery_outcome=ambiguous.
        status: "failed",
        finishedAt: now,
        terminalEvent: "runtime_restarted",
        error: "The standalone MCP runtime restarted while this task was queued or running. Local side effects may have occurred; the Luna session binding was preserved, but this task must not be replayed automatically.",
      });
      changed += 1;
    }
    if (changed > 0) this.save();
    return changed;
  }

  snapshot(): LunaState {
    return structuredClone(this.state);
  }
}
