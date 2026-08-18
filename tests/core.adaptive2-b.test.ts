import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  setupFake,
  cancelJob,
  createJob,
  executeJob,
  loadState,
  readArtifact,
  startBackground,
} from "./helpers.js";

test("non-isolated execution compares dirty content fingerprint", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], {
    cwd: workspace,
  });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "base"], { cwd: workspace });
  await writeFile(path.join(workspace, "draft.txt"), "version one\n", "utf8");
  const unchanged = await createJob({
    workspace,
    task: "使用相同草稿",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "dirty-same",
  });
  process.env.FAKE_JOB_DIR = unchanged.directory;
  assert.equal((await executeJob(workspace, unchanged.jobId)).status, "done");

  await writeFile(path.join(workspace, "fake-change.txt"), "changed\n", "utf8");
  const changed = await createJob({
    workspace,
    task: "检测草稿变化",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "dirty-changed",
  });
  await writeFile(path.join(workspace, "draft.txt"), "version two\n", "utf8");
  process.env.FAKE_JOB_DIR = changed.directory;
  const state = await executeJob(workspace, changed.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "dirty_baseline");
  assert.equal(state.dirtyBaselineDrift, true);
});

test("refreshBaseline clears stale drift flags in state and result", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], {
    cwd: workspace,
  });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "base"], { cwd: workspace });
  const job = await createJob({
    workspace,
    task: "刷新基线",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "refresh-drift",
  });
  await writeFile(path.join(workspace, "README.md"), "later\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "later"], { cwd: workspace });
  assert.equal((await executeJob(workspace, job.jobId)).baselineDrift, true);
  process.env.FAKE_JOB_DIR = job.directory;
  await startBackground(
    workspace,
    job.jobId,
    "使用新基线",
    0,
    "已确认新 HEAD",
    true,
  );
  const refreshed = await loadState(workspace, job.jobId);
  assert.equal(refreshed.baselineDrift, false);
  assert.equal(refreshed.dirtyBaselineDrift, false);
  assert.equal(refreshed.currentCommit, null);
  assert.equal(
    JSON.parse(await readArtifact(workspace, job.jobId, "result.json"))
      .baselineDrift,
    false,
  );
});

test("failed agent attempt is retried", async () => {
  const { workspace } = await setupFake();
  const counter = path.join(workspace, "counter.txt");
  process.env.FAKE_COUNTER_FILE = counter;
  process.env.FAKE_EXIT_SEQUENCE = "1,0";
  const job = await createJob({
    workspace,
    task: "重试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 1,
    jobId: "retry",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.attempt, 2);
});

test("agent timeout becomes a terminal failure", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_SLEEP_MS = "500";
  const job = await createJob({
    workspace,
    task: "超时",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 100,
    maxRetries: 0,
    jobId: "timeout",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "failed");
  assert.equal(state.timedOut, true);
});

test("concurrent execution of one job is rejected by the lock", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_SLEEP_MS = "250";
  const job = await createJob({
    workspace,
    task: "加锁",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "lock",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const first = executeJob(workspace, job.jobId);
  // 等待首个执行进入锁阶段。负载高时 first 可能仍在 Human Gate 更新阶段，
  // 因此 second 可能撞上任意一个 withJobLock（任务锁或 Human Gate 锁）。
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = executeJob(workspace, job.jobId);
  const results = await Promise.allSettled([first, second]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.match(
    String(results.find((result) => result.status === "rejected")?.reason),
    /任务正在运行中|Human Gate 正在更新/,
  );
});

test("isolated worktree is cleaned after success", async () => {
  const { workspace } = await setupFake();
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
    task: "隔离执行",
    review: false,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "worktree",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.worktreeCleaned, true);
  const record = JSON.parse(
    await readFile(path.join(job.directory, "worktree.json"), "utf8"),
  ) as { path: string };
  assert.equal(existsSync(record.path), false);
  // 容器目录（.<repo>.cbx-worktrees/）在最后一个 job 清理后也应删除，避免孤儿
  const container = path.dirname(record.path);
  assert.equal(existsSync(container), false);
});

test("background cancellation terminates the task", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_SLEEP_MS = "2_000";
  const job = await createJob({
    workspace,
    task: "取消",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "cancel",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  await startBackground(workspace, job.jobId);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const state = await cancelJob(workspace, job.jobId);
  assert.equal(state.status, "cancelled");
});
