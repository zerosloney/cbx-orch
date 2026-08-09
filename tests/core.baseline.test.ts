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

test("the same terminal failure opens a Human Gate only at the third occurrence", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_EXIT_SEQUENCE = "1";
  const job = await createJob({
    workspace,
    task: "repeat failure",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "repeated-failure",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const first = await executeJob(workspace, job.jobId);
  const second = await executeJob(workspace, job.jobId);
  assert.equal(first.status, "failed");
  assert.equal(second.status, "failed");
  assert.equal(first.humanGate, undefined);
  assert.equal(second.humanGate, undefined);
  const third = await executeJob(workspace, job.jobId);
  assert.equal(third.status, "needs_fix");
  assert.equal(third.phase, "repeated_failure");
  assert.deepEqual(
    {
      reason: (third.humanGate as { reason: string }).reason,
      status: (third.humanGate as { status: string }).status,
    },
    { reason: "repeated_failure", status: "waiting" },
  );
  assert.equal((third.failureTracker as { count: number }).count, 3);
});

test("background approval gate finishes its queue entry without spawning another worker", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ maxConcurrent: 1 }),
    "utf8",
  );
  const job = await createJob({
    workspace,
    task: "后台批准",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    approvalBeforeRun: true,
    jobId: "background-approval",
  });
  await startBackground(workspace, job.jobId);

  const deadline = Date.now() + 30_000;
  while (
    Date.now() < deadline &&
    (await loadState(workspace, job.jobId)).status !== "awaiting_approval"
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const entry = (await listQueue(workspace)).entries.find(
    (item) => item.jobId === job.jobId,
  );
  assert.equal(
    (await loadState(workspace, job.jobId)).status,
    "awaiting_approval",
  );
  assert.equal(entry?.status, "awaiting_approval");
  assert.equal(entry?.pid, undefined);

  const { dispatchQueue } = await import("../src/core.js");
  await dispatchQueue(workspace);
  await dispatchQueue(workspace);
  const after = (await listQueue(workspace)).entries.filter(
    (item) => item.jobId === job.jobId,
  );
  assert.equal(after.length, 1);
  assert.equal(after[0].status, "awaiting_approval");
  assert.equal(after[0].pid, undefined);
});

test("persistent queue respects maxConcurrent", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ maxConcurrent: 1 }),
    "utf8",
  );
  process.env.FAKE_SLEEP_MS = "350";
  const jobs = [];
  for (const id of ["queue-1", "queue-2", "queue-3"]) {
    const job = await createJob({
      workspace,
      task: id,
      review: false,
      isolated: false,
      permissionMode: "auto",
      maxTurns: 10,
      timeoutMs: 3_000,
      maxRetries: 0,
      jobId: id,
    });
    process.env.FAKE_JOB_DIR = job.directory;
    jobs.push(job);
    await startBackground(workspace, id);
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(
    (await listQueue(workspace)).entries.filter(
      (entry) => entry.status === "running",
    ).length <= 1,
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(
      jobs.map((job) => loadState(workspace, job.jobId)),
    );
    if (states.every((state) => state.status === "done")) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail("队列任务未在超时时间内全部完成");
});

test("queue pause/resume and retry recover failed work", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ maxConcurrent: 1 }),
    "utf8",
  );
  await pauseQueue(workspace);
  const job = await createJob({
    workspace,
    task: "重排",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "requeue",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_EXIT_SEQUENCE = "1";
  await startBackground(workspace, job.jobId, "", 5);
  assert.equal(
    (await listQueue(workspace)).entries.find(
      (entry) => entry.jobId === job.jobId,
    )?.status,
    "queued",
  );
  await resumeQueue(workspace);
  const failedDeadline = Date.now() + 30_000;
  while (
    Date.now() < failedDeadline &&
    (await loadState(workspace, job.jobId)).status !== "failed"
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await loadState(workspace, job.jobId)).status, "failed");
  process.env.FAKE_EXIT_SEQUENCE = "0";
  const retry = await retryQueueJob(workspace, job.jobId, 10);
  assert.equal(retry.priority, 10);
  const doneDeadline = Date.now() + 30_000;
  while (
    Date.now() < doneDeadline &&
    (await loadState(workspace, job.jobId)).status !== "done"
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await loadState(workspace, job.jobId)).status, "done");
});

test("isolated auto-branch and auto-commit produce a Git commit", async () => {
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
    task: "自动提交",
    review: false,
    isolated: true,
    autoBranch: true,
    autoCommit: true,
    commitMessage: "test: cbx commit",
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "commit",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.match(String(state.gitCommit), /^[0-9a-f]{7,}$/);
  assert.equal(
    spawnSync("git", ["show-ref", "--verify", "refs/heads/cbx/commit"], {
      cwd: workspace,
    }).status,
    0,
  );
});
