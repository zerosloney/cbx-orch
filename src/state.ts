import { appendFileSync } from "node:fs";
import path from "node:path";
import { publishEvent } from "./observability.js";
import { loadRuntimeConfig, loadPersistedState, savePersistedState, savePersistedStateAndFinishQueue, savePersistedStateAndResolveApprovalQueue, saveJson, prunePersistedData, now, withQueueLock, type RuntimeConfig } from "./storage.js";
import { assertJobId } from "./validation.js";
import { normalizeAdaptiveOptions } from "./adaptive-manager.js";
import type { JobState, CbxConfig, Json } from "./types.js";

/** 把降级路径的失败原因落到 job 事件流，避免裸吞导致排障无据。 */
export function logJobEvent(workspace: string, jobId: string, event: string, detail: Record<string, unknown> = {}): void {
  try {
    appendFileSync(path.join(jobDir(workspace, jobId), "events.ndjson"), JSON.stringify({ event, jobId, ...detail, at: now() }) + "\n", "utf8");
  } catch { /* events file itself unreachable — nothing more we can do */ }
}

export function jobDir(workspace: string, jobId: string): string {
  assertJobId(jobId);
  return path.join(workspace, ".cbx", "jobs", jobId);
}

export async function loadState(workspace: string, jobId: string): Promise<JobState> {
  jobDir(workspace, jobId);
  const value = await loadPersistedState<JobState>(workspace, jobId);
  if (!value || typeof value !== "object") throw new Error(`任务不存在或状态文件损坏：${jobId}`);
  return value;
}

export async function loadConfig(workspaceInput: string): Promise<CbxConfig> {
  return loadRuntimeConfig(workspaceInput);
}

export function mergeConfig(config: CbxConfig, overrides: Partial<CbxConfig> & { approvalBeforeRun?: boolean; approvalBeforeComplete?: boolean; autoBranch?: boolean; autoCommit?: boolean; commitMessage?: string; trustMode?: "trusted" | "untrusted" }): Required<Pick<CbxConfig, "review" | "isolated" | "timeoutMs" | "maxRetries" | "maxTurns" | "keepWorktree" | "permissionMode" | "maxConcurrent" | "dependencyGuard">> & Pick<CbxConfig, "testCommand" | "reviewRules" | "executor" | "reviewExecutor"> & { approvalBeforeRun: boolean; approvalBeforeComplete: boolean; autoBranch: boolean; autoCommit: boolean; commitMessage: string; trustMode: "trusted" | "untrusted"; adaptive: import("./adaptive-manager.js").AdaptiveOptions } {
  const adaptive = normalizeAdaptiveOptions(overrides.adaptive, normalizeAdaptiveOptions(config.adaptive));
  return {
    testCommand: overrides.testCommand ?? config.testCommand,
    review: overrides.review ?? config.review ?? false,
    isolated: overrides.isolated ?? config.isolated ?? false,
    timeoutMs: overrides.timeoutMs ?? config.timeoutMs ?? 30 * 60_000,
    maxRetries: overrides.maxRetries ?? config.maxRetries ?? 1,
    maxTurns: overrides.maxTurns ?? config.maxTurns ?? 50,
    keepWorktree: overrides.keepWorktree ?? config.keepWorktree ?? false,
    permissionMode: overrides.permissionMode ?? config.permissionMode ?? "auto",
    reviewRules: overrides.reviewRules ?? config.reviewRules,
    approvalBeforeRun: overrides.approvalBeforeRun ?? config.approval?.beforeRun ?? false,
    approvalBeforeComplete: overrides.approvalBeforeComplete ?? config.approval?.beforeComplete ?? false,
    maxConcurrent: overrides.maxConcurrent ?? config.maxConcurrent ?? 2,
    autoBranch: overrides.autoBranch ?? config.git?.autoBranch ?? false,
    autoCommit: overrides.autoCommit ?? config.git?.autoCommit ?? false,
    commitMessage: overrides.commitMessage ?? config.git?.commitMessage ?? "chore(cbx): apply task",
    executor: overrides.executor ?? config.executor ?? "codebuddy",
    reviewExecutor: overrides.reviewExecutor ?? config.reviewExecutor,
    trustMode: overrides.trustMode ?? config.execution?.trustMode ?? "trusted",
    dependencyGuard: overrides.dependencyGuard ?? config.dependencyGuard ?? false,
    adaptive,
  };
}

export async function writeState(workspace: string, jobId: string, updates: Json, queueEntryId?: string): Promise<JobState> {
  const state = await loadState(workspace, jobId);
  const previousStatus = state.status;
  Object.assign(state, updates, { updatedAt: now() });
  // 终态双写与调度器整 blob 写回共用队列锁：否则两者并发时 worker 的终态会被调度器的旧快照覆盖。
  if (queueEntryId) await withQueueLock(workspace, () => savePersistedStateAndFinishQueue(workspace, jobId, state, queueEntryId), { retries: 120 });
  else await savePersistedState(workspace, jobId, state);
  await saveJson(path.join(jobDir(workspace, jobId), "state.json"), state);
  await prunePersistedData(workspace, (await loadConfig(workspace)).governance?.retentionDays);
  try { await publishEvent(workspace, "job.state_changed", { jobId, previousStatus, status: state.status, phase: state.phase, attempt: state.attempt }); }
  catch { /* event delivery must not mask the durable state change */ }
  return state;
}

export async function writeApprovalState(workspace: string, jobId: string, updates: Json, queueStatus: "done" | "failed"): Promise<JobState> {
  const state = await loadState(workspace, jobId);
  const previousStatus = state.status;
  Object.assign(state, updates, { updatedAt: now() });
  // 审批终态同样并入队列锁，避免与调度器整 blob 写回互相覆盖。
  await withQueueLock(workspace, () => savePersistedStateAndResolveApprovalQueue(workspace, jobId, state, queueStatus), { retries: 120 });
  await saveJson(path.join(jobDir(workspace, jobId), "state.json"), state);
  try { await publishEvent(workspace, "job.state_changed", { jobId, previousStatus, status: state.status, phase: state.phase, attempt: state.attempt }); }
  catch { /* durable approval transition must not depend on delivery */ }
  return state;
}
