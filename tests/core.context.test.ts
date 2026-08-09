import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  fakeAgent,
  setupFake,
  createAdaptiveJob,
  initializeGitWorkspace,
  approveJob,
  cancelJob,
  createJob,
  executeJob,
  health,
  listJobs,
  listQueue,
  loadConfig,
  loadState,
  mergeConfig,
  pauseQueue,
  readArtifact,
  readEventsIncremental,
  resumeQueue,
  retryQueueJob,
  serveQueue,
  startBackground,
  runReviewGate,
  stopReviewGateHook,
  acquireServiceLease,
  loadPersistedQueue,
  loadPersistedState,
  savePersistedStateAndQueue,
  BUILTIN_EXECUTORS,
  resolveExecutor,
  parseNextAction,
  CONTEXT_PACK_MAX_CHARS,
  parseContextPack,
  createHumanGate,
  extendRoundLimit,
  parseHumanGate,
  resolveHumanGate,
  type JobState,
} from "./helpers.js";

test("mid-chain stage failure preserves earlier stage reports in result.json", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_OPENCODE = script;
  spawnSync("git", ["init", "-b", "main"], {
    cwd: workspace,
    encoding: "utf8",
  });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], {
    cwd: workspace,
  });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], {
    cwd: workspace,
    encoding: "utf8",
  });
  const job = await createJob({
    workspace,
    task: "阶段失败",
    testCommand: 'node -e "process.exit(0)"',
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "stage-fail",
    taskContract: {
      goal: "接力链",
      stages: [
        { name: "a", executor: "codebuddy", task: "t1" },
        { name: "b", executor: "opencode", task: "t2" },
      ],
    },
  });
  // 计数器放 job.directory（git 排除 .cbx），避免握手阶段的工作区 diff 被误判为"修改了工作区"。
  const counter = path.join(job.directory, "counter.txt");
  // 执行序：index 0 = 上下文握手（exit 0），index 1 = stage0（exit 0），index 2 = stage1（exit 1 触发失败）
  process.env.FAKE_COUNTER_FILE = counter;
  process.env.FAKE_EXIT_SEQUENCE = "0,0,1";
  process.env.FAKE_JOB_DIR = job.directory;
  let state;
  try {
    state = await executeJob(workspace, job.jobId);
  } finally {
    delete process.env.CBX_OPENCODE;
  }
  assert.equal(state.status, "failed");
  const result = JSON.parse(
    await readArtifact(workspace, job.jobId, "result.json"),
  );
  assert.ok(
    Array.isArray(result.stages),
    "result.json should keep stage reports after mid-chain failure",
  );
  assert.equal(result.stages.length, 2);
  assert.equal(result.stages[0].name, "a");
  assert.equal(result.stages[0].exitCode, 0);
  assert.equal(result.stages[1].name, "b");
  assert.equal(result.stages[1].exitCode, 1);
});

test("createJob rejects jobId that exists in SQLite but has no directory (legacy import collision)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-collision-"));
  // 先建一个 job，让它在 SQLite 里有记录
  const first = await createJob({
    workspace,
    task: "原始",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "collide",
  });
  assert.ok(await loadPersistedState(workspace, "collide"));
  // 模拟用户手清目录但 SQLite 记录仍在
  const { rmSync } = await import("node:fs");
  rmSync(first.directory, { recursive: true, force: true });
  assert.equal(existsSync(first.directory), false);
  // 同 jobId 建新 job 应拒绝，而非静默覆盖
  await assert.rejects(
    () =>
      createJob({
        workspace,
        task: "覆盖",
        review: false,
        isolated: false,
        permissionMode: "auto",
        maxTurns: 5,
        jobId: "collide",
      }),
    /任务已存在（SQLite 有记录但目录缺失）/,
  );
  // 确认未覆盖：旧 state 仍在（虽然目录没了，SQLite 记录未被新 createJob 改动）
  const stillThere = await loadPersistedState<{ task?: string }>(
    workspace,
    "collide",
  );
  assert.ok(stillThere, "SQLite record should remain untouched");
});

test("retryQueueJob produces no duplicate entries for the same jobId", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ maxConcurrent: 1 }),
    "utf8",
  );
  await pauseQueue(workspace);
  const job = await createJob({
    workspace,
    task: "重试无重复",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "no-dup",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_EXIT_SEQUENCE = "1";
  await startBackground(workspace, job.jobId);
  await resumeQueue(workspace);
  const failedDeadline = Date.now() + 20_000;
  while (
    Date.now() < failedDeadline &&
    (await loadState(workspace, job.jobId)).status !== "failed"
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await loadState(workspace, job.jobId)).status, "failed");
  process.env.FAKE_EXIT_SEQUENCE = "0";
  const retry = await retryQueueJob(workspace, job.jobId);
  assert.equal(retry.status, "queued");
  // 该 jobId 的 queued/running entry 必须恰好 1 个（无老 entry 并存）
  const active = (await listQueue(workspace)).entries.filter(
    (e) => e.jobId === job.jobId && ["queued", "running"].includes(e.status),
  );
  assert.equal(
    active.length,
    1,
    "should have exactly one active entry after retry",
  );
});
