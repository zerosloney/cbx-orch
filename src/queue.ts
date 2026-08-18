import { spawn } from "node:child_process";
import { CbxError, isCbxError } from "./errors.js";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireServiceLease,
  loadPersistedQueue,
  now,
  readQueueRows,
  savePersistedQueue,
  type CbxDatabase,
  type PersistedQueueLike,
  withQueueTxLock,
  writeQueueRows,
  upsertJobStateRow,
  finishQueueEntryRow,
  mapStateToQueueStatus,
} from "./storage.js";
import { processAlive } from "./lock.js";
import { terminateTree } from "./process-runner.js";

/** 队列降级路径失败原因落到 job 事件流。 */
function logJobEvent(runtime: QueueRuntime, workspace: string, jobId: string, event: string, detail: Record<string, unknown> = {}): void {
  try { appendFileSync(path.join(runtime.jobDir(workspace, jobId), "events.ndjson"), JSON.stringify({ event, jobId, ...detail, at: now() }) + "\n", "utf8"); }
  catch { /* events file unreachable */ }
}

export type QueueEntryStatus = "queued" | "running" | "done" | "failed" | "awaiting_approval" | "cancelled";
export interface QueueEntry {
  queueId: string; jobId: string; workspace: string; extra: string; status: QueueEntryStatus;
  createdAt: string; startedAt?: string; finishedAt?: string; pid?: number; error?: string; priority: number;
  /** 死 worker 被回收重派的累计次数；超过上限熔断为 failed，避免损坏状态引发无限重派。 */
  reclaimCount?: number;
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

export interface QueueService { done: Promise<void>; stop(): Promise<void>; }

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

/** 在 withQueueTxLock 事务内同步读取队列，提供与 loadQueue 一致的默认值。 */
function readQueueFromDb(db: CbxDatabase): QueueFile {
  const stored = readQueueRows(db);
  if (!stored) return { maxConcurrent: 2, paused: false, entries: [], updatedAt: now() };
  return {
    maxConcurrent: stored.maxConcurrent ?? 2,
    paused: stored.paused ?? false,
    updatedAt: stored.updatedAt ?? now(),
    entries: (stored.entries as unknown as QueueEntry[]).map(e => ({ ...e, priority: e.priority ?? 0 })),
  };
}

function configuredConcurrency(value: number | undefined): number {
  const maximum = Number(value ?? 2);
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error("maxConcurrent 必须是正整数。");
  return maximum;
}

// intentional-simple: worker 起步 + worktree 创建 + executor spawn 应 < 60s。超过仍无 heartbeat 视为僵尸（pid 复用或 spawn ENOENT 后 pid 被复用）。
const WORKER_HEARTBEAT_GRACE_MS = 60_000;
const WORKER_HEARTBEAT_STALE_MS = 45_000;
// 死 worker 回收重派的上限：超过即熔断为 failed，避免状态永久损坏时无限 spawn。
const MAX_RECLAIMS = 3;
const SERVICE_LEASE_TTL_MS = 45_000;

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
    // Phase 1: 异步 recon 在锁外执行（stat/processAlive/terminateTree/loadState/spawn 均为异步副作用）
    const maxConcurrent = configuredConcurrency((await runtime.loadConfig(workspace)).maxConcurrent);
    const snapshot = await loadQueue(workspace);

    // 回收判定：收集每个 running entry 的回收结果，Phase 2 在事务内按 queueId 匹配应用
    const reconResults = new Map<string, { status: QueueEntryStatus; reclaimCount?: number; error?: string; finishedAt?: string }>();
    for (const entry of snapshot.entries.filter(item => item.status === "running")) {
      const heartbeatFile = path.join(runtime.jobDir(workspace, entry.jobId), "worker.heartbeat");
      let heartbeatModifiedAt: number | undefined;
      try { heartbeatModifiedAt = (await stat(heartbeatFile)).mtimeMs; } catch { /* worker may not have started */ }
      const startedAt = Date.parse(entry.startedAt ?? entry.createdAt);
      const stale = !processAlive(entry.pid)
        || (heartbeatModifiedAt === undefined && Number.isFinite(startedAt) && Date.now() - startedAt > WORKER_HEARTBEAT_GRACE_MS)
        || (heartbeatModifiedAt !== undefined && Date.now() - heartbeatModifiedAt > WORKER_HEARTBEAT_STALE_MS);
      if (!stale) continue;
      if (!processAlive(entry.pid)) {
        const activePid = Number(
          await readFile(path.join(runtime.jobDir(workspace, entry.jobId), "active.pid"), "utf8").catch(() => ""),
        );
        if (Number.isSafeInteger(activePid) && activePid > 0) {
          const killed = await terminateTree(activePid).catch(() => false);
          logJobEvent(runtime, workspace, entry.jobId, "queue_reclaim_killed_stray_executor", { pid: activePid, killed });
        }
      }
      let reclaimed: QueueEntryStatus;
      try {
        const state = await runtime.loadState(workspace, entry.jobId);
        reclaimed = state.status === "done" ? "done" : state.status === "cancelled" ? "cancelled" : "queued";
      } catch (error) { logJobEvent(runtime, workspace, entry.jobId, "queue_reclaim_failed", { error: error instanceof Error ? error.message : String(error) }); reclaimed = "queued"; }
      if (reclaimed === "queued") {
        const reclaimCount = heartbeatModifiedAt !== undefined ? 0 : (entry.reclaimCount ?? 0) + 1;
        if (reclaimCount > MAX_RECLAIMS) {
          reconResults.set(entry.queueId, { status: "failed", reclaimCount, error: `worker 反复无法恢复（已回收 ${reclaimCount} 次），停止自动重派；请检查任务状态后用 retry 手动重跑。`, finishedAt: now() });
          logJobEvent(runtime, workspace, entry.jobId, "queue_reclaim_circuit_breaker", { reclaimCount });
        } else {
          reconResults.set(entry.queueId, { status: "queued", reclaimCount });
        }
      } else {
        reconResults.set(entry.queueId, { status: reclaimed });
      }
    }

    // 派生 worker：基于回收后的预期活跃数计算可派生槽位
    const staleIds = reconResults.size;
    const activeAfterReclaim = snapshot.entries.filter(e => e.status === "running" && processAlive(e.pid)).length - staleIds;
    const spawnResults = new Map<string, { pid: number; startedAt: string } | { error: string; finishedAt: string }>();
    if (!snapshot.paused) {
      let active = Math.max(0, activeAfterReclaim);
      for (const entry of snapshot.entries.filter(item => item.status === "queued").sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))) {
        if (active >= maxConcurrent) break;
        try {
          const pid = await spawnQueueWorker(runtime, workspace, entry);
          spawnResults.set(entry.queueId, { pid, startedAt: now() });
          active += 1;
        } catch (error) {
          spawnResults.set(entry.queueId, { error: String(error), finishedAt: now() });
        }
      }
    }

    // Phase 2: BEGIN IMMEDIATE 事务内重读、应用回收/派生结果、写回
    return await withQueueTxLock(workspace, (db) => {
      const queue = readQueueFromDb(db);
      queue.maxConcurrent = maxConcurrent;
      // 应用回收结果：仅当 DB 中 entry 仍为 running 时（状态可能已被其他进程改变）
      for (const entry of queue.entries.filter(e => e.status === "running")) {
        const recon = reconResults.get(entry.queueId);
        if (!recon) continue;
        entry.status = recon.status;
        if (recon.reclaimCount !== undefined) entry.reclaimCount = recon.reclaimCount;
        if (recon.error !== undefined) entry.error = recon.error;
        if (recon.finishedAt !== undefined) entry.finishedAt = recon.finishedAt;
        entry.pid = undefined;
      }
      // 应用派生结果：仅当 DB 中 entry 仍为 queued 时
      for (const entry of queue.entries.filter(e => e.status === "queued")) {
        const spawn = spawnResults.get(entry.queueId);
        if (!spawn) continue;
        if ("pid" in spawn) {
          entry.pid = spawn.pid;
          entry.status = "running";
          entry.startedAt = spawn.startedAt;
        } else {
          entry.status = "failed";
          entry.error = spawn.error;
          entry.finishedAt = spawn.finishedAt;
        }
      }
      const activeEntries = queue.entries.filter(entry => ["queued", "running", "awaiting_approval"].includes(entry.status));
      const finishedEntries = queue.entries.filter(entry => !activeEntries.includes(entry)).slice(-Math.max(0, 200 - activeEntries.length));
      queue.entries = [...finishedEntries, ...activeEntries];
      queue.updatedAt = now();
      writeQueueRows(db, queue as unknown as PersistedQueueLike, queue.updatedAt);
      return queue;
    });
  } catch (error) {
    if (isCbxError(error, "E_QUEUE_BUSY")) return loadQueue(workspace);
    throw error;
  }
}

/** Keeps a single dispatcher alive; startup dispatch also reclaims workers left by a prior crash. */
export async function serveQueue(runtime: QueueRuntime, workspaceInput: string, intervalMs = 30_000): Promise<QueueService> {
  if (!Number.isInteger(intervalMs) || intervalMs < 50) throw new Error("serve intervalMs 必须是不小于 50ms 的整数。");
  let stopping = false;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const lease = await acquireServiceLease(workspaceInput, "queue-serve", SERVICE_LEASE_TTL_MS);
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
  const leaseTimer = setInterval(() => {
    void lease.renew().then(owned => {
      if (owned || stopping) return;
      stopping = true;
      clearInterval(timer);
      clearInterval(leaseTimer);
      console.error("cbx: serve 租约已丢失，停止调度以避免双主。");
      resolveDone();
    }).catch(error => console.error(`cbx: serve 租约续期失败：${error instanceof Error ? error.message : error}`));
  }, Math.floor(SERVICE_LEASE_TTL_MS / 3));
  leaseTimer.unref();
  return { done, async stop(): Promise<void> { stopping = true; clearInterval(timer); clearInterval(leaseTimer); await inFlight; await lease.release(); resolveDone(); } };
}

export async function enqueueJob(runtime: QueueRuntime, workspaceInput: string, jobId: string, extra = "", priority = 0): Promise<QueueEntry> {
  const workspace = path.resolve(workspaceInput);
  if (!Number.isFinite(priority)) throw new Error("priority 必须是数字。");
  const maxConcurrent = configuredConcurrency((await runtime.loadConfig(workspace)).maxConcurrent);
  const entry = await withQueueTxLock(workspace, (db) => {
    const queue = readQueueFromDb(db);
    queue.maxConcurrent = maxConcurrent;
    // awaiting_approval 也是活跃状态：等待审批的任务不应被再次入队（否则双 entry 会旁路审批门）。
    const duplicate = queue.entries.find(
      (item) =>
        item.jobId === jobId &&
        ["queued", "running", "awaiting_approval"].includes(item.status),
    );
    if (duplicate)
        throw new CbxError("E_STATE_CONFLICT", `任务已经在队列中：${jobId}`);
    const created: QueueEntry = { queueId: `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, jobId, workspace, extra, status: "queued", createdAt: now(), priority };
    queue.entries.push(created);
    queue.updatedAt = now();
    writeQueueRows(db, queue as unknown as PersistedQueueLike, queue.updatedAt);
    return created;
  });
  await dispatchQueue(runtime, workspace);
  return entry;
}

export async function finishQueueEntry(runtime: QueueRuntime, workspaceInput: string, queueId: string): Promise<void> {
  const workspace = path.resolve(workspaceInput);
  const snapshot = await loadQueue(workspace);
  const entry = snapshot.entries.find(item => item.queueId === queueId);
  if (!entry) return;
  let state: Record<string, unknown>;
  try { state = await runtime.loadState(workspace, entry.jobId); }
  catch (error) {
    // loadState 失败时降级手写 failed，与历史行为一致；映射逻辑权威来源仍是 finishQueueEntryPersisted。
    await withQueueTxLock(workspace, (db) => {
      const queue = readQueueFromDb(db);
      const target = queue.entries.find(item => item.queueId === queueId);
      if (!target) return;
      target.status = "failed"; target.error = String(error); target.finishedAt = now(); target.pid = undefined;
      queue.updatedAt = now();
      writeQueueRows(db, queue as unknown as PersistedQueueLike, queue.updatedAt);
    });
    await dispatchQueue(runtime, workspace);
    return;
  }
  // 状态映射收敛到 storage 层 finishQueueEntryPersisted，queue 层不再存副本。
  await runtime.finishQueueEntryPersisted(workspace, entry.jobId, state, queueId);
  await dispatchQueue(runtime, workspace);
}

export function listQueue(_runtime: QueueRuntime, workspaceInput: string): Promise<QueueFile> { return loadQueue(path.resolve(workspaceInput)); }

export async function pauseQueue(_runtime: QueueRuntime, workspaceInput: string): Promise<QueueFile> {
  const workspace = path.resolve(workspaceInput);
  return withQueueTxLock(workspace, (db) => {
    const queue = readQueueFromDb(db);
    queue.paused = true;
    queue.updatedAt = now();
    writeQueueRows(db, queue as unknown as PersistedQueueLike, queue.updatedAt);
    return queue;
  });
}

/** 把某任务仍处于 queued/running/awaiting_approval 的队列条目标记为 cancelled。 */
export async function cancelQueueEntries(runtime: QueueRuntime, workspaceInput: string, jobId: string): Promise<QueueFile> {
  const workspace = path.resolve(workspaceInput);
  return withQueueTxLock(workspace, (db) => {
    const queue = readQueueFromDb(db);
    for (const entry of queue.entries.filter(item => item.jobId === jobId && ["queued", "running", "awaiting_approval"].includes(item.status))) {
      entry.status = "cancelled";
      entry.finishedAt = now();
      entry.pid = undefined;
    }
    queue.updatedAt = now();
    writeQueueRows(db, queue as unknown as PersistedQueueLike, queue.updatedAt);
    return queue;
  });
}

/**
 * 单锁内原子完成取消终态：把 jobId 所有活跃队列条目标记 cancelled，并同时写入最终 state。
 * 与 worker 终态双写（writeState 携带 queueEntryId 的路径）共用同一把队列锁，二者串行化，
 * 避免并发时 state 与 queue entry 撕裂——典型场景：任务恰好自然完成写了 done，
 * cancelJob 随后单独写 cancelled，导致 state=cancelled 而 entry=done 的不一致残留。
 * 幂等：已 cancelled/done 的条目不会被再次改写。
 */
export async function cancelQueueEntriesWithState(
  runtime: QueueRuntime,
  workspaceInput: string,
  jobId: string,
  updates: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const workspace = path.resolve(workspaceInput);
  const current = (await runtime.loadState(
    workspace,
    jobId,
  )) as Record<string, unknown>;
  const state = { ...current, ...updates, updatedAt: now() };
  return withQueueTxLock(workspace, (db) => {
    const queue = readQueueFromDb(db);
    for (const entry of queue.entries.filter(
      (item) =>
        item.jobId === jobId &&
        ["queued", "running", "awaiting_approval"].includes(item.status),
    )) {
      entry.status = "cancelled";
      entry.finishedAt = now();
      entry.pid = undefined;
    }
    upsertJobStateRow(db, jobId, JSON.stringify(state));
    queue.updatedAt = now();
    writeQueueRows(db, queue as unknown as PersistedQueueLike, queue.updatedAt);
    return state;
  });
}

export async function resumeQueue(runtime: QueueRuntime, workspaceInput: string): Promise<QueueFile> {
  const workspace = path.resolve(workspaceInput);
  await withQueueTxLock(workspace, (db) => {
    const queue = readQueueFromDb(db);
    queue.paused = false;
    queue.updatedAt = now();
    writeQueueRows(db, queue as unknown as PersistedQueueLike, queue.updatedAt);
  });
  return dispatchQueue(runtime, workspace);
}

export async function retryQueueJob(runtime: QueueRuntime, workspaceInput: string, jobId: string, priority = 0): Promise<QueueEntry> {
  const workspace = path.resolve(workspaceInput);
  const state = await runtime.loadState(workspace, jobId);
  if (["running", "queued", "awaiting_approval"].includes(state.status)) throw new CbxError(
    "E_STATE_CONFLICT",
    `任务当前仍在执行、排队或等待审批：${jobId}`,
  );
  const directory = runtime.jobDir(workspace, jobId);
  // Phase 1: 异步副作用在事务外执行（文件操作 + terminateTree + loadState）。
  // terminateTree 原与 entry 变更同在文件锁内防 dispatchQueue 回收并发；
  // 迁移到 BEGIN IMMEDIATE 后，dispatchQueue 同样为两阶段（锁外 recon + 事务内应用），
  // 两者 Phase 2 互斥由 BEGIN IMMEDIATE 保证，Phase 1 交错不影响正确性。
  await writeFile(path.join(directory, "cancel.requested"), now(), "utf8").catch(() => undefined);
  const oldPid = Number(await readFile(path.join(directory, "active.pid"), "utf8").catch(() => ""));
  if (Number.isSafeInteger(oldPid) && oldPid > 0) await terminateTree(oldPid);
  try { await unlink(path.join(directory, "cancel.requested")); } catch { /* 无待取消标记 */ }
  const current = await runtime.loadState(workspace, jobId);
  const resetState = { ...current, status: "queued", phase: "queued", error: null, timedOut: false, updatedAt: now(), executionUsed: 0, fixUsed: 0, stageRetries: {} };
  // Phase 2: BEGIN IMMEDIATE 事务内完成老 entry 标 cancelled + 插新 entry + 状态重置写回。
  const replacement = await withQueueTxLock(workspace, (db) => {
    const queue = readQueueFromDb(db);
    for (const entry of queue.entries.filter(item => item.jobId === jobId && ["queued", "running"].includes(item.status))) {
      entry.status = "cancelled"; entry.finishedAt = now(); entry.error = "被新的 retry 请求取代"; entry.pid = undefined;
    }
    const created: QueueEntry = { queueId: `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, jobId, workspace, extra: "请读取已有的 test.log、review.md 和 result.json，修复失败原因后重新执行。", status: "queued", createdAt: now(), priority };
    queue.entries.push(created);
    queue.updatedAt = now();
    upsertJobStateRow(db, jobId, JSON.stringify(resetState));
    writeQueueRows(db, queue as unknown as PersistedQueueLike, queue.updatedAt);
    return created;
  });
  await dispatchQueue(runtime, workspace);
  return replacement;
}
