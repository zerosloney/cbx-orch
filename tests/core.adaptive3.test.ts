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

test("NextAction parser rejects unknown fields, illegal combinations, and empty content", () => {
  assert.throws(
    () => parseNextAction({ action: "done", reason: "extra" }),
    /不支持字段/,
  );
  assert.throws(() => parseNextAction({ action: "execute" }), /stage/);
  assert.throws(
    () => parseNextAction({ action: "ask", questions: [] }),
    /1 到 20/,
  );
  assert.throws(
    () => parseNextAction({ action: "blocked", reason: " " }),
    /非空字符串/,
  );
});

test("adaptive maxRounds persists across foreground continuation", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_MANAGER_ACTIONS = "ask,execute,done";
  const job = await createAdaptiveJob(workspace, "adaptive-round-recovery", 2);
  process.env.FAKE_JOB_DIR = job.directory;
  const first = await executeJob(workspace, job.jobId);
  assert.equal(first.phase, "adaptive_ask");
  assert.equal(first.adaptiveRound, 1);
  const resumed = await executeJob(workspace, job.jobId, "answer");
  assert.equal(resumed.status, "needs_fix");
  assert.equal(resumed.phase, "adaptive_max_rounds");
  assert.equal(resumed.adaptiveRound, 2);
  assert.equal((resumed.stages as unknown[]).length, 1);
  const exhausted = await executeJob(workspace, job.jobId, "retry");
  assert.equal(exhausted.adaptiveRound, 2);
  assert.equal(exhausted.phase, "adaptive_max_rounds");
  assert.equal((exhausted.humanGate as { status: string }).status, "waiting");
  const completed = await executeJob(
    workspace,
    job.jobId,
    "one more round",
    undefined,
    1,
  );
  assert.equal(completed.status, "done");
  assert.equal(completed.adaptiveRound, 3);
});

test("isolated adaptive execute then ask preserves its worktree through continuation and delivery", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  process.env.FAKE_MANAGER_ACTIONS = "execute,ask,done";
  process.env.FAKE_REQUIRE_CHANGE_ON_DONE = "1";
  const job = await createJob({
    workspace,
    task: "isolated adaptive recovery",
    taskContract: {
      goal: "adaptive goal",
      acceptanceCriteria: ["adaptive criterion"],
    },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    adaptive: { enabled: true, maxRounds: 4 },
    jobId: "adaptive-isolated-recovery",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const paused = await executeJob(workspace, job.jobId);
  assert.equal(paused.phase, "adaptive_ask");
  const worktree = JSON.parse(
    await readFile(path.join(job.directory, "worktree.json"), "utf8"),
  ) as { path: string };
  assert.equal(existsSync(worktree.path), true);
  assert.equal(existsSync(path.join(worktree.path, "fake-change.txt")), true);
  assert.notEqual(paused.worktreeCleaned, true);

  const completed = await executeJob(workspace, job.jobId, "continue");
  assert.equal(completed.status, "done");
  assert.equal(existsSync(worktree.path), false);
  assert.match(
    await readFile(path.join(job.directory, "complete.patch"), "utf8"),
    /fake-change\.txt/,
  );
  const result = JSON.parse(
    await readArtifact(workspace, job.jobId, "result.json"),
  );
  assert.ok(result.changedFiles.includes("fake-change.txt"));
});

test("isolated adaptive maxRounds pause preserves its worktree", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  process.env.FAKE_MANAGER_ACTIONS = "execute";
  const job = await createJob({
    workspace,
    task: "isolated adaptive max rounds",
    taskContract: {
      goal: "adaptive goal",
      acceptanceCriteria: ["adaptive criterion"],
    },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    adaptive: { enabled: true, maxRounds: 1 },
    jobId: "adaptive-isolated-max-rounds",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const paused = await executeJob(workspace, job.jobId);
  assert.equal(paused.status, "needs_fix");
  assert.equal(paused.phase, "adaptive_max_rounds");
  const worktree = JSON.parse(
    await readFile(path.join(job.directory, "worktree.json"), "utf8"),
  ) as { path: string };
  assert.equal(existsSync(worktree.path), true);
  assert.equal(existsSync(path.join(worktree.path, "fake-change.txt")), true);
  assert.notEqual(paused.worktreeCleaned, true);
});
