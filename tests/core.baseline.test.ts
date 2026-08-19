import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { processAlive } from "../src/lock.js";
import {
  setupFake,
  createJob,
  executeJob,
  listQueue,
  loadState,
  pauseQueue,
  resumeQueue,
  retryQueueJob,
  startBackground,
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

  const deadline = Date.now() + 60_000;
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
  // 60s 上限：全量测试并行负载下 worker 调度 + fake agent 启动可能远超 30s。
  const deadline = Date.now() + 60_000;
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
  // 60s 上限：全量测试并行负载下 worker 调度 + fake agent 启动可能远超 30s。
  const failedDeadline = Date.now() + 60_000;
  while (
    Date.now() < failedDeadline &&
    (await loadState(workspace, job.jobId)).status !== "failed"
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await loadState(workspace, job.jobId)).status, "failed");
  // retry 前等首个 worker 进程真正退出：worker 完成任务后会在自身进程内 dispatchQueue
  // 接力下一个 queued entry（finishQueueEntry 特性）。若该接力 dispatch 在 retry 事务提交
  // 后才读队列快照，会以旧 env 快照抢先 spawn 执行进程，retry 后仍读到 FAKE_EXIT_SEQUENCE=1。
  // 10s 上限兜底 pid 复用导致的 processAlive 误报。
  const workerPid = Number(
    await readFile(path.join(job.directory, "pid"), "utf8").catch(() => ""),
  );
  const workerExitDeadline = Date.now() + 10_000;
  while (
    Number.isSafeInteger(workerPid) &&
    workerPid > 0 &&
    Date.now() < workerExitDeadline &&
    processAlive(workerPid)
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  process.env.FAKE_EXIT_SEQUENCE = "0";
  const retry = await retryQueueJob(workspace, job.jobId, 10);
  assert.equal(retry.priority, 10);
  const doneDeadline = Date.now() + 60_000;
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
