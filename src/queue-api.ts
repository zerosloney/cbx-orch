import path from "node:path";
import * as queue from "./queue.js";
import type { QueueEntry, QueueFile, QueueRuntime } from "./queue.js";
import {
  savePersistedStateAndFinishQueue,
  persistedMetrics,
  prunePersistedData,
} from "./storage.js";
import {
  loadConfig,
  loadState,
  writeState,
  jobDir,
  pruneExpiredJobs,
} from "./state.js";
import { scanOrphanWorktrees, type OrphanWorktree } from "./worktree.js";
import type { JobState } from "./types.js";

const queueRuntime: QueueRuntime = {
  loadConfig,
  loadState,
  writeState,
  finishQueueEntryPersisted: savePersistedStateAndFinishQueue,
  jobDir,
};

export async function dispatchQueue(
  workspaceInput: string,
): Promise<QueueFile> {
  return queue.dispatchQueue(queueRuntime, workspaceInput);
}

export async function health(
  workspaceInput: string,
): Promise<{
  status: "ok";
  metrics: Awaited<ReturnType<typeof persistedMetrics>>;
  /** 孤儿 worktree（job 已被清理而 worktree 遗留）。清理入口：`cbx clean --orphans`。 */
  worktreeOrphans: OrphanWorktree[];
}> {
  const workspace = path.resolve(workspaceInput);
  const governance = (await loadConfig(workspace)).governance;
  const retentionDays = governance?.retentionDays;
  // governance.pruneJobs 开启时，健康检查同时清理过期已终态任务（与 pruneAfterTerminal 同口径）。
  if (governance?.pruneJobs && retentionDays)
    await pruneExpiredJobs(workspace, retentionDays);
  await prunePersistedData(workspace, retentionDays);
  return {
    status: "ok",
    metrics: await persistedMetrics(workspace),
    worktreeOrphans: await scanOrphanWorktrees(workspace),
  };
}

export async function serveQueue(
  workspaceInput: string,
  intervalMs = 30_000,
): Promise<queue.QueueService> {
  return queue.serveQueue(queueRuntime, workspaceInput, intervalMs);
}

export async function enqueueJob(
  workspaceInput: string,
  jobId: string,
  extra = "",
  priority = 0,
): Promise<QueueEntry> {
  return queue.enqueueJob(queueRuntime, workspaceInput, jobId, extra, priority);
}

export async function finishQueueEntry(
  workspaceInput: string,
  queueId: string,
): Promise<void> {
  return queue.finishQueueEntry(queueRuntime, workspaceInput, queueId);
}

export async function listQueue(workspaceInput: string): Promise<QueueFile> {
  return queue.listQueue(queueRuntime, workspaceInput);
}

export async function pauseQueue(workspaceInput: string): Promise<QueueFile> {
  return queue.pauseQueue(queueRuntime, workspaceInput);
}

export async function resumeQueue(workspaceInput: string): Promise<QueueFile> {
  return queue.resumeQueue(queueRuntime, workspaceInput);
}

export async function cancelQueueEntries(
  workspaceInput: string,
  jobId: string,
): Promise<QueueFile> {
  return queue.cancelQueueEntries(queueRuntime, workspaceInput, jobId);
}

/** 单锁内原子完成取消终态（标记队列条目 cancelled + 写 state），供 cancelJob 使用。 */
export async function cancelJobState(
  workspaceInput: string,
  jobId: string,
  updates: Record<string, unknown>,
): Promise<JobState> {
  return (await queue.cancelQueueEntriesWithState(
    queueRuntime,
    workspaceInput,
    jobId,
    updates,
  )) as unknown as JobState;
}

export async function retryQueueJob(
  workspaceInput: string,
  jobId: string,
  priority = 0,
): Promise<QueueEntry> {
  return queue.retryQueueJob(queueRuntime, workspaceInput, jobId, priority);
}
