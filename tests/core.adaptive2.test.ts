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

test("structured task contract performs a plan-only handshake and pauses on ambiguity", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_BLOCKING_QUESTION = "是否允许修改公共 API？";
  const job = await createJob({
    workspace,
    task: "兼容目标",
    taskContract: { goal: "明确目标", acceptanceCriteria: ["保持 API 兼容"] },
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 1,
    jobId: "handshake",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "awaiting_clarification");
  assert.equal(state.attempt, 0, "语义歧义不应消耗实现重试");
  assert.equal(existsSync(path.join(workspace, "fake-change.txt")), false);
  assert.deepEqual(
    JSON.parse(await readArtifact(workspace, job.jobId, "understanding.json"))
      .blockingQuestions,
    ["是否允许修改公共 API？"],
  );
  assert.equal(
    (state.humanGate as { reason: string; status: string }).reason,
    "needs_input",
  );
  assert.equal(
    JSON.parse(await readArtifact(workspace, job.jobId, "result.json"))
      .acceptanceEvidence[0].status,
    "unverified",
  );
});

test("reviewExecutor can independently override the implementation executor", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_OPENCODE = script;
  const job = await createJob({
    workspace,
    task: "独立审查",
    review: true,
    isolated: false,
    executor: "codebuddy",
    reviewExecutor: "opencode",
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "review-executor",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  try {
    assert.equal((await executeJob(workspace, job.jobId)).status, "done");
  } finally {
    delete process.env.CBX_OPENCODE;
  }
  const events = await readFile(
    path.join(job.directory, "events.ndjson"),
    "utf8",
  );
  assert.match(events, /"name":"codebuddy"/);
  assert.match(events, /"name":"opencode"/);
  assert.equal(
    existsSync(path.join(job.directory, "audit.json")),
    false,
    "non-contract review keeps the legacy flow",
  );
});

test("staged tasks inherit the top-level reviewExecutor", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_OPENCODE = script;
  const job = await createJob({
    workspace,
    task: "阶段审查",
    review: true,
    isolated: false,
    executor: "codebuddy",
    reviewExecutor: "opencode",
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "staged-review-executor",
    taskContract: {
      stages: [{ name: "implement", executor: "codebuddy", task: "实现" }],
    },
  });
  process.env.FAKE_JOB_DIR = job.directory;
  try {
    assert.equal((await executeJob(workspace, job.jobId)).status, "done");
  } finally {
    delete process.env.CBX_OPENCODE;
  }
  const events = (
    await readFile(path.join(job.directory, "events.ndjson"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events
      .filter((event) => event.event === "executor_metadata")
      .map((event) => event.name),
    ["codebuddy", "codebuddy", "opencode"],
  );
});

test("staged tasks use the first stage executor for the context handshake", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_CODEBUDDY = path.join(workspace, "missing-codebuddy.mjs");
  process.env.CBX_OPENCODE = script;
  const job = await createJob({
    workspace,
    task: "仅阶段执行器",
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "stage-handshake-executor",
    taskContract: {
      acceptanceCriteria: ["旧流程验收"],
      stages: [{ name: "implement", executor: "opencode", task: "实现" }],
    },
  });
  process.env.FAKE_JOB_DIR = job.directory;
  try {
    assert.equal((await executeJob(workspace, job.jobId)).status, "done");
  } finally {
    process.env.CBX_CODEBUDDY = script;
    delete process.env.CBX_OPENCODE;
  }
  const events = (
    await readFile(path.join(job.directory, "events.ndjson"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events
      .filter((event) => event.event === "executor_metadata")
      .map((event) => event.name),
    ["opencode", "opencode"],
  );
  assert.equal(
    existsSync(path.join(job.directory, "audit.json")),
    false,
    "review=false keeps the legacy contract flow",
  );
  assert.equal(
    JSON.parse(await readArtifact(workspace, job.jobId, "result.json"))
      .acceptanceEvidence[0].status,
    "evidence_available",
  );
});

test("git baseline is recorded and isolated execution stays pinned when HEAD drifts", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], {
    cwd: workspace,
  });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "base"], { cwd: workspace });
  const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  }).stdout.trim();
  const job = await createJob({
    workspace,
    task: "固定基线",
    review: false,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "pinned",
  });
  await writeFile(path.join(workspace, "README.md"), "later\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "later"], { cwd: workspace });
  process.env.FAKE_JOB_DIR = job.directory;
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
  const result = JSON.parse(
    await readArtifact(workspace, job.jobId, "result.json"),
  );
  assert.equal(result.baseCommit, baseCommit);
  assert.equal(result.baselineDrift, true);
});

test("non-isolated baseline drift pauses without blind retry", async () => {
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
    task: "检测漂移",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 2,
    jobId: "drift",
  });
  await writeFile(path.join(workspace, "README.md"), "later\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "later"], { cwd: workspace });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "baseline_drift");
  assert.equal(state.attempt, 0);
});

test("isolated execution pauses when the recorded baseline contains uncommitted work", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], {
    cwd: workspace,
  });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "base"], { cwd: workspace });
  await writeFile(path.join(workspace, "draft.txt"), "uncommitted\n", "utf8");
  const job = await createJob({
    workspace,
    task: "不得丢草稿",
    review: false,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 2,
    jobId: "dirty-isolated",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "dirty_baseline");
  assert.equal(state.attempt, 0);
  assert.equal(existsSync(path.join(job.directory, "worktree.json")), false);
});
