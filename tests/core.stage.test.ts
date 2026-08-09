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

test("cancelling a queued job prevents it from running after queue resume", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "排队取消",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "queued-cancel",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  await pauseQueue(workspace);
  await startBackground(workspace, job.jobId);
  assert.equal(
    (await listQueue(workspace)).entries.find(
      (entry) => entry.jobId === job.jobId,
    )?.status,
    "queued",
  );
  await cancelJob(workspace, job.jobId);
  assert.equal((await loadState(workspace, job.jobId)).status, "cancelled");
  assert.equal(
    (await listQueue(workspace)).entries.find(
      (entry) => entry.jobId === job.jobId,
    )?.status,
    "cancelled",
  );
  await resumeQueue(workspace);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal((await loadState(workspace, job.jobId)).status, "cancelled");
  assert.equal(existsSync(path.join(workspace, "fake-change.txt")), false);
});

test("cancelling a non-running job never trusts a stale pid artifact", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "陈旧 PID",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "stale-pid",
  });
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { windowsHide: true },
  );
  try {
    assert.ok(unrelated.pid);
    await writeFile(
      path.join(job.directory, "pid"),
      String(unrelated.pid),
      "utf8",
    );
    assert.equal((await cancelJob(workspace, job.jobId)).status, "cancelled");
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  } finally {
    unrelated.kill("SIGKILL");
  }
});

test("executeJob does not start a cancelled job and continue clears the marker", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "取消后不启动",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "no-restart",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  await cancelJob(workspace, job.jobId);
  assert.equal((await executeJob(workspace, job.jobId)).status, "cancelled");
  assert.equal(existsSync(path.join(workspace, "fake-change.txt")), false);
  assert.equal(existsSync(path.join(job.directory, "cancel.requested")), true);
  // 显式重跑入口（continue/startBackground）在入队时清除取消标记，任务可以再次执行。
  await startBackground(workspace, job.jobId, "重跑");
  assert.equal(existsSync(path.join(job.directory, "cancel.requested")), false);
  const deadline = Date.now() + 20_000;
  while (
    Date.now() < deadline &&
    (await loadState(workspace, job.jobId)).status !== "done"
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await loadState(workspace, job.jobId)).status, "done");
});

test("stage handback artifacts are readable via readArtifact", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-stage-read-"));
  const job = await createJob({
    workspace,
    task: "阶段产物",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "stage-read",
    taskContract: {
      stages: [{ name: "s1", executor: "codebuddy", task: "t1" }],
    },
  });
  await writeFile(
    path.join(job.directory, "stage-0-s1-handback.md"),
    "stage handback",
    "utf8",
  );
  assert.equal(
    await readArtifact(workspace, job.jobId, "stage-0-s1-handback.md"),
    "stage handback",
  );
  await assert.rejects(
    () => readArtifact(workspace, job.jobId, "stage-0-../evil-handback.md"),
    /不允许读取/,
  );
});

test("smart retry separates execution retries from fix retries", async () => {
  const { workspace } = await setupFake();
  const counter = path.join(workspace, "counter.txt");
  process.env.FAKE_COUNTER_FILE = counter;
  process.env.FAKE_EXIT_SEQUENCE = "1,1,0";
  const job = await createJob({
    workspace,
    task: "智能重试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 2,
    jobId: "smart-retry",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.attempt, 3);
});

test("dependency guard blocks unauthorized package.json changes", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, "package.json"),
    '{"name":"test"}',
    "utf8",
  );
  const job = await createJob({
    workspace,
    task: "依赖守卫",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    dependencyGuard: true,
    jobId: "dep-guard",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_MUTATE_DEP = "1";
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "dependency_guard");
  assert.match(String(state.error), /未经授权修改了依赖文件/);
});

test("dependency guard allows unchanged package.json", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, "package.json"),
    '{"name":"test"}',
    "utf8",
  );
  const job = await createJob({
    workspace,
    task: "依赖守卫通过",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    dependencyGuard: true,
    jobId: "dep-guard-ok",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
});

test("approval gate pauses and resumes a task", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "批准",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    approvalBeforeRun: true,
    jobId: "approval",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const waiting = await executeJob(workspace, job.jobId);
  assert.equal(waiting.status, "awaiting_approval");
  assert.deepEqual(
    {
      reason: (waiting.humanGate as { reason: string }).reason,
      status: (waiting.humanGate as { status: string }).status,
    },
    { reason: "before_run", status: "waiting" },
  );
  const approved = await approveJob(workspace, job.jobId);
  assert.equal((approved.humanGate as { status: string }).status, "resolved");
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
});

test("completion approval preserves verified isolated work and completes without rerunning stages", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await createJob({
    workspace,
    task: "approve completion",
    taskContract: { acceptanceCriteria: ["verified"] },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    approvalBeforeComplete: true,
    jobId: "completion-approval",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const waiting = await executeJob(workspace, job.jobId);
  assert.equal(waiting.status, "awaiting_approval");
  assert.equal(waiting.phase, "before_complete");
  assert.deepEqual(
    {
      reason: (waiting.humanGate as { reason: string }).reason,
      status: (waiting.humanGate as { status: string }).status,
    },
    { reason: "completion", status: "waiting" },
  );
  const worktree = JSON.parse(
    await readFile(path.join(job.directory, "worktree.json"), "utf8"),
  ) as { path: string };
  assert.equal(existsSync(path.join(worktree.path, "fake-change.txt")), true);
  const attempt = waiting.attempt;

  const completed = await approveJob(workspace, job.jobId);
  assert.equal(completed.status, "done");
  assert.equal(completed.attempt, attempt, "完成审批不得重跑已验证 stage");
  assert.equal((completed.humanGate as { status: string }).status, "resolved");
  assert.equal(existsSync(worktree.path), false);
  assert.match(
    await readFile(path.join(job.directory, "complete.patch"), "utf8"),
    /fake-change\.txt/,
  );
  await assert.rejects(() => approveJob(workspace, job.jobId), /不需要批准/);
});

test("completion approval rejects stale worktree evidence and keeps work for revalidation", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await createJob({
    workspace,
    task: "stale completion",
    taskContract: { acceptanceCriteria: ["verified"] },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    approvalBeforeComplete: true,
    jobId: "completion-stale",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  assert.equal(
    (await executeJob(workspace, job.jobId)).phase,
    "before_complete",
  );
  const worktree = JSON.parse(
    await readFile(path.join(job.directory, "worktree.json"), "utf8"),
  ) as { path: string };
  await writeFile(
    path.join(worktree.path, "fake-change.txt"),
    "changed after review\n",
    "utf8",
  );
  const stale = await approveJob(workspace, job.jobId);
  assert.equal(stale.status, "needs_fix");
  assert.equal(stale.phase, "completion_evidence_stale");
  assert.equal(existsSync(worktree.path), true);
  await assert.rejects(() => approveJob(workspace, job.jobId), /不需要批准/);
});
