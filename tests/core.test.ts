import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { approveJob, cancelJob, createJob, executeJob, health, listJobs, listQueue, loadConfig, loadState, mergeConfig, pauseQueue, readArtifact, readEventsIncremental, resumeQueue, retryQueueJob, serveQueue, startBackground } from "../src/core.js";
import { runReviewGate, stopReviewGateHook } from "../src/review-gate.js";
import { acquireServiceLease, loadPersistedQueue, loadPersistedState, savePersistedStateAndQueue } from "../src/storage.js";
import { BUILTIN_EXECUTORS, resolveExecutor } from "../src/executors/builtin.js";

const fakeAgent = `
import { appendFile, mkdir, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const prompt = args.find(value => value.includes("执行代理")) ?? args.at(-1) ?? "";
const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? 0);
if (sleepMs) await new Promise(resolve => setTimeout(resolve, sleepMs));
const jobDir = process.env.FAKE_JOB_DIR;
const promptFile = process.env.FAKE_PROMPT_FILE;
if (promptFile) await appendFile(promptFile, prompt + "\\n---\\n");
if (jobDir) {
  await mkdir(jobDir, { recursive: true });
  if (prompt.includes("context handshake")) {
    const blockingQuestions = process.env.FAKE_BLOCKING_QUESTION ? [process.env.FAKE_BLOCKING_QUESTION] : [];
    await writeFile(jobDir + "/understanding.json", JSON.stringify({ interpretedGoal: "fake goal", plannedFiles: [], acceptanceCriteria: [], assumptions: [], blockingQuestions }));
  } else if (prompt.includes("independent review")) {
    const verdict = process.env.FAKE_REVIEW_VERDICT ?? "PASS";
    await writeFile(jobDir + "/review.md", process.env.FAKE_REVIEW_CONTENT ?? ("VERDICT: " + verdict + "\\n"));
    if (process.env.FAKE_REVIEW_MUTATE === "1") await writeFile(process.cwd() + "/reviewer-change.txt", "untested reviewer change\\n");
  } else {
    await writeFile(jobDir + "/handback.md", "fake handback\\n");
    await writeFile(process.cwd() + "/fake-change.txt", "changed\\n");
    if (process.env.FAKE_STAGE_CHANGE === "1") (await import("node:child_process")).spawnSync("git", ["add", "fake-change.txt"], { cwd: process.cwd() });
  }
}
// review-gate：prompt 含 "stop-gate review"，从 prompt 解析 review.md 路径写 verdict
if (prompt.includes("stop-gate review")) {
  const match = prompt.match(/将结果写入 (.+?review\\.md)/);
  if (match) {
    const verdict = process.env.FAKE_REVIEW_VERDICT ?? "PASS";
    await writeFile(match[1], process.env.FAKE_REVIEW_CONTENT ?? ("VERDICT: " + verdict + "\\n"));
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
  const binaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cbx-fake-bin-"));
  const script = path.join(binaryDirectory, "fake-codebuddy.mjs");
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
  delete process.env.FAKE_BLOCKING_QUESTION;
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

test("readEventsIncremental returns events after cursor and skips partial tail", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-"));
  const job = await createJob({ workspace, task: "游标", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "cursor-job" });
  const eventsFile = path.join(job.directory, "events.ndjson");
  await writeFile(eventsFile, [
    JSON.stringify({ event: "a", n: 0 }),
    JSON.stringify({ event: "a", n: 1 }),
    JSON.stringify({ event: "a", n: 2 }),
    "",  // trailing newline split artifact
    "{partial",  // line index 3: concurrent write mid-flight, truncated
  ].join("\n"), "utf8");

  // since=0: three valid lines, stop at partial; next_offset points past line 2
  const first = await readEventsIncremental(workspace, job.jobId, 0);
  assert.equal(first.events.length, 3);
  assert.equal(first.next_offset, 3);

  // since=3: partial line still there, returns nothing, offset unchanged
  const second = await readEventsIncremental(workspace, job.jobId, first.next_offset);
  assert.equal(second.events.length, 0);
  assert.equal(second.next_offset, 3);

  // worker appends completion of partial line (now valid), plus one more
  await writeFile(eventsFile, [
    JSON.stringify({ event: "a", n: 0 }),
    JSON.stringify({ event: "a", n: 1 }),
    JSON.stringify({ event: "a", n: 2 }),
    JSON.stringify({ event: "a", n: 3 }),
    JSON.stringify({ event: "a", n: 4 }),
    "",
  ].join("\n"), "utf8");

  const third = await readEventsIncremental(workspace, job.jobId, second.next_offset);
  assert.equal(third.events.length, 2);
  assert.equal(third.next_offset, 5);
  assert.equal(JSON.parse(third.events[1]).n, 4);
});

test(".cbx.json provides defaults and tasks can be listed", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-config-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ testCommand: "npm test", review: true, isolated: true, maxRetries: 3, approval: { beforeRun: true }, reviewExecutor: "opencode" }), "utf8");
  const config = await loadConfig(workspace);
  const defaults = mergeConfig(config, {});
  assert.equal(defaults.review, true);
  assert.equal(defaults.approvalBeforeRun, true);
  assert.equal(defaults.reviewExecutor, "opencode");
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

test("dontAsk permission mode requires an explicit unsafe opt-in", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-dontask-"));
  await assert.rejects(() => createJob({ workspace, task: "不安全", review: false, isolated: false, permissionMode: "dontAsk", maxTurns: 5 }), /dangerously-skip-permissions/);
  const job = await createJob({ workspace, task: "显式放行", review: false, isolated: false, permissionMode: "dontAsk", allowUnsafePermissions: true, maxTurns: 5, jobId: "dontask-ok" });
  assert.equal(job.jobId, "dontask-ok");
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
  const result = JSON.parse(await readArtifact(workspace, job.jobId, "result.json"));
  assert.equal(result.status, "done");
  assert.ok(result.changedFiles.includes("fake-change.txt"));
  assert.equal(result.handback.trim(), "fake handback");
  assert.match(result.artifactHashes["complete.patch"], /^[a-f0-9]{64}$/);
});

test("structured task contract performs a plan-only handshake and pauses on ambiguity", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_BLOCKING_QUESTION = "是否允许修改公共 API？";
  const job = await createJob({ workspace, task: "兼容目标", taskContract: { goal: "明确目标", acceptanceCriteria: ["保持 API 兼容"] }, review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 1, jobId: "handshake" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "awaiting_clarification");
  assert.equal(state.attempt, 0, "语义歧义不应消耗实现重试");
  assert.equal(existsSync(path.join(workspace, "fake-change.txt")), false);
  assert.deepEqual(JSON.parse(await readArtifact(workspace, job.jobId, "understanding.json")).blockingQuestions, ["是否允许修改公共 API？"]);
  assert.equal(JSON.parse(await readArtifact(workspace, job.jobId, "result.json")).acceptanceEvidence[0].status, "unverified");
});

test("reviewExecutor can independently override the implementation executor", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_OPENCODE = script;
  const job = await createJob({ workspace, task: "独立审查", review: true, isolated: false, executor: "codebuddy", reviewExecutor: "opencode", permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "review-executor" });
  process.env.FAKE_JOB_DIR = job.directory;
  try { assert.equal((await executeJob(workspace, job.jobId)).status, "done"); }
  finally { delete process.env.CBX_OPENCODE; }
  const events = await readFile(path.join(job.directory, "events.ndjson"), "utf8");
  assert.match(events, /"name":"codebuddy"/);
  assert.match(events, /"name":"opencode"/);
});

test("staged tasks inherit the top-level reviewExecutor", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_OPENCODE = script;
  const job = await createJob({ workspace, task: "阶段审查", review: true, isolated: false, executor: "codebuddy", reviewExecutor: "opencode", permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "staged-review-executor", taskContract: { stages: [{ name: "implement", executor: "codebuddy", task: "实现" }] } });
  process.env.FAKE_JOB_DIR = job.directory;
  try { assert.equal((await executeJob(workspace, job.jobId)).status, "done"); }
  finally { delete process.env.CBX_OPENCODE; }
  const events = (await readFile(path.join(job.directory, "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.event === "executor_metadata").map(event => event.name), ["codebuddy", "codebuddy", "opencode"]);
});

test("staged tasks use the first stage executor for the context handshake", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_CODEBUDDY = path.join(workspace, "missing-codebuddy.mjs");
  process.env.CBX_OPENCODE = script;
  const job = await createJob({ workspace, task: "仅阶段执行器", review: false, isolated: false, executor: "codebuddy", permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "stage-handshake-executor", taskContract: { stages: [{ name: "implement", executor: "opencode", task: "实现" }] } });
  process.env.FAKE_JOB_DIR = job.directory;
  try { assert.equal((await executeJob(workspace, job.jobId)).status, "done"); }
  finally {
    process.env.CBX_CODEBUDDY = script;
    delete process.env.CBX_OPENCODE;
  }
  const events = (await readFile(path.join(job.directory, "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.event === "executor_metadata").map(event => event.name), ["opencode", "opencode"]);
});

test("git baseline is recorded and isolated execution stays pinned when HEAD drifts", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "base"], { cwd: workspace });
  const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).stdout.trim();
  const job = await createJob({ workspace, task: "固定基线", review: false, isolated: true, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "pinned" });
  await writeFile(path.join(workspace, "README.md"), "later\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "later"], { cwd: workspace });
  process.env.FAKE_JOB_DIR = job.directory;
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
  const result = JSON.parse(await readArtifact(workspace, job.jobId, "result.json"));
  assert.equal(result.baseCommit, baseCommit);
  assert.equal(result.baselineDrift, true);
});

test("non-isolated baseline drift pauses without blind retry", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "base"], { cwd: workspace });
  const job = await createJob({ workspace, task: "检测漂移", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 2, jobId: "drift" });
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
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "base"], { cwd: workspace });
  await writeFile(path.join(workspace, "draft.txt"), "uncommitted\n", "utf8");
  const job = await createJob({ workspace, task: "不得丢草稿", review: false, isolated: true, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 2, jobId: "dirty-isolated" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "dirty_baseline");
  assert.equal(state.attempt, 0);
  assert.equal(existsSync(path.join(job.directory, "worktree.json")), false);
});

test("non-isolated execution compares dirty content fingerprint", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "base"], { cwd: workspace });
  await writeFile(path.join(workspace, "draft.txt"), "version one\n", "utf8");
  const unchanged = await createJob({ workspace, task: "使用相同草稿", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "dirty-same" });
  process.env.FAKE_JOB_DIR = unchanged.directory;
  assert.equal((await executeJob(workspace, unchanged.jobId)).status, "done");

  await writeFile(path.join(workspace, "fake-change.txt"), "changed\n", "utf8");
  const changed = await createJob({ workspace, task: "检测草稿变化", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "dirty-changed" });
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
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "base"], { cwd: workspace });
  const job = await createJob({ workspace, task: "刷新基线", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "refresh-drift" });
  await writeFile(path.join(workspace, "README.md"), "later\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "later"], { cwd: workspace });
  assert.equal((await executeJob(workspace, job.jobId)).baselineDrift, true);
  process.env.FAKE_JOB_DIR = job.directory;
  await startBackground(workspace, job.jobId, "使用新基线", 0, "已确认新 HEAD", true);
  const refreshed = await loadState(workspace, job.jobId);
  assert.equal(refreshed.baselineDrift, false);
  assert.equal(refreshed.dirtyBaselineDrift, false);
  assert.equal(refreshed.currentCommit, null);
  assert.equal(JSON.parse(await readArtifact(workspace, job.jobId, "result.json")).baselineDrift, false);
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
  // 容器目录（.<repo>.cbx-worktrees/）在最后一个 job 清理后也应删除，避免孤儿
  const container = path.dirname(record.path);
  assert.equal(existsSync(container), false);
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

test("cancelling a queued job prevents it from running after queue resume", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "排队取消", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "queued-cancel" });
  process.env.FAKE_JOB_DIR = job.directory;
  await pauseQueue(workspace);
  await startBackground(workspace, job.jobId);
  assert.equal((await listQueue(workspace)).entries.find(entry => entry.jobId === job.jobId)?.status, "queued");
  await cancelJob(workspace, job.jobId);
  assert.equal((await loadState(workspace, job.jobId)).status, "cancelled");
  assert.equal((await listQueue(workspace)).entries.find(entry => entry.jobId === job.jobId)?.status, "cancelled");
  await resumeQueue(workspace);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal((await loadState(workspace, job.jobId)).status, "cancelled");
  assert.equal(existsSync(path.join(workspace, "fake-change.txt")), false);
});

test("cancelling a non-running job never trusts a stale pid artifact", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "陈旧 PID", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "stale-pid" });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true });
  try {
    assert.ok(unrelated.pid);
    await writeFile(path.join(job.directory, "pid"), String(unrelated.pid), "utf8");
    assert.equal((await cancelJob(workspace, job.jobId)).status, "cancelled");
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  } finally { unrelated.kill("SIGKILL"); }
});

test("executeJob does not start a cancelled job and continue clears the marker", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "取消后不启动", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "no-restart" });
  process.env.FAKE_JOB_DIR = job.directory;
  await cancelJob(workspace, job.jobId);
  assert.equal((await executeJob(workspace, job.jobId)).status, "cancelled");
  assert.equal(existsSync(path.join(workspace, "fake-change.txt")), false);
  assert.equal(existsSync(path.join(job.directory, "cancel.requested")), true);
  // 显式重跑入口（continue/startBackground）在入队时清除取消标记，任务可以再次执行。
  await startBackground(workspace, job.jobId, "重跑");
  assert.equal(existsSync(path.join(job.directory, "cancel.requested")), false);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await loadState(workspace, job.jobId)).status !== "done") await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await loadState(workspace, job.jobId)).status, "done");
});

test("stage handback artifacts are readable via readArtifact", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-stage-read-"));
  const job = await createJob({ workspace, task: "阶段产物", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "stage-read", taskContract: { stages: [{ name: "s1", executor: "codebuddy", task: "t1" }] } });
  await writeFile(path.join(job.directory, "stage-0-s1-handback.md"), "stage handback", "utf8");
  assert.equal(await readArtifact(workspace, job.jobId, "stage-0-s1-handback.md"), "stage handback");
  await assert.rejects(() => readArtifact(workspace, job.jobId, "stage-0-../evil-handback.md"), /不允许读取/);
});

test("approval gate pauses and resumes a task", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "批准", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, approvalBeforeRun: true, jobId: "approval" });
  process.env.FAKE_JOB_DIR = job.directory;
  assert.equal((await executeJob(workspace, job.jobId)).status, "awaiting_approval");
  await approveJob(workspace, job.jobId);
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
});

test("background approval gate finishes its queue entry without spawning another worker", async () => {
  const { workspace } = await setupFake();
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");
  const job = await createJob({ workspace, task: "后台批准", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, approvalBeforeRun: true, jobId: "background-approval" });
  await startBackground(workspace, job.jobId);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await loadState(workspace, job.jobId)).status !== "awaiting_approval") {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const entry = (await listQueue(workspace)).entries.find(item => item.jobId === job.jobId);
  assert.equal((await loadState(workspace, job.jobId)).status, "awaiting_approval");
  assert.equal(entry?.status, "awaiting_approval");
  assert.equal(entry?.pid, undefined);

  const { dispatchQueue } = await import("../src/core.js");
  await dispatchQueue(workspace);
  await dispatchQueue(workspace);
  const after = (await listQueue(workspace)).entries.filter(item => item.jobId === job.jobId);
  assert.equal(after.length, 1);
  assert.equal(after[0].status, "awaiting_approval");
  assert.equal(after[0].pid, undefined);
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

test("autoCommit=true implicitly enables isolated instead of throwing", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-implicit-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
  // autoCommit=true，isolated=false（等价 mergeConfig 默认）—— 不再抛错，隐含开启 isolated
  const job = await createJob({ workspace, task: "隐含隔离", review: false, isolated: false, autoBranch: true, autoCommit: true, commitMessage: "test", permissionMode: "auto", maxTurns: 5, timeoutMs: 2_000, maxRetries: 0, jobId: "implicit" });
  // context.json 落盘的 isolated 应为 true
  const context = JSON.parse(await readFile(path.join(job.directory, "context.json"), "utf8")) as { isolated: boolean };
  assert.equal(context.isolated, true);
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

test("registry resolves codebuddy/cbc/opencode/omp/oh-my-pi/cline", () => {
  assert.equal(resolveExecutor("codebuddy")?.name, "codebuddy");
  assert.equal(resolveExecutor("cbc")?.name, "codebuddy");
  assert.equal(resolveExecutor("opencode")?.name, "opencode");
  assert.equal(resolveExecutor("omp")?.name, "omp");
  assert.equal(resolveExecutor("oh-my-pi")?.name, "omp");
  assert.equal(resolveExecutor("cline")?.name, "cline");
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

test("omp buildArgs uses -p/mode json and ignores permissionMode (no documented flag)", () => {
  const spec = resolveExecutor("omp")!;
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "auto", maxTurns: 5 }), ["-p", "--mode", "json", "fix"]);
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "default", maxTurns: 5 }), ["-p", "--mode", "json", "fix"]);
});

test("cline buildArgs maps every permission mode without inheriting auto approval", () => {
  const spec = resolveExecutor("cline")!;
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "auto", maxTurns: 5 }), ["--json", "fix", "--auto-approve", "true"]);
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "dontAsk", maxTurns: 5 }), ["--json", "fix", "--auto-approve", "true"]);
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "default", maxTurns: 5 }), ["--json", "fix", "--auto-approve", "false"]);
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "acceptEdits", maxTurns: 5 }), ["--json", "fix", "--auto-approve", "false"]);
  assert.deepEqual(spec.buildArgs({ prompt: "fix", permissionMode: "plan", maxTurns: 5 }), ["--json", "fix", "--auto-approve", "false", "--plan"]);
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

test("semantic review failures pause without automatic implementation retries", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_REVIEW_CONTENT = "VERDICT: FAIL\nCLASSIFICATION: SEMANTIC\n需要产品决策\n";
  const job = await createJob({ workspace, task: "语义冲突", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 2, jobId: "semantic-review" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "awaiting_clarification");
  assert.equal(state.attempt, 1);
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
  await assert.rejects(() => serveQueue(workspace, 50), /已有活跃 serve 实例/);
  await service.stop();
});

test("expired service leases fence the previous owner", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-lease-fencing-"));
  const first = await acquireServiceLease(workspace, "test-lease", 80);
  await assert.rejects(() => acquireServiceLease(workspace, "test-lease", 80), /已有活跃 serve 实例/);
  await new Promise(resolve => setTimeout(resolve, 100));
  const second = await acquireServiceLease(workspace, "test-lease", 80);
  assert.equal(await first.renew(), false);
  assert.equal(await second.renew(), true);
  await second.release();
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

test("runReviewGate skips when there are no uncommitted changes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-gate-skip-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
  const result = await runReviewGate(workspace, { executor: "codebuddy", timeoutMs: 5_000 });
  assert.equal(result.pass, true);
  assert.equal(result.verdict, "SKIP");
});

test("runReviewGate returns PASS verdict from executor for uncommitted changes", async () => {
  const { workspace, script } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
  await writeFile(path.join(workspace, "README.md"), "changed\n", "utf8");
  process.env.FAKE_REVIEW_VERDICT = "PASS";
  const result = await runReviewGate(workspace, { executor: "codebuddy", timeoutMs: 10_000 });
  assert.equal(result.pass, true);
  assert.equal(result.verdict, "PASS");
});

test("runReviewGate returns FAIL verdict from executor and block decision", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
  await writeFile(path.join(workspace, "README.md"), "dangerous\n", "utf8");
  process.env.FAKE_REVIEW_VERDICT = "FAIL";
  process.env.FAKE_REVIEW_CONTENT = "VERDICT: FAIL\n\n# 问题\n\n- 引入危险模式";
  const result = await runReviewGate(workspace, { executor: "codebuddy", timeoutMs: 10_000 });
  assert.equal(result.pass, false);
  assert.equal(result.verdict, "FAIL");
  assert.match(result.reason, /引入危险模式/);
});

test("stopReviewGateHook returns null when reviewGate disabled (fail-open default)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-gate-off-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  await writeFile(path.join(workspace, "README.md"), "x\n", "utf8");
  const decision = await stopReviewGateHook(workspace);
  assert.equal(decision, null);
});

test("stopReviewGateHook returns null when reviewGate enabled but no changes", async () => {
  const { workspace } = await setupFake();
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ reviewGate: { enabled: true } }), "utf8");
  const decision = await stopReviewGateHook(workspace);
  assert.equal(decision, null);
});

test("reviewGate config field is accepted and rejects unknown nested keys", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-gate-config-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ reviewGate: { enabled: true } }), "utf8");
  const config = await loadConfig(workspace);
  assert.equal(config.reviewGate?.enabled, true);
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ reviewGate: { unknown: 1 } }), "utf8");
  await assert.rejects(() => loadConfig(workspace), /reviewGate 不支持字段：unknown/);
});

test("stopReviewGateHook fail-open 放行当 .cbx.json 非法（loadConfig 抛异常不逃逸）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-gate-bad-config-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ reviewGate: { unknown: 1 } }), "utf8");
  const decision = await stopReviewGateHook(workspace);
  assert.equal(decision, null);
});

test("multi-stage chain runs each stage with its own executor and accumulates stage reports", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_OPENCODE = script;
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
  const job = await createJob({ workspace, task: "多阶段任务", testCommand: "node -e \"process.exit(0)\"", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "staged", taskContract: { goal: "接力链", stages: [{ name: "scaffold", executor: "codebuddy", task: "搭骨架" }, { name: "implement", executor: "opencode", task: "填实现" }, { name: "x/../evil", executor: "codebuddy", task: "t3" }] } });
  process.env.FAKE_JOB_DIR = job.directory;
  let state: { status: string; stages?: unknown[] };
  try { state = await executeJob(workspace, job.jobId); }
  finally { delete process.env.CBX_OPENCODE; }
  assert.equal(state.status, "done");
  // result.json 应包含 stages 数组，每 stage 记录 executor 和 verdict
  const result = JSON.parse(await readArtifact(workspace, job.jobId, "result.json"));
  assert.ok(Array.isArray(result.stages), "result.json should have stages array");
  assert.equal(result.stages.length, 3);
  assert.equal(result.stages[0].name, "scaffold");
  assert.equal(result.stages[0].executor, "codebuddy");
  assert.equal(result.stages[1].name, "implement");
  assert.equal(result.stages[1].executor, "opencode");
  // 每 stage 应有独立的 handback 副本
  assert.ok(existsSync(path.join(job.directory, "stage-0-scaffold-handback.md")), "stage-0 handback copy should exist");
  assert.ok(existsSync(path.join(job.directory, "stage-1-implement-handback.md")), "stage-1 handback copy should exist");
  // 恶意 stage name（含路径分隔符）必须被清洗，副本落在 job 目录内，不得路径穿越
  assert.ok(existsSync(path.join(job.directory, "stage-2-x-..-evil-handback.md")), "hostile stage name should be sanitized");
  // 事件流应有 stage_started / stage_finished
  const events = await readFile(path.join(job.directory, "events.ndjson"), "utf8");
  assert.match(events, /"event":"stage_started"/);
  assert.match(events, /"event":"stage_finished"/);
});

test("normalizeTaskContract rejects invalid stages and accepts valid ones", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-"));
  // 空 stages 数组应拒绝
  await assert.rejects(() => createJob({ workspace, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "bad-empty", taskContract: { stages: [] } }), /stages 必须是非空数组/);
  // 缺少 executor 应拒绝
  await assert.rejects(() => createJob({ workspace, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "bad-noexec", taskContract: { stages: [{ name: "s1", task: "do" }] as unknown as { name: string; executor: string; task: string }[] } }), /executor 必须是非空字符串/);
  // 合法 stages 应持久化到 context-contract.json
  const job = await createJob({ workspace, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "good-stages", taskContract: { stages: [{ name: "s1", executor: "codebuddy", task: "do something" }] } });
  const contract = JSON.parse(await readFile(path.join(job.directory, "context-contract.json"), "utf8"));
  assert.equal(contract.stages[0].name, "s1");
  assert.equal(contract.stages[0].executor, "codebuddy");
});

test("mid-chain stage failure preserves earlier stage reports in result.json", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_OPENCODE = script;
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
    const job = await createJob({ workspace, task: "阶段失败", testCommand: "node -e \"process.exit(0)\"", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "stage-fail", taskContract: { goal: "接力链", stages: [{ name: "a", executor: "codebuddy", task: "t1" }, { name: "b", executor: "opencode", task: "t2" }] } });
  // 计数器放 job.directory（git 排除 .cbx），避免握手阶段的工作区 diff 被误判为"修改了工作区"。
  const counter = path.join(job.directory, "counter.txt");
  // 执行序：index 0 = 上下文握手（exit 0），index 1 = stage0（exit 0），index 2 = stage1（exit 1 触发失败）
  process.env.FAKE_COUNTER_FILE = counter;
  process.env.FAKE_EXIT_SEQUENCE = "0,0,1";
  process.env.FAKE_JOB_DIR = job.directory;
  let state;
  try { state = await executeJob(workspace, job.jobId); }
  finally { delete process.env.CBX_OPENCODE; }
  assert.equal(state.status, "failed");
  const result = JSON.parse(await readArtifact(workspace, job.jobId, "result.json"));
  assert.ok(Array.isArray(result.stages), "result.json should keep stage reports after mid-chain failure");
  assert.equal(result.stages.length, 2);
  assert.equal(result.stages[0].name, "a");
  assert.equal(result.stages[0].exitCode, 0);
  assert.equal(result.stages[1].name, "b");
  assert.equal(result.stages[1].exitCode, 1);
});

test("createJob rejects jobId that exists in SQLite but has no directory (legacy import collision)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-collision-"));
  // 先建一个 job，让它在 SQLite 里有记录
  const first = await createJob({ workspace, task: "原始", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "collide" });
  assert.ok((await loadPersistedState(workspace, "collide")));
  // 模拟用户手清目录但 SQLite 记录仍在
  const { rmSync } = await import("node:fs");
  rmSync(first.directory, { recursive: true, force: true });
  assert.equal(existsSync(first.directory), false);
  // 同 jobId 建新 job 应拒绝，而非静默覆盖
  await assert.rejects(
    () => createJob({ workspace, task: "覆盖", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "collide" }),
    /任务已存在（SQLite 有记录但目录缺失）/,
  );
  // 确认未覆盖：旧 state 仍在（虽然目录没了，SQLite 记录未被新 createJob 改动）
  const stillThere = await loadPersistedState<{ task?: string }>(workspace, "collide");
  assert.ok(stillThere, "SQLite record should remain untouched");
});

test("retryQueueJob produces no duplicate entries for the same jobId", async () => {
  const { workspace } = await setupFake();
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");
  await pauseQueue(workspace);
  const job = await createJob({ workspace, task: "重试无重复", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "no-dup" });
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_EXIT_SEQUENCE = "1";
  await startBackground(workspace, job.jobId);
  await resumeQueue(workspace);
  const failedDeadline = Date.now() + 5_000;
  while (Date.now() < failedDeadline && (await loadState(workspace, job.jobId)).status !== "failed") await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await loadState(workspace, job.jobId)).status, "failed");
  process.env.FAKE_EXIT_SEQUENCE = "0";
  const retry = await retryQueueJob(workspace, job.jobId);
  assert.equal(retry.status, "queued");
  // 该 jobId 的 queued/running entry 必须恰好 1 个（无老 entry 并存）
  const active = (await listQueue(workspace)).entries.filter(e => e.jobId === job.jobId && ["queued", "running"].includes(e.status));
  assert.equal(active.length, 1, "should have exactly one active entry after retry");
});

test("dispatchQueue reclaims a running entry whose worker never started (no heartbeat, past grace)", async () => {
  const { workspace } = await setupFake();
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");
  const job = await createJob({ workspace, task: "僵尸 worker", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "zombie" });
  // 手工注入一个 running entry，pid 指向当前进程（processAlive=true）但无 heartbeat 且 startedAt 远超 grace
  const fakeOldStartedAt = new Date(Date.now() - 120_000).toISOString();
  await savePersistedStateAndQueue(workspace, job.jobId, { ...(await loadState(workspace, job.jobId)), status: "running" }, {
    maxConcurrent: 1, paused: true, updatedAt: new Date().toISOString(),
    entries: [{ queueId: "zombie-entry", jobId: job.jobId, workspace, extra: "", status: "running", createdAt: fakeOldStartedAt, startedAt: fakeOldStartedAt, pid: process.pid, priority: 0 }],
  });
  // 确认无 heartbeat 文件
  assert.equal(existsSync(path.join(job.directory, "worker.heartbeat")), false);
  await (await import("../src/core.js")).dispatchQueue(workspace);
  const after = (await listQueue(workspace)).entries.find(e => e.queueId === "zombie-entry");
  // 进程虽活但无 heartbeat 且超 grace → 应回收（paused 阻止重 spawn，entry 应落到 queued）
  assert.equal(after?.status, "queued", "stale entry should be reclaimed to queued despite live pid");
});

test("dispatchQueue reclaims a live pid whose heartbeat stopped advancing", async () => {
  const { workspace } = await setupFake();
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");
  const job = await createJob({ workspace, task: "停止心跳", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "stale-heartbeat" });
  const staleAt = new Date(Date.now() - 120_000);
  const heartbeat = path.join(job.directory, "worker.heartbeat");
  await writeFile(heartbeat, staleAt.toISOString(), "utf8");
  await utimes(heartbeat, staleAt, staleAt);
  await savePersistedStateAndQueue(workspace, job.jobId, { ...(await loadState(workspace, job.jobId)), status: "running" }, {
    maxConcurrent: 1, paused: true, updatedAt: new Date().toISOString(),
    entries: [{ queueId: "stale-heartbeat-entry", jobId: job.jobId, workspace, extra: "", status: "running", createdAt: staleAt.toISOString(), startedAt: staleAt.toISOString(), pid: process.pid, priority: 0 }],
  });
  await (await import("../src/core.js")).dispatchQueue(workspace);
  assert.equal((await listQueue(workspace)).entries.find(entry => entry.queueId === "stale-heartbeat-entry")?.status, "queued");
});
