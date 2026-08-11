import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, loadState, jobDir, logJobEvent } from "./state.js";
import { redactText, saveJson, now } from "./storage.js";
import { pruneAfterTerminal } from "./state.js";
import { refreshBaseline } from "./baseline.js";
import { prepareContinuation } from "./execution.js";
import {
  enqueueJob,
  listQueue,
  cancelQueueEntries,
  cancelJobState,
} from "./queue-api.js";
import { cleanupWorktree } from "./worktree.js";
import { terminateTree } from "./process-runner.js";
import type { JobState } from "./types.js";

export async function startBackground(workspaceInput: string, jobId: string, extra = "", priority = 0, contextSnapshot?: string, shouldRefreshBaseline = false, extraRounds = 0): Promise<void> {
  const workspace = path.resolve(workspaceInput);
  const directory = jobDir(workspace, jobId);
  const continuation = await prepareContinuation(workspace, jobId, extra, extraRounds);
  if (continuation.blocked) throw new Error(continuation.blocked.phase === "adaptive_max_rounds" ? "任务已达 max_rounds；请显式提供 extra_rounds。" : "任务等待 approve，不能通过 continue 恢复。");
  // 显式重新入队（continue/approve/start）：清除上次取消留下的标记。
  await unlink(path.join(directory, "cancel.requested")).catch(() => undefined);
  if (contextSnapshot !== undefined) {
    const governance = (await loadConfig(workspace)).governance;
    const snapshot = redactText(contextSnapshot, governance?.redactFields, governance?.redactPatterns);
    if (snapshot) await writeFile(path.join(directory, "context-snapshot.md"), snapshot, "utf8");
    else await unlink(path.join(directory, "context-snapshot.md")).catch(() => undefined);
  }
  await unlink(path.join(directory, "understanding.json")).catch(() => undefined);
  if (shouldRefreshBaseline) {
    await refreshBaseline(workspace, jobId, directory);
  }
  await enqueueJob(workspaceInput, jobId, continuation.instructions, priority);
}

export async function cancelJob(workspaceInput: string, jobId: string): Promise<JobState> {
  const workspace = path.resolve(workspaceInput);
  const directory = jobDir(workspace, jobId);
  const stateBeforeCancel = await loadState(workspace, jobId);
  const processIds = new Set<number>();
  if (stateBeforeCancel.status === "running") {
    const activePid = Number(await readFile(path.join(directory, "active.pid"), "utf8").catch(() => ""));
    if (Number.isSafeInteger(activePid) && activePid > 0) processIds.add(activePid);
  }
  try {
    const queueBeforeCancel = await listQueue(workspace);
    for (const entry of queueBeforeCancel.entries.filter(item => item.jobId === jobId && item.status === "running")) {
      if (Number.isSafeInteger(entry.pid) && Number(entry.pid) > 0) processIds.add(Number(entry.pid));
    }
  } catch (error) { logJobEvent(workspace, jobId, "queue_snapshot_failed", { error: error instanceof Error ? error.message : String(error) }); }
  await writeFile(path.join(directory, "cancel.requested"), now(), "utf8");
  try { await cancelQueueEntries(workspace, jobId); } catch (error) { logJobEvent(workspace, jobId, "queue_cancel_failed", { error: error instanceof Error ? error.message : String(error) }); }
  const survivors: number[] = [];
  for (const pid of processIds) {
    if (!await terminateTree(pid)) survivors.push(pid);
  }
  if (survivors.length > 0) {
    logJobEvent(workspace, jobId, "cancel_process_survived", { pids: survivors });
    const state = await cancelJobState(workspace, jobId, { status: "needs_fix", phase: "cancel_failed", error: `无法确认进程树已退出：${survivors.join(", ")}` });
    await pruneAfterTerminal(workspace);
    return state;
  }
  try { await cleanupWorktree(workspace, jobId); } catch (error) { logJobEvent(workspace, jobId, "cleanup_failed", { phase: "cancel", error: error instanceof Error ? error.message : String(error) }); }
  const state = await cancelJobState(workspace, jobId, { status: "cancelled", phase: "cancelled", cancelledAt: now() });
  await pruneAfterTerminal(workspace);
  return state;
}
