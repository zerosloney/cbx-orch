import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { approveJob, cancelJob, createJob, executeJob, health, listJobs, listQueue, loadConfig, loadState, mergeConfig, pauseQueue, readArtifact, resumeQueue, retryQueueJob, serveQueue, startBackground } from "../src/core.js";
import { loadPersistedQueue, savePersistedStateAndQueue } from "../src/storage.js";
import { BUILTIN_EXECUTORS, resolveExecutor } from "../src/executors/builtin.js";

const fakeAgent = `
import { appendFile, mkdir, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? 0);
if (sleepMs) await new Promise(resolve => setTimeout(resolve, sleepMs));
const jobDir = process.env.FAKE_JOB_DIR;
const promptFile = process.env.FAKE_PROMPT_FILE;
if (promptFile) await appendFile(promptFile, prompt + "\\n---\\n");
if (jobDir) {
  await mkdir(jobDir, { recursive: true });
  if (prompt.includes("independent review")) {
    const verdict = process.env.FAKE_REVIEW_VERDICT ?? "PASS";
    await writeFile(jobDir + "/review.md", process.env.FAKE_REVIEW_CONTENT ?? ("VERDICT: " + verdict + "\\n"));
    if (process.env.FAKE_REVIEW_MUTATE === "1") await writeFile(process.cwd() + "/reviewer-change.txt", "untested reviewer change\\n");
  } else {
    await writeFile(jobDir + "/handback.md", "fake handback\\n");
    await writeFile(process.cwd() + "/fake-change.txt", "changed\\n");
    if (process.env.FAKE_STAGE_CHANGE === "1") (await import("node:child_process")).spawnSync("git", ["add", "fake-change.txt"], { cwd: process.cwd() });
  }
}
const sequence = (process.env.FAKE_EXIT_SEQUENCE ?? "0").split(",");
const counterFile = process.env.FAKE_COUNTER_FILE;
let index = 0;
if (counterFile) {
  try { index = Number(await (await import("node:fs/promises")).readFile(counterFile, "utf8")); } catch {}
  await writeFile(counterFile, String(index + 1));
}
process.exit(Number(sequence[Math.min(index, sequence.length - 1)] ?? 0));
`;

async function setupFake(): Promise<{ workspace: string; script: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-e2e-"));
  const script = path.join(workspace, "fake-codebuddy.mjs");
  await writeFile(script, fakeAgent, "utf8");
  process.env.CBX_CODEBUDDY = script;
  process.env.FAKE_JOB_DIR = "";
  process.env.FAKE_SLEEP_MS = "0";
  process.env.FAKE_EXIT_SEQUENCE = "0";
  process.env.FAKE_REVIEW_VERDICT = "PASS";
  delete process.env.FAKE_REVIEW_CONTENT;
  delete process.env.FAKE_REVIEW_MUTATE;
  delete process.env.FAKE_STAGE_CHANGE;
  delete process.env.FAKE_COUNTER_FILE;
  delete process.env.FAKE_PROMPT_FILE;
  return { workspace, script };
}

test("createJob persists task contract and state", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-"));
  const job = await createJob({ workspace, task: "实现功能", testCommand: "npm test", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, jobId: "test-job" });
  assert.equal(job.jobId, "test-job");
  assert.equal((await loadState(workspace, job.jobId)).status, "queued");
  assert.match(await readFile(path.join(job.directory, "request.md"), "utf8"), /实现功能/);
  assert.equal(existsSync(path.join(job.directory, "context-snapshot.md")), false);
});

test(".cbx.json provides defaults and tasks can be listed", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-config-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ testCommand: "npm test", review: true, isolated: true, maxRetries: 3, approval: { beforeRun: true } }), "utf8");
  const config = await loadConfig(workspace);
  const defaults = mergeConfig(config, {});
  assert.equal(defaults.review, true);
  assert.equal(defaults.approvalBeforeRun, true);
  await createJob({ workspace, task: "配置任务", review: defaults.review, isolated: defaults.isolated, permissionMode: defaults.permissionMode, maxTurns: defaults.maxTurns, timeoutMs: defaults.timeoutMs, maxRetries: defaults.maxRetries, approvalBeforeRun: defaults.approvalBeforeRun, jobId: "config-job" });
  assert.equal((await listJobs(workspace))[0].jobId, "config-job");
});

test("untrusted mode is rejected because a Git worktree is not an OS sandbox", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-untrusted-"));
  await assert.rejects(
    () => createJob({ workspace, task: "不可信任务", review: false, isolated: true, permissionMode: "auto", maxTurns: 5, trustMode: "untrusted" }),
    /未提供 OS 容器沙箱/,
  );
});

test("end-to-end success runs fake agent, test, and review", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
  const job = await createJob({ workspace, task: "实现功能", testCommand: "node -e \"process.exit(0)\"", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "success" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.reviewVerdict, "PASS");
  assert.equal((await readFile(path.join(job.directory, "handback.md"), "utf8")).trim(), "fake handback");
  const events = await readFile(path.join(job.directory, "events.ndjson"), "utf8");
  assert.ok(events.includes("process_finished"));
  assert.match(events, /"event":"executor_metadata","source":"builtin"/);
  assert.ok((await readFile(path.join(job.directory, "complete.patch"), "utf8")).includes("fake-change.txt"));
  assert.equal(JSON.parse(await readArtifact(workspace, job.jobId, "result.json")).status, "done");
});

test("failed agent attempt is retried", async () => {
  const { workspace } = await setupFake();
  const counter = path.join(workspace, "counter.txt");
  process.env.FAKE_COUNTER_FILE = counter;
  process.env.FAKE_EXIT_SEQUENCE = "1,0";
  const job = await createJob({ workspace, task: "重试", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 1, jobId: "retry" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.attempt, 2);
});

test("agent timeout becomes a terminal failure", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_SLEEP_MS = "500";
  const job = await createJob({ workspace, task: "超时", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 100, maxRetries: 0, jobId: "timeout" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "failed");
  assert.equal(state.timedOut, true);
});

test("concurrent execution of one job is rejected by the lock", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_SLEEP_MS = "250";
  const job = await createJob({ workspace, task: "加锁", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "lock" });
  process.env.FAKE_JOB_DIR = job.directory;
  const first = executeJob(workspace, job.jobId);
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = executeJob(workspace, job.jobId);
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.match(String(results.find(result => result.status === "rejected")?.reason), /任务正在运行/);
});

test("isolated worktree is cleaned after success", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
  const job = await createJob({ workspace, task: "隔离执行", review: false, isolated: true, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "worktree" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.worktreeCleaned, true);
  const record = JSON.parse(await readFile(path.join(job.directory, "worktree.json"), "utf8")) as { path: string };
  assert.equal(existsSync(record.path), false);
});

test("background cancellation terminates the task", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_SLEEP_MS = "2_000";
  const job = await createJob({ workspace, task: "取消", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 5_000, maxRetries: 0, jobId: "cancel" });
  process.env.FAKE_JOB_DIR = job.directory;
  await startBackground(workspace, job.jobId);
  await new Promise(resolve => setTimeout(resolve, 150));
  const state = await cancelJob(workspace, job.jobId);
  assert.equal(state.status, "cancelled");
});

test("approval gate pauses and resumes a task", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "批准", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, approvalBeforeRun: true, jobId: "approval" });
  process.env.FAKE_JOB_DIR = job.directory;
  assert.equal((await executeJob(workspace, job.jobId)).status, "awaiting_approval");
  await approveJob(workspace, job.jobId);
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
});

test("persistent queue respects maxConcurrent", async () => {
  const { workspace } = await setupFake();
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");
  process.env.FAKE_SLEEP_MS = "350";
  const jobs = [];
  for (const id of ["queue-1", "queue-2", "queue-3"]) {
    const job = await createJob({ workspace, task: id, review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 3_000, maxRetries: 0, jobId: id });
    process.env.FAKE_JOB_DIR = job.directory;
    jobs.push(job);
    await startBackground(workspace, id);
  }
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok((await listQueue(workspace)).entries.filter(entry => entry.status === "running").length <= 1);
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(jobs.map(job => loadState(workspace, job.jobId)));
    if (states.every(state => state.status === "done")) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.fail("队列任务未在超时时间内全部完成");
});

test("queue pause/resume and retry recover failed work", async () => {
  const { workspace } = await setupFake();
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");
  await pauseQueue(workspace);
  const job = await createJob({ workspace, task: "重排", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "requeue" });
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_EXIT_SEQUENCE = "1";
  await startBackground(workspace, job.jobId, "", 5);
  assert.equal((await listQueue(workspace)).entries.find(entry => entry.jobId === job.jobId)?.status, "queued");
  await resumeQueue(workspace);
  const failedDeadline = Date.now() + 5_000;
  while (Date.now() < failedDeadline && (await loadState(workspace, job.jobId)).status !== "failed") await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await loadState(workspace, job.jobId)).status, "failed");
  process.env.FAKE_EXIT_SEQUENCE = "0";
  const retry = await retryQueueJob(workspace, job.jobId, 10);
  assert.equal(retry.priority, 10);
  const doneDeadline = Date.now() + 5_000;
  while (Date.now() < doneDeadline && (await loadState(workspace, job.jobId)).status !== "done") await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await loadState(workspace, job.jobId)).status, "done");
});

test("isolated auto-branch and auto-commit produce a Git commit", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
  const job = await createJob({ workspace, task: "自动提交", review: false, isolated: true, autoBranch: true, autoCommit: true, commitMessage: "test: cbx commit", permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "commit" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.match(String(state.gitCommit), /^[0-9a-f]{7,}$/);
  assert.equal(spawnSync("git", ["show-ref", "--verify", "refs/heads/cbx/commit"], { cwd: workspace }).status, 0);
});

test("ESM executor plugin can replace the builtin CLI", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-"));
  const plugin = path.resolve(process.cwd(), "plugins", "example-executor.mjs");
  const job = await createJob({ workspace, task: "插件执行", review: false, isolated: false, executor: plugin, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "plugin" });
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  const events = await readFile(path.join(job.directory, "events.ndjson"), "utf8");
  assert.match(events, /plugin_finished/);
  assert.match(events, /"event":"executor_metadata","source":"plugin"/);
  assert.match(events, /"sha256":"[a-f0-9]{64}"/);
});

test("registry resolves codebuddy/cbc/opencode/pi/oh-my-pi/omp", () => {
  assert.equal(resolveExecutor("codebuddy")?.name, "codebuddy");
  assert.equal(resolveExecutor("cbc")?.name, "codebuddy");
  assert.equal(resolveExecutor("opencode")?.name, "opencode");
  assert.equal(resolveExecutor("pi")?.name, "pi");
  assert.equal(resolveExecutor("oh-my-pi")?.name, "pi");
  assert.equal(resolveExecutor("omp")?.name, "omp");
  assert.equal(resolveExecutor("oh-my-pi-omp")?.name, "omp");
  assert.equal(resolveExecutor("unknown"), undefined);
  assert.equal(BUILTIN_EXECUTORS.length, 4);
});

test("codebuddy buildArgs uses print/stream-json/max-turns/permission-mode", () => {
  const args = resolveExecutor("codebuddy")!.buildArgs({ prompt: "do it", permissionMode: "auto", maxTurns: 7 });
  assert.deepEqual(args, ["-p", "--output-format", "stream-json", "--max-turns", "7", "--permission-mode", "auto", "do it"]);
});

test("opencode buildArgs uses run/format json and auto when permission is auto/dontAsk", () => {
  const spec = resolveExecutor("opencode")!;
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "auto", maxTurns: 5 }), ["run", "--format", "json", "fix", "--auto"]);
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "default", maxTurns: 5 }), ["run", "--format", "json", "fix"]);
});

test("pi buildArgs uses -p/mode json and -a when permission is auto/dontAsk", () => {
  const spec = resolveExecutor("pi")!;
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "dontAsk", maxTurns: 5 }), ["-p", "--mode", "json", "fix", "-a"]);
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "plan", maxTurns: 5 }), ["-p", "--mode", "json", "fix"]);
});

test("omp buildArgs uses -p/mode json and ignores permissionMode (no documented flag)", () => {
  const spec = resolveExecutor("omp")!;
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "auto", maxTurns: 5 }), ["-p", "--mode", "json", "fix"]);
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "default", maxTurns: 5 }), ["-p", "--mode", "json", "fix"]);
});

test("opencode executor runs end-to-end via CBX_OPENCODE fake binary", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_OPENCODE = script;
  const job = await createJob({ workspace, task: "opencode 任务", testCommand: "node -e \"process.exit(0)\"", review: false, isolated: false, executor: "opencode", permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "oc" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  // 调度走 opencode adapter：events.ndjson 记录的 command 应是 [opencode, run, --format, json, ...]
  const events = await readFile(path.join(job.directory, "events.ndjson"), "utf8");
  assert.match(events, /"command":\[.+"run","--format","json"/);
  delete process.env.CBX_OPENCODE;
});

test("diff includes staged changes and excludes all .cbx artifacts", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  process.env.FAKE_STAGE_CHANGE = "1";
  const job = await createJob({ workspace, task: "暂存改动", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "staged-diff" });
  process.env.FAKE_JOB_DIR = job.directory;
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
  const patchText = await readFile(path.join(job.directory, "complete.patch"), "utf8");
  assert.match(patchText, /fake-change\.txt/);
  assert.doesNotMatch(patchText, /(?:^|[\\/])\.cbx(?:[\\/]|$)|state\.json|complete\.patch/m);
  assert.ok(patchText.length < 20_000, `patch unexpectedly large: ${patchText.length}`);
});

test("reviewer worktree changes fail review instead of being silently delivered", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  process.env.FAKE_REVIEW_MUTATE = "1";
  const job = await createJob({ workspace, task: "安全审查", testCommand: "node -e \"process.exit(0)\"", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "review-mutation" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "review_failed");
  assert.equal(state.reviewerModifiedWorktree, true);
});

test("review verdict is parsed only from the first line", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_REVIEW_CONTENT = "VERDICT: FAIL\nexample text\nVERDICT: PASS\n";
  const job = await createJob({ workspace, task: "严格 verdict", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "strict-verdict" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.reviewVerdict, "FAIL");
});

test("corrupt queue is surfaced and dead queue locks are recovered", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-corrupt-"));
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(path.join(workspace, ".cbx", "queue.json"), "{broken", "utf8");
  await assert.rejects(() => listQueue(workspace), /JSON/);
  await writeFile(path.join(workspace, ".cbx", "queue.json"), JSON.stringify({ maxConcurrent: 2, paused: false, entries: [], updatedAt: new Date().toISOString() }), "utf8");
  await writeFile(path.join(workspace, ".cbx", "queue.lock"), JSON.stringify({ pid: 2_147_483_647, acquiredAt: new Date().toISOString(), token: "dead" }), "utf8");
  assert.equal((await pauseQueue(workspace)).paused, true);
});

test("a live queue lock is not reclaimed", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-live-lock-"));
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(path.join(workspace, ".cbx", "queue.lock"), JSON.stringify({ pid: process.pid, acquiredAt: "2000-01-01T00:00:00.000Z", token: "live" }), "utf8");
  await assert.rejects(() => pauseQueue(workspace), /队列正在被另一个调度器更新/);
  assert.equal(JSON.parse(await readFile(path.join(workspace, ".cbx", "queue.lock"), "utf8")).token, "live");
});

test("stale job lock and a dead running queue entry recover after a crash", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "崩溃恢复", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "crash-recovery" });
  process.env.FAKE_JOB_DIR = job.directory;
  await writeFile(path.join(job.directory, "run.lock"), JSON.stringify({ pid: 2_147_483_647, acquiredAt: new Date().toISOString(), token: "dead" }), "utf8");
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(path.join(workspace, ".cbx", "queue.json"), JSON.stringify({ maxConcurrent: 1, paused: true, updatedAt: new Date().toISOString(), entries: [{ queueId: "dead-worker", jobId: job.jobId, workspace, extra: "", status: "running", createdAt: new Date().toISOString(), pid: 2_147_483_647, priority: 0 }] }), "utf8");
  const recovered = await (await import("../src/core.js")).dispatchQueue(workspace);
  assert.equal(recovered.entries[0].status, "done");
});

test("context snapshot is persisted and required by implementation and review prompts", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "保留父会话上下文", contextSnapshot: "计划：修改核心流程\\n约束：不要新增依赖", testCommand: "node -e \"process.exit(0)\"", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "context-snapshot" });
  const promptFile = path.join(workspace, "prompts.txt");
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_PROMPT_FILE = promptFile;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(await readFile(path.join(job.directory, "context-snapshot.md"), "utf8"), "计划：修改核心流程\\n约束：不要新增依赖");
  const prompts = await readFile(promptFile, "utf8");
  const snapshotPath = path.join(job.directory, "context-snapshot.md");
  const escaped = snapshotPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = prompts.match(new RegExp(escaped, "g"));
  assert.ok(matches && matches.length >= 2, `context-snapshot.md 应在 impl 和 review prompt 中各引用一次，实际 ${matches?.length ?? 0} 次`);
});

test("empty context snapshot is not persisted and omitted from prompts", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "无快照任务", testCommand: "node -e \"process.exit(0)\"", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "no-snapshot" });
  assert.equal(existsSync(path.join(job.directory, "context-snapshot.md")), false);
  const promptFile = path.join(workspace, "prompts.txt");
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_PROMPT_FILE = promptFile;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  const prompts = await readFile(promptFile, "utf8");
  assert.equal(prompts.includes("context-snapshot.md"), false);
});

test("cbx_continue overwrites context snapshot via startBackground with redaction", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-continue-snapshot-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ governance: { redactFields: ["token"], redactPatterns: ["sk-[a-zA-Z0-9]{6,}"] } }), "utf8");
  const job = await createJob({ workspace, task: "待 continue", contextSnapshot: "旧快照", review: false, isolated: false, permissionMode: "auto", maxTurns: 1, jobId: "continue-snap" });
  assert.equal(await readFile(path.join(job.directory, "context-snapshot.md"), "utf8"), "旧快照");
  await startBackground(workspace, job.jobId, "修复", 0, "新计划\nToken: leak\nkey sk-abcdef123456");
  assert.equal(await readFile(path.join(job.directory, "context-snapshot.md"), "utf8"), "新计划\nToken: [REDACTED]\nkey [REDACTED]");
});

test("cbx_continue with empty snapshot deletes existing context-snapshot.md", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-continue-delete-"));
  const job = await createJob({ workspace, task: "待清空", contextSnapshot: "将删除", review: false, isolated: false, permissionMode: "auto", maxTurns: 1, jobId: "continue-delete" });
  assert.equal(existsSync(path.join(job.directory, "context-snapshot.md")), true);
  await startBackground(workspace, job.jobId, "修复", 0, "");
  assert.equal(existsSync(path.join(job.directory, "context-snapshot.md")), false);
});

test("governance redaction scrubs context snapshot by key name and regex pattern", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-redact-snapshot-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ governance: { redactFields: ["token", "api_key"], redactPatterns: ["sk-[a-zA-Z0-9]{6,}"] } }), "utf8");
  const snapshot = "## 计划\n\nToken: secret-value-123\n- api_key: sk-internal\n使用 sk-abcdef123456 调用上游\n保留这行普通文本";
  const job = await createJob({ workspace, task: "带敏感上下文", contextSnapshot: snapshot, review: false, isolated: false, permissionMode: "auto", maxTurns: 1, jobId: "redact-snapshot" });
  const persisted = await readFile(path.join(job.directory, "context-snapshot.md"), "utf8");
  assert.doesNotMatch(persisted, /secret-value-123|sk-internal|sk-abcdef123456/);
  assert.match(persisted, /\[REDACTED\]/);
  assert.match(persisted, /## 计划/);
  assert.match(persisted, /保留这行普通文本/);
});

test("persistent serve loop reclaims dead workers on startup and stops cleanly", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "serve 恢复", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, jobId: "serve-recovery" });
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(path.join(workspace, ".cbx", "queue.json"), JSON.stringify({
    maxConcurrent: 1, paused: true, updatedAt: new Date().toISOString(),
    entries: [{ queueId: "dead-serve-worker", jobId: job.jobId, workspace, extra: "", status: "running", createdAt: new Date().toISOString(), pid: 2_147_483_647, priority: 0 }],
  }), "utf8");
  const service = await serveQueue(workspace, 50);
  assert.equal((await listQueue(workspace)).entries[0].status, "queued");
  await service.stop();
});

test("SQLite migrates legacy jobs, queue, and delivery failures without losing artifacts", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-sqlite-migration-"));
  const jobDir = path.join(workspace, ".cbx", "jobs", "legacy-job");
  await mkdir(jobDir, { recursive: true });
  const state = { jobId: "legacy-job", status: "failed", phase: "testing", workspace, jobDir, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", attempt: 2 };
  await writeFile(path.join(jobDir, "state.json"), JSON.stringify(state), "utf8");
  await writeFile(path.join(workspace, ".cbx", "queue.json"), JSON.stringify({ maxConcurrent: 2, paused: false, updatedAt: state.updatedAt, entries: [{ queueId: "legacy-entry", jobId: state.jobId, workspace, extra: "", status: "failed", createdAt: state.createdAt, priority: 0 }] }), "utf8");
  await writeFile(path.join(workspace, ".cbx", "delivery-failures.ndjson"), JSON.stringify({ type: "delivery.failed", at: state.updatedAt }) + "\n", "utf8");
  assert.equal((await listJobs(workspace))[0].jobId, state.jobId);
  assert.equal((await listQueue(workspace)).entries[0].queueId, "legacy-entry");
  const snapshot = await health(workspace);
  assert.equal(snapshot.metrics.failedJobs, 1);
  assert.equal(snapshot.metrics.deliveryFailures, 1);
});

test("strict configuration rejects unknown and unsafe nested fields", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-config-schema-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ notifications: { timeoutMs: 10 } }), "utf8");
  await assert.rejects(() => loadConfig(workspace), /notifications\.timeoutMs/);
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ governance: { unknown: true } }), "utf8");
  await assert.rejects(() => loadConfig(workspace), /governance 不支持字段/);
});

test("retention prunes expired delivery failure artifacts and SQLite records together", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-retention-"));
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ governance: { retentionDays: 1 } }), "utf8");
  await writeFile(path.join(workspace, ".cbx", "delivery-failures.ndjson"), JSON.stringify({ type: "delivery.failed", at: "2000-01-01T00:00:00.000Z" }) + "\n", "utf8");
  assert.equal((await health(workspace)).metrics.deliveryFailures, 0);
  assert.equal(await readFile(path.join(workspace, ".cbx", "delivery-failures.ndjson"), "utf8"), "");
});

test("paired state and queue write rolls back both records when queue update fails", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-atomic-"));
  const job = await createJob({ workspace, task: "原子更新", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "atomic" });
  await pauseQueue(workspace);
  const beforeState = await loadState(workspace, job.jobId);
  const beforeQueue = await loadPersistedQueue(workspace, { maxConcurrent: 2, paused: false, entries: [], updatedAt: "" });
  const db = new Database(path.join(workspace, ".cbx", "state.sqlite"));
  db.exec("CREATE TRIGGER fail_atomic_queue BEFORE UPDATE ON queue_state BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END");
  try {
    await assert.rejects(() => savePersistedStateAndQueue(workspace, job.jobId, { ...beforeState, status: "done" }, { ...beforeQueue, paused: false }), /injected queue failure/);
  } finally { db.close(); }
  assert.equal((await loadState(workspace, job.jobId)).status, "queued");
  assert.equal((await listQueue(workspace)).paused, true);
});
