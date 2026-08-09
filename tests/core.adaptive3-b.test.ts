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

test("adaptive done with approvalBeforeComplete stops at awaiting_approval without looping (P1-1)", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_MANAGER_ACTIONS = "execute,done";
  const job = await createJob({
    workspace,
    task: "approval before complete adaptive",
    taskContract: {
      goal: "adaptive goal",
      acceptanceCriteria: ["adaptive criterion"],
    },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    adaptive: { enabled: true, maxRounds: 4 },
    approvalBeforeComplete: true,
    jobId: "p1-1-approval-adaptive",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  // P1-1 回归：done 决策触发的完成审批门应停在 awaiting_approval/before_complete，
  // 而非被下一轮 Manager 调用覆盖为 running 或继续循环耗尽 maxRounds。
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.phase, "before_complete");
  assert.ok(
    Number(state.adaptiveRound) <= 4,
    `adaptiveRound should not exceed maxRounds, got ${state.adaptiveRound}`,
  );
});

test("stage dependsOn executes dependencies before dependents even if declared out of order (P1-4)", async () => {
  const { workspace } = await setupFake();
  // stages 声明逆序：dependent 在前，dependency 在后。拓扑层应保证 dependency 先执行。
  const job = await createJob({
    workspace,
    task: "dependency order test",
    taskContract: {
      goal: "ordered stages",
      acceptanceCriteria: ["c"],
      stages: [
        {
          name: "dependent",
          executor: "codebuddy",
          task: "depends on base",
          dependsOn: ["base"],
        },
        { name: "base", executor: "codebuddy", task: "the base stage" },
      ],
    },
    testCommand: 'node -e "process.exit(0)"',
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "p1-4-dep-order",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  const stages = state.stages as Array<{ name: string }>;
  assert.equal(stages.length, 2);
  // P1-4：base 应先于 dependent 执行（拓扑序），即使声明时 dependent 在前
  const events = await readFile(
    path.join(job.directory, "events.ndjson"),
    "utf8",
  );
  const startedOrder = events
    .split("\n")
    .filter((l) => l.includes("stage_started"))
    .map((l) => JSON.parse(l).stage);
  assert.deepEqual(
    startedOrder,
    ["base", "dependent"],
    `expected base before dependent, got ${startedOrder.join(", ")}`,
  );
});

test("stage failure propagates skipped to downstream dependsOn stages (P1-5)", async () => {
  const { workspace } = await setupFake();
  // base stage 的 review FAIL，fixRetries 耗尽后 terminal review_failed，downstream 应 skipped
  process.env.FAKE_REVIEW_VERDICT = "FAIL";
  const job = await createJob({
    workspace,
    task: "failure propagation test",
    taskContract: {
      goal: "fail and skip",
      acceptanceCriteria: ["c"],
      stages: [
        { name: "base", executor: "codebuddy", task: "will fail review" },
        {
          name: "downstream",
          executor: "codebuddy",
          task: "depends on base",
          dependsOn: ["base"],
        },
      ],
    },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "p1-5-fail-propagate",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  // base review 失败 → 任务进入失败类终态
  assert.ok(
    ["failed", "needs_fix", "review_failed"].includes(state.status),
    `expected failure terminal, got ${state.status}`,
  );
  const events = await readFile(
    path.join(job.directory, "events.ndjson"),
    "utf8",
  );
  // P1-5：downstream 应有 stage_skipped 事件（失败传播可达）
  assert.ok(
    events.includes("stage_skipped"),
    "downstream stage should be skipped due to base failure",
  );
  assert.ok(
    events.includes("downstream"),
    "skipped event should reference downstream stage",
  );
});

test("CLI adaptive flags persist opt-in settings", async () => {
  const { workspace } = await setupFake();
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("dist/src/cli.js"),
      "run",
      "--workspace",
      workspace,
      "--task",
      "cli adaptive",
      "--review",
      "--adaptive",
      "--adaptive-max-rounds",
      "1",
      "--manager-executor",
      "codebuddy",
      "--approval-before-complete",
    ],
    { encoding: "utf8", env: { ...process.env, FAKE_JOB_DIR: "" } },
  );
  assert.equal(result.status, 0, result.stderr);
  const jobId = JSON.parse(result.stdout).jobId as string;
  const directory = path.join(workspace, ".cbx", "jobs", jobId);
  const context = JSON.parse(
    await readFile(path.join(directory, "context.json"), "utf8"),
  );
  assert.deepEqual(context.adaptive, {
    enabled: true,
    maxRounds: 1,
    managerExecutor: "codebuddy",
  });
  assert.equal(context.approvalBeforeComplete, true);
  const invalidRounds = spawnSync(
    process.execPath,
    [
      path.resolve("dist/src/cli.js"),
      "continue",
      "missing",
      "--workspace",
      workspace,
      "--extra-rounds",
      "-1",
      "--foreground",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(invalidRounds.status, 0);
  assert.match(invalidRounds.stderr, /--extra-rounds 必须是 0 到 100/);
});
