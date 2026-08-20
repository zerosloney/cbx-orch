import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BATCH_TERMINAL_STATUSES,
  chunkBatch,
  summarizeBatch,
  runBatch,
} from "../src/batch.js";
import { setupFake } from "./helpers.js";

// ---------- chunkBatch：波次分片 ----------

test("chunkBatch: maxBatch<=0 或 >=total 时单片全量", () => {
  const tasks = [{ task: "A" }, { task: "B" }, { task: "C" }];
  assert.deepEqual(chunkBatch(tasks, 0), [tasks]);
  assert.deepEqual(chunkBatch(tasks, 3), [tasks]);
  assert.deepEqual(chunkBatch(tasks, 99), [tasks]);
});

test("chunkBatch: maxBatch=N 按 N 分片，余数成最后一波", () => {
  const tasks = [
    { task: "A" },
    { task: "B" },
    { task: "C" },
    { task: "D" },
    { task: "E" },
  ];
  assert.deepEqual(chunkBatch(tasks, 2), [
    [{ task: "A" }, { task: "B" }],
    [{ task: "C" }, { task: "D" }],
    [{ task: "E" }],
  ]);
  assert.deepEqual(chunkBatch(tasks, 1), [
    [{ task: "A" }],
    [{ task: "B" }],
    [{ task: "C" }],
    [{ task: "D" }],
    [{ task: "E" }],
  ]);
});

test("chunkBatch: 空任务返回空数组", () => {
  assert.deepEqual(chunkBatch([], 2), []);
});

// ---------- summarizeBatch：终态聚合 ----------

test("summarizeBatch: 成功/失败/未完成分类计数", () => {
  const agg = summarizeBatch([
    { jobId: "j1", task: "A", status: "done" },
    { jobId: "j2", task: "B", status: "failed" },
    { jobId: "j3", task: "C", status: "cancelled" },
    { jobId: "j4", task: "D", status: "running" },
  ]);
  assert.equal(agg.total, 4);
  assert.equal(agg.finished, 3);
  assert.equal(agg.succeeded, 1);
  assert.equal(agg.failed, 2);
  assert.deepEqual(agg.unfinished, ["j4"]);
});

test("summarizeBatch: 全成功时 failed=0 且无 unfinished", () => {
  const agg = summarizeBatch([
    { jobId: "j1", task: "A", status: "done" },
    { jobId: "j2", task: "B", status: "done" },
  ]);
  assert.equal(agg.finished, 2);
  assert.equal(agg.succeeded, 2);
  assert.equal(agg.failed, 0);
  assert.deepEqual(agg.unfinished, []);
});

test("BATCH_TERMINAL_STATUSES 覆盖全部终态", () => {
  for (const s of ["done", "failed", "review_failed", "cancelled", "needs_fix"])
    assert.ok(BATCH_TERMINAL_STATUSES.has(s), `缺少终态 ${s}`);
  assert.ok(!BATCH_TERMINAL_STATUSES.has("running"));
  assert.ok(!BATCH_TERMINAL_STATUSES.has("queued"));
});

// ---------- CLI 端到端 ----------

const cliPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "cli.js",
);

test("cbx batch 创建多个任务并输出汇总", async () => {
  const { workspace } = await setupFake();
  const out = spawnSync(
    process.execPath,
    [
      cliPath,
      "batch",
      "--task",
      "任务A",
      "--task",
      "任务B",
      "--workspace",
      workspace,
      "--test",
      'node -e "process.exit(0)"',
      "--no-review",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CBX_CODEBUDDY: process.env.CBX_CODEBUDDY },
    },
  );
  assert.equal(out.status, 0, out.stderr);
  const summary = JSON.parse(out.stdout) as {
    total: number;
    created: number;
    jobs: Array<{ jobId: string; status: string }>;
  };
  assert.equal(summary.total, 2);
  assert.equal(summary.created, 2);
  assert.equal(summary.jobs.length, 2);
  for (const j of summary.jobs) assert.match(j.jobId, /^batch-/);
});

test("cbx batch 无任务时报错", async () => {
  const { workspace } = await setupFake();
  const out = spawnSync(
    process.execPath,
    [cliPath, "batch", "--workspace", workspace],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 1);
  assert.match(out.stderr, /至少提供一个任务/);
});

test("cbx batch --max-batch 1 波次执行并 --wait 汇总终态", async () => {
  const { workspace } = await setupFake();
  const out = spawnSync(
    process.execPath,
    [
      cliPath,
      "batch",
      "--task",
      "任务A",
      "--task",
      "任务B",
      "--max-batch",
      "1",
      "--wait",
      "--wait-timeout-ms",
      "60000",
      "--workspace",
      workspace,
      "--test",
      'node -e "process.exit(0)"',
      "--no-review",
      "--no-isolated",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CBX_CODEBUDDY: process.env.CBX_CODEBUDDY },
      timeout: 120_000,
    },
  );
  assert.equal(out.status, 0, out.stderr);
  const summary = JSON.parse(out.stdout) as {
    total: number;
    finished: number;
    succeeded: number;
    failed: number;
    unfinished: string[];
    jobs: Array<{ jobId: string; status: string }>;
  };
  assert.equal(summary.total, 2);
  assert.equal(summary.finished, 2);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.unfinished, []);
  for (const j of summary.jobs) assert.equal(j.status, "done");
});

test("runBatch 直接调用：透传 executor 并生成 batch- 前缀 jobId", async () => {
  const { workspace } = await setupFake();
  const summary = await runBatch({
    workspace,
    tasks: ["直接调用A", "直接调用B"],
    maxBatch: 0,
    wait: false,
    waitTimeoutMs: 60_000,
    jobOptions: {
      review: false,
      isolated: false,
      permissionMode: "auto",
      maxTurns: 5,
      executor: "codebuddy",
    },
  });
  assert.equal(summary.total, 2);
  assert.equal(summary.created, 2);
  for (const j of summary.jobs) assert.match(j.jobId, /^batch-/);
});
