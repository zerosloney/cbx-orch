import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireServiceLease, loadPersistedQueue, now, processAlive, savePersistedQueue, withFileLock } from "./storage.js";

/** 队列降级路径失败原因落到 job 事件流。 */
function logJobEvent(runtime: QueueRuntime, workspace: string, jobId: string, event: string, detail: Record<string, unknown> = {}): void {
  try { appendFileSync(path.join(runtime.jobDir(workspace, jobId), "events.ndjson"), JSON.stringify({ event, jobId, ...detail, at: now() }) + "\n", "utf8"); }
  catch { /* events file unreachable */ }
}

export type QueueEntryStatus = "queued" | "running" | "done" | "failed" | "awaiting_approval" | "cancelled";
export interface QueueEntry {
  queueId: string; jobId: string; workspace: string; extra: string; status: QueueEntryStatus;
  createdAt: string; startedAt?: string; finishedAt?: string; pid?: number; error?: string; priority: number;
}
export interface QueueFile { maxConcurrent: number; paused: boolean; entries: QueueEntry[]; updatedAt: string; }

export interface QueueRuntime {
  loadConfig(workspace: string): Promise<{ maxConcurrent?: number }>;
  loadState(workspace: string, jobId: string): Promise<{ status: string; [key: string]: unknown }>;
  writeState(workspace: string, jobId: string, updates: Record<string, unknown>): Promise<unknown>;
  saveStateAndQueue(workspace: string, jobId: string, state: Record<string, unknown>, queue: QueueFile): Promise<void>;
  finishQueueEntryPersisted(workspace: string, jobId: string, state: Record<string, unknown>, queueId: string): Promise<void>;
  jobDir(workspace: string, jobId: string): string;
}

export interface QueueService { stop(): Promise<void>; }

function queueLockFile(workspace: string): string { return path.join(workspace, ".cbx", "queue.lock"); }

async function loadQueue(workspace: string): Promise<QueueFile> {
  const queue = await loadPersistedQueue<QueueFile>(workspace, { maxConcurrent: 2, paused: false, entries: [], updatedAt: now() });
  if (!queue || !Array.isArray(queue.entries)) throw new Error("queue.json 结构无效。");
  queue.paused ??= false;
  for (const entry of queue.entries) entry.priority ??= 0;
  return queue;
}

async function saveQueue(workspace: string, queue: QueueFile): Promise<void> {
  queue.updatedAt = now();
  await savePersistedQueue(workspace, queue);
}

function withQueueLock<T>(workspace: string, action: () => Promise<T>): Promise<T> {
  return withFileLock(queueLockFile(workspace), action, { busyMessage: "队列正在被另一个调度器更新，请稍后重试。" });
}

function configuredConcurrency(value: number | undefined): number {
  const maximum = Number(value ?? 2);
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error("maxConcurrent 必须是正整数。");
  return maximum;
}

// intentional-simple: worker 起步 + worktree 创建 + executor spawn 应 < 60s。超过仍无 heartbeat 视为僵尸（pid 复用或 spawn ENOENT 后 pid 被复用）。
const WORKER_HEARTBEAT_GRACE_MS = 60_000;

async function spawnQueueWorker(runtime: QueueRuntime, workspace: string, entry: QueueEntry): Promise<number> {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  const args = [cli, "run", "--workspace", workspace, "--job-id", entry.jobId, "--queue-entry-id", entry.queueId];
  if (entry.extra) args.push("--message", entry.extra);
  const child = spawn(process.execPath, args, { cwd: workspace, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  await writeFile(path.join(runtime.jobDir(workspace, entry.jobId), "pid"), String(child.pid), "utf8");
  return child.pid ?? -1;
}

export async function dispatchQueue(runtime: QueueRuntime, workspaceInput: string): Promise<QueueFile> {
  const workspace = path.resolve(workspaceInput);
  try {
    return await withQueueLock(workspace, async () => {
      const maxConcurrent = configuredConcurrency((await runtime.loadConfig(workspace)).maxConcurrent);
      const queue = await loadQueue(workspace);
      queue.maxConcurrent = maxConcurrent;
      for (const entry of queue.entries.filter(item => item.status === "running")) {
        // 双重回收校验：pid 不存活 OR 有 pid 但无 heartbeat 且超 grace（pid 复用 / spawn ENOENT 后 pid 被复用）。
        const heartbeatFile = path.join(runtime.jobDir(workspace, entry.jobId), "worker.heartbeat");
        const stale = !processAlive(entry.pid)
          || (!existsSync(heartbeatFile) && entry.startedAt && Date.now() - Date.parse(entry.startedAt) > WORKER_HEARTBEAT_GRACE_MS);
        if (!stale) continue;
        try {
          const state = await runtime.loadState(workspace, entry.jobId);
          entry.status = state.status === "done" ? "done" : state.status === "cancelled" ? "cancelled" : "queued";
        } catch (error) { logJobEvent(runtime, workspace, entry.jobId, "queue_reclaim_failed", { error: error instanceof Error ? error.message : String(error) }); entry.status = "queued"; }
        entry.pid = undefined;
      }
      let active = queue.entries.filter(entry => entry.status === "running" && processAlive(entry.pid)).length;
      if (!queue.paused) {
        for (const entry of queue.entries.filter(item => item.status === "queued").sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))) {
          if (active >= maxConcurrent) break;
          try { entry.pid = await spawnQueueWorker(runtime, workspace, entry); entry.status = "running"; entry.startedAt = now(); active += 1; }
          catch (error) { entry.status = "failed"; entry.error = String(error); entry.finishedAt = now(); }
        }
      }
      const activeEntries = queue.entries.filter(entry => ["queued", "running", "awaiting_approval"].includes(entry.status));
      const finishedEntries = queue.entries.filter(entry => !activeEntries.includes(entry)).slice(-Math.max(0, 200 - activeEntries.length));
      queue.entries = [...finishedEntries, ...activeEntries];
      await saveQueue(workspace, queue);
      return queue;
    });
  } catch (error) {
    if (String(error).includes("队列正在被另一个调度器更新")) return loadQueue(workspace);
    throw error;
  }
}

/** Keeps a single dispatcher alive; startup dispatch also reclaims workers left by a prior crash. */
export async function serveQueue(runtime: QueueRuntime, workspaceInput: string, intervalMs = 30_000): Promise<QueueService> {
  if (!Number.isInteger(intervalMs) || intervalMs < 50) throw new Error("serve intervalMs 必须是不小于 50ms 的整数。");
  let stopping = false;
  const releaseLease = await acquireServiceLease(workspaceInput, "queue-serve");
  let inFlight: Promise<void> | undefined;
  const tick = (): Promise<void> => {
    if (stopping || inFlight) return inFlight ?? Promise.resolve();
    inFlight = dispatchQueue(runtime, workspaceInput)
      .then(() => undefined)
      .catch(error => console.error(`cbx: 调度器执行失败：${error instanceof Error ? error.message : error}`))
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };
  await tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  return { async stop(): Promise<void> { stopping = true; clearInterval(timer); await inFlight; await releaseLease(); } };
}

export async function enqueueJob(runtime: QueueRuntime, workspaceInput: string, jobId: string, extra = "", priority = 0): Promise<QueueEntry> {
  const workspace = path.resolve(workspaceInput);
  if (!Number.isFinite(priority)) throw new Error("priority 必须是数字。");
  const entry = await withQueueLock(workspace, async () => {
    const maxConcurrent = configuredConcurrency((await runtime.loadConfig(workspace)).maxConcurrent);
    const queue = await loadQueue(workspace);
    queue.maxConcurrent = maxConcurrent;
    const duplicate = queue.entries.find(item => item.jobId === jobId && ["queued", "running"].includes(item.status));
    if (duplicate) throw new Error(`任务已经在队列中：${jobId}`);
    const created: QueueEntry = { queueId: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, jobId, workspace, extra, status: "queued", createdAt: now(), priority };
    queue.entries.push(created);
    await saveQueue(workspace, queue);
    return created;
  });
  await dispatchQueue(runtime, workspace);
  return entry;
}

export async function finishQueueEntry(runtime: QueueRuntime, workspaceInput: string, queueId: string): Promise<void> {
  const workspace = path.resolve(workspaceInput);
  await withQueueLock(workspace, async () => {
    const queue = await loadQueue(workspace);
    const entry = queue.entries.find(item => item.queueId === queueId);
    if (!entry) return;
    let state: Record<string, unknown>;
    try { state = await runtime.loadState(workspace, entry.jobId); }
    catch (error) {
      // loadState 失败时降级手写 failed，与历史行为一致；映射逻辑权威来源仍是 finishQueueEntryPersisted。
      entry.status = "failed"; entry.error = String(error); entry.finishedAt = now(); entry.pid = undefined;
      await saveQueue(workspace, queue);
      return;
    }
    // 状态映射收敛到 storage 层 finishQueueEntryPersisted，queue 层不再存副本。
    await runtime.finishQueueEntryPersisted(workspace, entry.jobId, state, queueId);
  });
  await dispatchQueue(runtime, workspace);
}

export function listQueue(_runtime: QueueRuntime, workspaceInput: string): Promise<QueueFile> { return loadQueue(path.resolve(workspaceInput)); }

export async function pauseQueue(_runtime: QueueRuntime, workspaceInput: string): Promise<QueueFile> {
  const workspace = path.resolve(workspaceInput);
  return withQueueLock(workspace, async () => { const queue = await loadQueue(workspace); queue.paused = true; await saveQueue(workspace, queue); return queue; });
}

/** 把某任务仍处于 queued/running 的队列条目标记为 cancelled，阻止调度器继续启动它。 */
export async function cancelQueueEntries(runtime: QueueRuntime, workspaceInput: string, jobId: string): Promise<QueueFile> {
  const workspace = path.resolve(workspaceInput);
  return withQueueLock(workspace, async () => {
    const queue = await loadQueue(workspace);
    for (const entry of queue.entries.filter(item => item.jobId === jobId && ["queued", "running"].includes(item.status))) {
      entry.status = "cancelled";
      entry.finishedAt = now();
      entry.pid = undefined;
    }
    await saveQueue(workspace, queue);
    return queue;
  });
}

export async function resumeQueue(runtime: QueueRuntime, workspaceInput: string): Promise<QueueFile> {
  const workspace = path.resolve(workspaceInput);
  await withQueueLock(workspace, async () => { const queue = await loadQueue(workspace); queue.paused = false; await saveQueue(workspace, queue); });
  return dispatchQueue(runtime, workspace);
}

export async function retryQueueJob(runtime: QueueRuntime, workspaceInput: string, jobId: string, priority = 0): Promise<QueueEntry> {
  const workspace = path.resolve(workspaceInput);
  const state = await runtime.loadState(workspace, jobId);
  if (["running", "queued"].includes(state.status)) throw new Error(`任务当前仍在执行或排队：${jobId}`);
  // 显式重跑：清除上一次取消留下的标记，避免 executeJob 再次把任务直接判为 cancelled。
  try { await unlink(path.join(runtime.jobDir(workspace, jobId), "cancel.requested")); } catch { /* 无待取消标记 */ }
  // 单事务完成：老 queued/running entry 标 cancelled + 插新 entry + 状态重置。删外层 busy-wait，避免 dispatch 锁竞争时新老 entry 并存。
  const replacement = await withQueueLock(workspace, async () => {
    const queue = await loadQueue(workspace);
    for (const entry of queue.entries.filter(item => item.jobId === jobId && ["queued", "running"].includes(item.status))) {
      entry.status = "cancelled"; entry.finishedAt = now(); entry.error = "被新的 retry 请求取代"; entry.pid = undefined;
    }
    const current = await runtime.loadState(workspace, jobId);
    const created: QueueEntry = { queueId: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, jobId, workspace, extra: "请读取已有的 test.log、review.md 和 result.json，修复失败原因后重新执行。", status: "queued", createdAt: now(), priority };
    queue.entries.push(created);
    queue.updatedAt = now();
    await runtime.saveStateAndQueue(workspace, jobId, { ...current, status: "queued", phase: "queued", error: null, timedOut: false, updatedAt: now() }, queue);
    return created;
  });
  await dispatchQueue(runtime, workspace);
  return replacement;
}
