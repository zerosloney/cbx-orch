import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireServiceLease, loadPersistedQueue, now, processAlive, savePersistedQueue, withFileLock } from "./storage.js";
/** 队列降级路径失败原因落到 job 事件流。 */
function logJobEvent(runtime, workspace, jobId, event, detail = {}) {
    try {
        appendFileSync(path.join(runtime.jobDir(workspace, jobId), "events.ndjson"), JSON.stringify({ event, jobId, ...detail, at: now() }) + "\n", "utf8");
    }
    catch { /* events file unreachable */ }
}
function queueLockFile(workspace) { return path.join(workspace, ".cbx", "queue.lock"); }
async function loadQueue(workspace) {
    const queue = await loadPersistedQueue(workspace, { maxConcurrent: 2, paused: false, entries: [], updatedAt: now() });
    if (!queue || !Array.isArray(queue.entries))
        throw new Error("queue.json 结构无效。");
    queue.paused ??= false;
    for (const entry of queue.entries)
        entry.priority ??= 0;
    return queue;
}
async function saveQueue(workspace, queue) {
    queue.updatedAt = now();
    await savePersistedQueue(workspace, queue);
}
function withQueueLock(workspace, action) {
    return withFileLock(queueLockFile(workspace), action, { busyMessage: "队列正在被另一个调度器更新，请稍后重试。" });
}
function configuredConcurrency(value) {
    const maximum = Number(value ?? 2);
    if (!Number.isInteger(maximum) || maximum < 1)
        throw new Error("maxConcurrent 必须是正整数。");
    return maximum;
}
async function spawnQueueWorker(runtime, workspace, entry) {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
    const args = [cli, "run", "--workspace", workspace, "--job-id", entry.jobId, "--queue-entry-id", entry.queueId];
    if (entry.extra)
        args.push("--message", entry.extra);
    const child = spawn(process.execPath, args, { cwd: workspace, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    await writeFile(path.join(runtime.jobDir(workspace, entry.jobId), "pid"), String(child.pid), "utf8");
    return child.pid ?? -1;
}
export async function dispatchQueue(runtime, workspaceInput) {
    const workspace = path.resolve(workspaceInput);
    try {
        return await withQueueLock(workspace, async () => {
            const maxConcurrent = configuredConcurrency((await runtime.loadConfig(workspace)).maxConcurrent);
            const queue = await loadQueue(workspace);
            queue.maxConcurrent = maxConcurrent;
            for (const entry of queue.entries.filter(item => item.status === "running" && !processAlive(item.pid))) {
                try {
                    const state = await runtime.loadState(workspace, entry.jobId);
                    entry.status = state.status === "done" ? "done" : state.status === "cancelled" ? "cancelled" : "queued";
                }
                catch (error) {
                    logJobEvent(runtime, workspace, entry.jobId, "queue_reclaim_failed", { error: error instanceof Error ? error.message : String(error) });
                    entry.status = "queued";
                }
                entry.pid = undefined;
            }
            let active = queue.entries.filter(entry => entry.status === "running" && processAlive(entry.pid)).length;
            if (!queue.paused) {
                for (const entry of queue.entries.filter(item => item.status === "queued").sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))) {
                    if (active >= maxConcurrent)
                        break;
                    try {
                        entry.pid = await spawnQueueWorker(runtime, workspace, entry);
                        entry.status = "running";
                        entry.startedAt = now();
                        active += 1;
                    }
                    catch (error) {
                        entry.status = "failed";
                        entry.error = String(error);
                        entry.finishedAt = now();
                    }
                }
            }
            const activeEntries = queue.entries.filter(entry => ["queued", "running", "awaiting_approval"].includes(entry.status));
            const finishedEntries = queue.entries.filter(entry => !activeEntries.includes(entry)).slice(-Math.max(0, 200 - activeEntries.length));
            queue.entries = [...finishedEntries, ...activeEntries];
            await saveQueue(workspace, queue);
            return queue;
        });
    }
    catch (error) {
        if (String(error).includes("队列正在被另一个调度器更新"))
            return loadQueue(workspace);
        throw error;
    }
}
/** Keeps a single dispatcher alive; startup dispatch also reclaims workers left by a prior crash. */
export async function serveQueue(runtime, workspaceInput, intervalMs = 30_000) {
    if (!Number.isInteger(intervalMs) || intervalMs < 50)
        throw new Error("serve intervalMs 必须是不小于 50ms 的整数。");
    let stopping = false;
    const releaseLease = await acquireServiceLease(workspaceInput, "queue-serve");
    let inFlight;
    const tick = () => {
        if (stopping || inFlight)
            return inFlight ?? Promise.resolve();
        inFlight = dispatchQueue(runtime, workspaceInput)
            .then(() => undefined)
            .catch(error => console.error(`cbx: 调度器执行失败：${error instanceof Error ? error.message : error}`))
            .finally(() => { inFlight = undefined; });
        return inFlight;
    };
    await tick();
    const timer = setInterval(() => { void tick(); }, intervalMs);
    return { async stop() { stopping = true; clearInterval(timer); await inFlight; await releaseLease(); } };
}
export async function enqueueJob(runtime, workspaceInput, jobId, extra = "", priority = 0) {
    const workspace = path.resolve(workspaceInput);
    if (!Number.isFinite(priority))
        throw new Error("priority 必须是数字。");
    const entry = await withQueueLock(workspace, async () => {
        const maxConcurrent = configuredConcurrency((await runtime.loadConfig(workspace)).maxConcurrent);
        const queue = await loadQueue(workspace);
        queue.maxConcurrent = maxConcurrent;
        const duplicate = queue.entries.find(item => item.jobId === jobId && ["queued", "running"].includes(item.status));
        if (duplicate)
            throw new Error(`任务已经在队列中：${jobId}`);
        const created = { queueId: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, jobId, workspace, extra, status: "queued", createdAt: now(), priority };
        queue.entries.push(created);
        await saveQueue(workspace, queue);
        return created;
    });
    await dispatchQueue(runtime, workspace);
    return entry;
}
export async function finishQueueEntry(runtime, workspaceInput, queueId) {
    const workspace = path.resolve(workspaceInput);
    await withQueueLock(workspace, async () => {
        const queue = await loadQueue(workspace);
        const entry = queue.entries.find(item => item.queueId === queueId);
        if (!entry)
            return;
        let status = "failed";
        try {
            const state = await runtime.loadState(workspace, entry.jobId);
            status = state.status === "done" ? "done" : state.status === "cancelled" ? "cancelled" : state.status === "awaiting_approval" ? "awaiting_approval" : "failed";
        }
        catch (error) {
            entry.error = String(error);
        }
        entry.status = status;
        entry.finishedAt = now();
        entry.pid = undefined;
        await saveQueue(workspace, queue);
    });
    await dispatchQueue(runtime, workspace);
}
export function listQueue(_runtime, workspaceInput) { return loadQueue(path.resolve(workspaceInput)); }
export async function pauseQueue(_runtime, workspaceInput) {
    const workspace = path.resolve(workspaceInput);
    return withQueueLock(workspace, async () => { const queue = await loadQueue(workspace); queue.paused = true; await saveQueue(workspace, queue); return queue; });
}
export async function resumeQueue(runtime, workspaceInput) {
    const workspace = path.resolve(workspaceInput);
    await withQueueLock(workspace, async () => { const queue = await loadQueue(workspace); queue.paused = false; await saveQueue(workspace, queue); });
    return dispatchQueue(runtime, workspace);
}
export async function retryQueueJob(runtime, workspaceInput, jobId, priority = 0) {
    const workspace = path.resolve(workspaceInput);
    const state = await runtime.loadState(workspace, jobId);
    if (["running", "queued"].includes(state.status))
        throw new Error(`任务当前仍在执行或排队：${jobId}`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await dispatchQueue(runtime, workspace);
        const queue = await loadQueue(workspace);
        if (!queue.entries.some(entry => entry.jobId === jobId && ["queued", "running"].includes(entry.status)))
            break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    const replacement = await withQueueLock(workspace, async () => {
        const queue = await loadQueue(workspace);
        for (const entry of queue.entries.filter(item => item.jobId === jobId && ["queued", "running"].includes(item.status))) {
            entry.status = "failed";
            entry.finishedAt = now();
            entry.error = "被新的 retry 请求取代";
            entry.pid = undefined;
        }
        const current = await runtime.loadState(workspace, jobId);
        const created = { queueId: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, jobId, workspace, extra: "请读取已有的 test.log、review.md 和 result.json，修复失败原因后重新执行。", status: "queued", createdAt: now(), priority };
        queue.entries.push(created);
        queue.updatedAt = now();
        await runtime.saveStateAndQueue(workspace, jobId, { ...current, status: "queued", phase: "queued", error: null, timedOut: false, updatedAt: now() }, queue);
        return created;
    });
    await dispatchQueue(runtime, workspace);
    return replacement;
}
