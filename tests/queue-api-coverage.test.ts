import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cancelJobState,
  dispatchQueue,
  enqueueJob,
  finishQueueEntry,
  health,
  listQueue,
  pauseQueue,
  resumeQueue,
  retryQueueJob,
  serveQueue,
} from "../src/queue-api.js";
import { createJob } from "./helpers.js";

// queue-api.ts 门面层的进程内覆盖：dispatchQueue/health（含治理裁剪分支）/serveQueue/
// enqueue/finish/cancel/retry 全链路，透传 queueRuntime 的 saveStateAndQueue 事务写入。

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cbx-queue-api-"));
}

test("queue-api: health 在无治理配置时跳过任务裁剪", async () => {
  const workspace = await tempWorkspace();
  const result = await health(workspace);
  assert.equal(result.status, "ok");
  assert.ok(result.metrics);
});

test("queue-api: health 开启 governance.pruneJobs 时执行过期清理", async () => {
  const workspace = await tempWorkspace();
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ governance: { pruneJobs: true, retentionDays: 7 } }),
    "utf8",
  );
  const result = await health(workspace);
  assert.equal(result.status, "ok");
});

test("queue-api: serveQueue 启动后可正常停止", async () => {
  const workspace = await tempWorkspace();
  const service = await serveQueue(workspace, 60);
  assert.ok(service);
  assert.equal(typeof service.stop, "function");
  await service.stop();
  await service.done;
});

test("queue-api: dispatchQueue 在空队列上返回队列快照", async () => {
  const workspace = await tempWorkspace();
  const queue = await dispatchQueue(workspace);
  assert.equal(queue.paused, false);
  assert.deepEqual(queue.entries ?? [], []);
});

test("queue-api: enqueue/list/pause/resume/finish/retry/cancel 全链路", async () => {
  const workspace = await tempWorkspace();
  const job = await createJob({
    workspace,
    task: "queue-api 全链路",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 1,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "qa-chain",
  });

  const entry = await enqueueJob(workspace, job.jobId, "extra", 3);
  assert.equal(entry.jobId, job.jobId);
  assert.equal(entry.priority, 3);

  const listed = await listQueue(workspace);
  assert.equal((listed.entries ?? []).length, 1);

  const paused = await pauseQueue(workspace);
  assert.equal(paused.paused, true);
  const resumed = await resumeQueue(workspace);
  assert.equal(resumed.paused, false);

  // 已在队列中的任务重复 enqueue 抛状态冲突
  await assert.rejects(enqueueJob(workspace, job.jobId, "", 0), /任务已经在队列中/);

  // job 处于排队态时 retry 拒绝（E_STATE_CONFLICT）
  await assert.rejects(retryQueueJob(workspace, job.jobId, 5), /任务当前仍在执行/);

  await finishQueueEntry(workspace, entry.queueId);
  // finish 后条目保留在队列快照中作为历史；状态由 job 状态映射（未执行 → failed，已执行 → done）
  const finished = ((await listQueue(workspace)).entries ?? []).find(
    (item) => item.queueId === entry.queueId,
  );
  assert.ok(
    finished?.status === "done" || finished?.status === "failed",
    `finish 后条目应转终态，实际：${finished?.status}`,
  );

  const cancelled = await cancelJobState(workspace, job.jobId, {
    status: "cancelled",
    phase: "cancelled",
  });
  assert.equal(cancelled.status, "cancelled");
  const activeAfterCancel = ((await listQueue(workspace)).entries ?? []).filter(
    (item) => item.status === "queued" || item.status === "running",
  );
  assert.equal(activeAfterCancel.length, 0);
});
