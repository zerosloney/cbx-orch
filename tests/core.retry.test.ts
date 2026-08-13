import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
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

test("autoCommit=true implicitly enables isolated instead of throwing", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-implicit-"));
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
  // autoCommit=true，isolated=false（等价 mergeConfig 默认）—— 不再抛错，隐含开启 isolated
  const job = await createJob({
    workspace,
    task: "隐含隔离",
    review: false,
    isolated: false,
    autoBranch: true,
    autoCommit: true,
    commitMessage: "test",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "implicit",
  });
  // context.json 落盘的 isolated 应为 true
  const context = JSON.parse(
    await readFile(path.join(job.directory, "context.json"), "utf8"),
  ) as { isolated: boolean };
  assert.equal(context.isolated, true);
});

test("ESM executor plugin can replace the builtin CLI", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-"));
  const pluginSrc = path.resolve(process.cwd(), "plugins", "example-executor.mjs");
  const plugin = path.join(workspace, "my-plugin.mjs");
  await copyFile(pluginSrc, plugin);
  const job = await createJob({
    workspace,
    task: "插件执行",
    review: false,
    isolated: false,
    executor: plugin,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "plugin",
  });
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  const events = await readFile(
    path.join(job.directory, "events.ndjson"),
    "utf8",
  );
  assert.match(events, /plugin_finished/);
  assert.match(events, /"event":"executor_metadata","source":"plugin"/);
  assert.match(events, /"sha256":"[a-f0-9]{64}"/);
});

test("registry resolves codebuddy/cbc/opencode/omp/oh-my-pi/cline/qwen", () => {
  assert.equal(resolveExecutor("codebuddy")?.name, "codebuddy");
  assert.equal(resolveExecutor("cbc")?.name, "codebuddy");
  assert.equal(resolveExecutor("opencode")?.name, "opencode");
  assert.equal(resolveExecutor("omp")?.name, "omp");
  assert.equal(resolveExecutor("oh-my-pi")?.name, "omp");
  assert.equal(resolveExecutor("cline")?.name, "cline");
  assert.equal(resolveExecutor("qwen")?.name, "qwen");
  assert.equal(resolveExecutor("unknown"), undefined);
  assert.equal(BUILTIN_EXECUTORS.length, 5);
});

test("codebuddy buildArgs uses print/stream-json/max-turns/permission-mode", () => {
  const args = resolveExecutor("codebuddy")!.buildArgs({
    prompt: "do it",
    permissionMode: "auto",
    maxTurns: 7,
  });
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "stream-json",
    "--max-turns",
    "7",
    "--permission-mode",
    "auto",
    "do it",
  ]);
});

test("opencode buildArgs uses run/format json and auto when permission is auto/dontAsk", () => {
  const spec = resolveExecutor("opencode")!;
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "auto", maxTurns: 5 }),
    ["run", "--format", "json", "fix", "--auto"],
  );
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "default", maxTurns: 5 }),
    ["run", "--format", "json", "fix"],
  );
});

test("omp buildArgs uses -p/mode json and ignores permissionMode (no documented flag)", () => {
  const spec = resolveExecutor("omp")!;
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "auto", maxTurns: 5 }),
    ["-p", "--mode", "json", "fix"],
  );
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "default", maxTurns: 5 }),
    ["-p", "--mode", "json", "fix"],
  );
});

test("cline buildArgs maps every permission mode without inheriting auto approval", () => {
  const spec = resolveExecutor("cline")!;
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "auto", maxTurns: 5 }),
    ["--json", "fix", "--auto-approve", "true"],
  );
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "dontAsk", maxTurns: 5 }),
    ["--json", "fix", "--auto-approve", "true"],
  );
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "default", maxTurns: 5 }),
    ["--json", "fix", "--auto-approve", "false"],
  );
  assert.deepEqual(
    spec.buildArgs({
      prompt: "fix",
      permissionMode: "acceptEdits",
      maxTurns: 5,
    }),
    ["--json", "fix", "--auto-approve", "false"],
  );
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "plan", maxTurns: 5 }),
    ["--json", "fix", "--auto-approve", "false", "--plan"],
  );
});

test("qwen buildArgs maps maxTurns to max-session-turns and permission mode to yolo/plan", () => {
  const spec = resolveExecutor("qwen")!;
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "auto", maxTurns: 5 }),
    ["--prompt", "fix", "--output-format", "stream-json", "--max-session-turns", "5", "--yolo"],
  );
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "dontAsk", maxTurns: 5 }),
    ["--prompt", "fix", "--output-format", "stream-json", "--max-session-turns", "5", "--yolo"],
  );
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "plan", maxTurns: 5 }),
    ["--prompt", "fix", "--output-format", "stream-json", "--max-session-turns", "5", "--approval-mode", "plan"],
  );
  assert.deepEqual(
    spec.buildArgs({ prompt: "fix", permissionMode: "default", maxTurns: 5 }),
    ["--prompt", "fix", "--output-format", "stream-json", "--max-session-turns", "5"],
  );
});

test("opencode executor runs end-to-end via CBX_OPENCODE fake binary", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_OPENCODE = script;
  const job = await createJob({
    workspace,
    task: "opencode 任务",
    testCommand: 'node -e "process.exit(0)"',
    review: false,
    isolated: false,
    executor: "opencode",
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "oc",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  // 调度走 opencode adapter：events.ndjson 记录的 command 应是 [opencode, run, --format, json, ...]
  const events = await readFile(
    path.join(job.directory, "events.ndjson"),
    "utf8",
  );
  assert.match(events, /"command":\[.+"run","--format","json"/);
  delete process.env.CBX_OPENCODE;
});

test("diff includes staged changes and excludes all .cbx artifacts", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], {
    cwd: workspace,
  });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  process.env.FAKE_STAGE_CHANGE = "1";
  const job = await createJob({
    workspace,
    task: "暂存改动",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "staged-diff",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
  const patchText = await readFile(
    path.join(job.directory, "complete.patch"),
    "utf8",
  );
  assert.match(patchText, /fake-change\.txt/);
  assert.doesNotMatch(
    patchText,
    /(?:^|[\\/])\.cbx(?:[\\/]|$)|state\.json|complete\.patch/m,
  );
  assert.ok(
    patchText.length < 20_000,
    `patch unexpectedly large: ${patchText.length}`,
  );
});

test("reviewer worktree changes fail review instead of being silently delivered", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], {
    cwd: workspace,
  });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  process.env.FAKE_REVIEW_MUTATE = "1";
  const job = await createJob({
    workspace,
    task: "安全审查",
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "review-mutation",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "review_failed");
  assert.equal(state.reviewerModifiedWorktree, true);
});

test("review failure keeps residual artifacts unverified", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_REVIEW_CONTENT =
    "VERDICT: FAIL\nexample text\nVERDICT: PASS\n";
  const job = await createJob({
    workspace,
    task: "严格 verdict",
    taskContract: { acceptanceCriteria: ["审查通过"] },
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "strict-verdict",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.reviewVerdict, "FAIL");
  const result = JSON.parse(
    await readArtifact(workspace, job.jobId, "result.json"),
  );
  assert.deepEqual(result.acceptanceEvidence[0].artifacts, [
    "complete.patch",
    "test.log",
    "review.md",
  ]);
  assert.equal(result.acceptanceEvidence[0].status, "unverified");
});
