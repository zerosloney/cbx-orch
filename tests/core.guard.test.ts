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

test("semantic review failures pause without automatic implementation retries", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_REVIEW_CONTENT =
    "VERDICT: FAIL\nCLASSIFICATION: SEMANTIC\n需要产品决策\n";
  const job = await createJob({
    workspace,
    task: "语义冲突",
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 2,
    jobId: "semantic-review",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "awaiting_clarification");
  assert.equal(state.attempt, 1);
  assert.equal(
    (state.humanGate as { reason: string }).reason,
    "semantic_conflict",
  );
});

test("corrupt queue is surfaced and dead queue locks are recovered", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-corrupt-"));
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(
    path.join(workspace, ".cbx", "queue.json"),
    "{broken",
    "utf8",
  );
  await assert.rejects(() => listQueue(workspace), /JSON/);
  await writeFile(
    path.join(workspace, ".cbx", "queue.json"),
    JSON.stringify({
      maxConcurrent: 2,
      paused: false,
      entries: [],
      updatedAt: new Date().toISOString(),
    }),
    "utf8",
  );
  await writeFile(
    path.join(workspace, ".cbx", "queue.lock"),
    JSON.stringify({
      pid: 2_147_483_647,
      acquiredAt: new Date().toISOString(),
      token: "dead",
    }),
    "utf8",
  );
  assert.equal((await pauseQueue(workspace)).paused, true);
});

test("a live queue lock is not reclaimed", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-live-lock-"));
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(
    path.join(workspace, ".cbx", "queue.lock"),
    JSON.stringify({
      pid: process.pid,
      acquiredAt: "2000-01-01T00:00:00.000Z",
      token: "live",
    }),
    "utf8",
  );
  await assert.rejects(
    () => pauseQueue(workspace),
    /队列正在被另一个调度器更新/,
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(workspace, ".cbx", "queue.lock"), "utf8"),
    ).token,
    "live",
  );
});

test("stale job lock and a dead running queue entry recover after a crash", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "崩溃恢复",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "crash-recovery",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  await writeFile(
    path.join(job.directory, "run.lock"),
    JSON.stringify({
      pid: 2_147_483_647,
      acquiredAt: new Date().toISOString(),
      token: "dead",
    }),
    "utf8",
  );
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(
    path.join(workspace, ".cbx", "queue.json"),
    JSON.stringify({
      maxConcurrent: 1,
      paused: true,
      updatedAt: new Date().toISOString(),
      entries: [
        {
          queueId: "dead-worker",
          jobId: job.jobId,
          workspace,
          extra: "",
          status: "running",
          createdAt: new Date().toISOString(),
          pid: 2_147_483_647,
          priority: 0,
        },
      ],
    }),
    "utf8",
  );
  const recovered = await (
    await import("../src/core.js")
  ).dispatchQueue(workspace);
  assert.equal(recovered.entries[0].status, "done");
});

test("context snapshot is persisted and required by implementation and review prompts", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "保留父会话上下文",
    contextSnapshot: "计划：修改核心流程\n约束：不要新增依赖",
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "context-snapshot",
  });
  const promptFile = path.join(workspace, "prompts.txt");
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_PROMPT_FILE = promptFile;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(
    await readFile(path.join(job.directory, "context-snapshot.md"), "utf8"),
    "计划：修改核心流程\n约束：不要新增依赖",
  );
  const prompts = await readFile(promptFile, "utf8");
  // prompt 引用 context pack，不直接引用 snapshot 路径或裸 context.json
  assert.match(prompts, /executor-context\.json/);
  assert.match(prompts, /auditor-context\.json/);
  assert.doesNotMatch(prompts, /[\\/]context\.json\b/);
  const snapshotPath = path.join(job.directory, "context-snapshot.md");
  const escaped = snapshotPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.doesNotMatch(prompts, new RegExp(escaped));
  // executor 和 auditor context pack 的 artifact 引用必须包含 snapshot 的绝对路径和 SHA
  for (const role of ["executor", "auditor"] as const) {
    const pack = JSON.parse(
      await readArtifact(workspace, job.jobId, `${role}-context.json`),
    );
    const snapshotRef = pack.artifacts.find(
      (a: { name: string }) => a.name === "context-snapshot.md",
    );
    assert.ok(
      snapshotRef,
      `${role} context pack 应包含 context-snapshot.md 的 artifact 引用`,
    );
    assert.equal(snapshotRef.path, snapshotPath);
    assert.match(snapshotRef.sha256, /^[a-f0-9]{64}$/);
  }
});

test("empty context snapshot is not persisted and omitted from prompts", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "无快照任务",
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "no-snapshot",
  });
  assert.equal(
    existsSync(path.join(job.directory, "context-snapshot.md")),
    false,
  );
  const promptFile = path.join(workspace, "prompts.txt");
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_PROMPT_FILE = promptFile;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  const prompts = await readFile(promptFile, "utf8");
  assert.equal(prompts.includes("context-snapshot.md"), false);
});

test("cbx_continue overwrites context snapshot via startBackground with redaction", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-continue-snapshot-"),
  );
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      governance: {
        redactFields: ["token"],
        redactPatterns: ["sk-[a-zA-Z0-9]{6,}"],
      },
    }),
    "utf8",
  );
  const job = await createJob({
    workspace,
    task: "待 continue",
    contextSnapshot: "旧快照",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 1,
    jobId: "continue-snap",
  });
  assert.equal(
    await readFile(path.join(job.directory, "context-snapshot.md"), "utf8"),
    "旧快照",
  );
  await startBackground(
    workspace,
    job.jobId,
    "修复",
    0,
    "新计划\nToken: leak\nkey sk-abcdef123456",
  );
  assert.equal(
    await readFile(path.join(job.directory, "context-snapshot.md"), "utf8"),
    "新计划\nToken: [REDACTED]\nkey [REDACTED]",
  );
});
