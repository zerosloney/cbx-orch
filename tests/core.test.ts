import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { approveJob, cancelJob, createJob, executeJob, health, listJobs, listQueue, loadConfig, loadState, mergeConfig, pauseQueue, readArtifact, readEventsIncremental, resumeQueue, retryQueueJob, serveQueue, startBackground, type JobState } from "../src/core.js";
import { runReviewGate, stopReviewGateHook } from "../src/review-gate.js";
import { acquireServiceLease, loadPersistedQueue, loadPersistedState, savePersistedStateAndQueue } from "../src/storage.js";
import { BUILTIN_EXECUTORS, resolveExecutor } from "../src/executors/builtin.js";
import { parseNextAction } from "../src/adaptive-manager.js";
import { CONTEXT_PACK_MAX_CHARS, parseContextPack } from "../src/context-pack.js";
import { createHumanGate, extendRoundLimit, parseHumanGate, resolveHumanGate } from "../src/human-gate.js";

const fakeAgent = `
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const prompt = args.find(value => value.includes("执行代理")) ?? args.at(-1) ?? "";
const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? 0);
if (sleepMs) await new Promise(resolve => setTimeout(resolve, sleepMs));
const jobDir = process.env.FAKE_JOB_DIR;
const promptFile = process.env.FAKE_PROMPT_FILE;
if (promptFile) await appendFile(promptFile, prompt + "\\n---\\n");
if (jobDir) {
  await mkdir(jobDir, { recursive: true });
  if (prompt.includes("adaptive manager")) {
    const candidate = prompt.match(/写入 (.+?manager-decision-candidate\\.json)/)?.[1];
    const actions = (process.env.FAKE_MANAGER_ACTIONS ?? "execute,done").split(",");
    const counterFile = process.env.FAKE_MANAGER_COUNTER_FILE ?? (jobDir + "/manager-counter.txt");
    let managerIndex = 0;
    try { managerIndex = Number(await (await import("node:fs/promises")).readFile(counterFile, "utf8")); } catch {}
    await writeFile(counterFile, String(managerIndex + 1));
    const action = actions[Math.min(managerIndex, actions.length - 1)];
    if (action === "mutate") await writeFile(process.cwd() + "/manager-change.txt", "unsafe manager change\\n");
    let requiredChangePresent = true;
    if (action === "done" && process.env.FAKE_REQUIRE_CHANGE_ON_DONE === "1") {
      try { await access(process.cwd() + "/fake-change.txt"); } catch { requiredChangePresent = false; }
    }
    const decision = action === "execute" || action === "mutate" ? { action: action === "mutate" ? "done" : "execute", ...(action === "execute" ? { stage: { name: "adaptive-implementation", executor: "codebuddy", task: "implement adaptive task" } } : {}) }
      : action === "ask" ? { action, questions: ["请补充需求？"] }
      : action === "blocked" ? { action, reason: "缺少外部权限" }
      : action === "invalid" ? { action: "done", extra: true }
      : requiredChangePresent ? { action: "done" } : { action: "done", missingChange: true };
    if (candidate) await writeFile(candidate, JSON.stringify(decision));
  } else if (prompt.includes("context handshake")) {
    const blockingQuestions = process.env.FAKE_BLOCKING_QUESTION ? [process.env.FAKE_BLOCKING_QUESTION] : [];
    await writeFile(jobDir + "/understanding.json", JSON.stringify({ interpretedGoal: "fake goal", plannedFiles: [], acceptanceCriteria: [], assumptions: [], blockingQuestions }));
  } else if (prompt.includes("independent review")) {
    const verdict = process.env.FAKE_REVIEW_VERDICT ?? "PASS";
    await writeFile(jobDir + "/review.md", process.env.FAKE_REVIEW_CONTENT ?? ("VERDICT: " + verdict + "\\n"));
    let definitions;
    try { definitions = JSON.parse(await (await import("node:fs/promises")).readFile(jobDir + "/auditor-context.json", "utf8")).current.criteria; } catch {}
    if (definitions) {
      const partial = process.env.FAKE_AUDIT_MODE === "partial";
      const inconsistent = process.env.FAKE_AUDIT_MODE === "inconsistent";
      const criteria = definitions.map((item, index) => {
        const status = inconsistent || (partial && index > 0) ? "unverified" : "verified";
        const evidence = status === "verified" ? ["complete.patch", "test.log", process.env.FAKE_AUDIT_UNSAFE === "1" ? "../secret" : "review.md"] : [];
        return { id: item.id, status, evidence };
      });
      await writeFile(jobDir + "/audit-candidate.json", JSON.stringify({ version: 1, completion: partial ? "incomplete" : "complete", cleanliness: "clean", alignment: "aligned", criteria }));
    }
    if (process.env.FAKE_REVIEW_MUTATE === "1") await writeFile(process.cwd() + "/reviewer-change.txt", "untested reviewer change\\n");
  } else {
    await writeFile(jobDir + "/handback.md", "fake handback\\n");
    if (process.env.FAKE_MUTATE_DEP === "1") await writeFile(process.cwd() + "/package.json", '{"name":"modified"}', "utf8");
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
  delete process.env.FAKE_AUDIT_MODE;
  delete process.env.FAKE_AUDIT_UNSAFE;
  delete process.env.FAKE_MANAGER_ACTIONS;
  delete process.env.FAKE_MANAGER_COUNTER_FILE;
  delete process.env.FAKE_REQUIRE_CHANGE_ON_DONE;
  delete process.env.FAKE_STAGE_CHANGE;
  delete process.env.FAKE_COUNTER_FILE;
  delete process.env.FAKE_PROMPT_FILE;
  delete process.env.FAKE_BLOCKING_QUESTION;
  delete process.env.FAKE_MUTATE_DEP;
  return { workspace, script };
}

async function createAdaptiveJob(workspace: string, jobId: string, maxRounds = 4) {
  return createJob({ workspace, task: "adaptive task", taskContract: { goal: "adaptive goal", acceptanceCriteria: ["adaptive criterion"] }, testCommand: "node -e \"process.exit(0)\"", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, adaptive: { enabled: true, maxRounds }, jobId });
}

async function initializeGitWorkspace(workspace: string): Promise<void> {
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
}

test("createJob persists task contract and state", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-"));
  const job = await createJob({ workspace, task: "实现功能", testCommand: "npm test", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, jobId: "test-job" });
  assert.equal(job.jobId, "test-job");
  assert.equal((await loadState(workspace, job.jobId)).status, "queued");
  assert.match(await readFile(path.join(job.directory, "request.md"), "utf8"), /实现功能/);
  assert.equal(existsSync(path.join(job.directory, "context-snapshot.md")), false);
  assert.equal(JSON.parse(await readFile(path.join(job.directory, "context.json"), "utf8")).adaptive, undefined);
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
  const job = await createJob({ workspace, task: "实现功能", taskContract: { acceptanceCriteria: ["验收通过"] }, testCommand: "node -e \"process.exit(0)\"", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "success" });
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
  assert.equal(result.acceptanceEvidence[0].status, "evidence_available");
  assert.equal(result.audit.completion, "complete");
  assert.equal(result.audit.cleanliness, "clean");
  assert.equal(result.audit.alignment, "aligned");
  assert.match(result.verifiedProgress.criteria[0].id, /^criterion-[a-f0-9]{16}$/);
  assert.equal(result.verifiedProgress.criteria[0].status, "verified");
  assert.match(result.verifiedProgress.criteria[0].evidence[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await readArtifact(workspace, job.jobId, "audit.json")), result.audit);
  assert.deepEqual(JSON.parse(await readArtifact(workspace, job.jobId, "verified-progress.json")), result.verifiedProgress);
});

test("structured audit preserves partial criterion progress but blocks completion", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_AUDIT_MODE = "partial";
  const job = await createJob({ workspace, task: "部分完成", taskContract: { acceptanceCriteria: ["标准 A", "标准 B"] }, review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "partial-audit" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "verification_gate");
  const result = JSON.parse(await readArtifact(workspace, job.jobId, "result.json"));
  assert.deepEqual(result.verifiedProgress.criteria.map((item: { status: string }) => item.status), ["verified", "unverified"]);
  assert.deepEqual(result.acceptanceEvidence.map((item: { status: string }) => item.status), ["unverified", "unverified"]);
});

test("structured audit rejects evidence paths outside the safe artifact set", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_AUDIT_UNSAFE = "1";
  const job = await createJob({ workspace, task: "非法证据", taskContract: { acceptanceCriteria: ["安全引用"] }, review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "unsafe-audit" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "review_failed");
  assert.match(String(state.auditError), /不允许或不存在的产物/);
  await assert.rejects(() => readArtifact(workspace, job.jobId, "audit-candidate.json"), /不允许读取/);
});

test("verified progress invalidates changed evidence and recovers with fresh audit", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "证据恢复", taskContract: { acceptanceCriteria: ["结果可信"] }, review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "progress-recovery" });
  process.env.FAKE_JOB_DIR = job.directory;
  const first = await executeJob(workspace, job.jobId);
  assert.equal(first.status, "done");
  const stableId = (first.verifiedProgress as { criteria: Array<{ id: string }> }).criteria[0].id;

  await writeFile(path.join(job.directory, "test.log"), "tampered evidence\n", "utf8");
  process.env.FAKE_EXIT_SEQUENCE = "1";
  const failed = await executeJob(workspace, job.jobId);
  assert.equal(failed.status, "failed");
  assert.equal((failed.verifiedProgress as { criteria: Array<{ status: string }> }).criteria[0].status, "invalidated");

  process.env.FAKE_EXIT_SEQUENCE = "0";
  const recovered = await executeJob(workspace, job.jobId);
  assert.equal(recovered.status, "done");
  const recoveredCriterion = (recovered.verifiedProgress as { criteria: Array<{ id: string; status: string }> }).criteria[0];
  assert.equal(recoveredCriterion.id, stableId);
  assert.equal(recoveredCriterion.status, "verified");
});

test("complete audit cannot reuse prior progress for an unverified current criterion", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "拒绝矛盾审计", taskContract: { acceptanceCriteria: ["必须重新确认"] }, review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "inconsistent-audit" });
  process.env.FAKE_JOB_DIR = job.directory;
  const first = await executeJob(workspace, job.jobId);
  assert.equal(first.status, "done");
  assert.equal((first.verifiedProgress as { criteria: Array<{ status: string }> }).criteria[0].status, "verified");

  process.env.FAKE_AUDIT_MODE = "inconsistent";
  const rejected = await executeJob(workspace, job.jobId);
  assert.equal(rejected.status, "review_failed");
  assert.match(String(rejected.auditError), /completion=complete.*verified/);
});

test("explicit skipReview keeps the legacy task contract completion path", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "显式跳过审查", taskContract: { acceptanceCriteria: ["保持跳审语义"], stages: [{ name: "implementation", executor: "codebuddy", task: "实现", skipReview: true }] }, review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "skip-structured-audit" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.reviewVerdict, null);
  assert.equal(existsSync(path.join(job.directory, "audit.json")), false);
});

test("adaptive manager executes one stage then deterministically completes", async () => {
  const { workspace } = await setupFake();
  const job = await createAdaptiveJob(workspace, "adaptive-success");
  const promptFile = path.join(workspace, "adaptive-prompts.txt");
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_PROMPT_FILE = promptFile;
  const state = await executeJob(workspace, job.jobId, "operator supplement");
  assert.equal(state.status, "done");
  assert.equal(state.adaptiveRound, 2);
  assert.deepEqual((state.adaptiveRounds as Array<{ action: string }>).map(item => item.action), ["execute", "done"]);
  assert.equal((state.stages as unknown[]).length, 1);
  const context = JSON.parse(await readFile(path.join(job.directory, "context.json"), "utf8"));
  assert.deepEqual(context.adaptive, { enabled: true, maxRounds: 4, managerExecutor: "codebuddy" });
  const prompts = await readFile(promptFile, "utf8");
  assert.match(prompts, /manager-context\.json/);
  assert.doesNotMatch(prompts, /MANAGER_INPUT:/);
  const packs = await Promise.all(["manager", "executor", "auditor"].map(role => readArtifact(workspace, job.jobId, `${role}-context.json`).then(JSON.parse)));
  assert.deepEqual(packs.map(pack => pack.role), ["manager", "executor", "auditor"]);
  for (const pack of packs) {
    assert.equal(pack.projection, true);
    assert.ok(JSON.stringify(pack).length <= CONTEXT_PACK_MAX_CHARS);
    assert.doesNotMatch(JSON.stringify(pack), /agent\.log|MANAGER_INPUT|trajectory/i);
    assert.ok(pack.artifacts.every((artifact: { sha256: string }) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
    assert.deepEqual(parseContextPack(pack), pack);
  }
  assert.equal(packs[0].userInstructions, "operator supplement");
});

test("context packs redact role inputs and strict parsers reject unknown fields", async () => {
  const { workspace } = await setupFake();
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ governance: { redactPatterns: ["SECRET-[A-Z]+"] } }), "utf8");
  const job = await createJob({ workspace, task: "secret context", taskContract: { goal: "use SECRET-TOKEN", acceptanceCriteria: ["safe"] }, testCommand: "node -e \"process.exit(0)\"", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, adaptive: { enabled: true, maxRounds: 2 }, jobId: "context-pack-redaction" });
  process.env.FAKE_JOB_DIR = job.directory;
  assert.equal((await executeJob(workspace, job.jobId, "instruction SECRET-INPUT")).status, "done");
  for (const role of ["manager", "executor", "auditor"]) assert.doesNotMatch(await readArtifact(workspace, job.jobId, `${role}-context.json`), /SECRET-/);
  assert.throws(() => parseContextPack({ version: 1, projection: true, role: "manager", taskContract: null, verifiedProgress: null, audit: null, recentFailure: null, userInstructions: "", artifacts: [], current: { round: 1, maxRounds: 2, remainingRounds: 1 }, history: [] }), /不支持字段/);
  const gate = createHumanGate("needs_input", { questions: ["answer?"] });
  assert.equal(resolveHumanGate(gate, "safe", value => value).status, "resolved");
  assert.throws(() => parseHumanGate({ ...gate, unknown: true }), /不支持字段/);
  assert.throws(() => extendRoundLimit(100, 1), /不能超过 100/);
});

test("adaptive done without evidence is blocked by the existing completion gate", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_MANAGER_ACTIONS = "done";
  const job = await createAdaptiveJob(workspace, "adaptive-no-evidence");
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "verification_gate");
  assert.equal(state.adaptiveRound, 1);
});

test("adaptive done cannot bypass the completion gate through a dormant static skipReview stage", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_MANAGER_ACTIONS = "done";
  const job = await createJob({
    workspace,
    task: "adaptive dormant stage",
    taskContract: {
      goal: "adaptive goal",
      acceptanceCriteria: ["adaptive criterion"],
      stages: [{ name: "dormant", executor: "codebuddy", task: "not executed", skipReview: true }],
    },
    testCommand: "node -e \"process.exit(0)\"",
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    adaptive: { enabled: true, maxRounds: 1 },
    jobId: "adaptive-dormant-skip-review",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "verification_gate");
});

test("adaptive ask and blocked decisions map to explicit needs_fix phases", async () => {
  for (const [action, phase, field] of [["ask", "adaptive_ask", "blockingQuestions"], ["blocked", "adaptive_blocked", "blockedReason"]] as const) {
    const { workspace } = await setupFake();
    process.env.FAKE_MANAGER_ACTIONS = action;
    const job = await createAdaptiveJob(workspace, `adaptive-${action}`);
    process.env.FAKE_JOB_DIR = job.directory;
    const state = await executeJob(workspace, job.jobId);
    assert.equal(state.status, "needs_fix");
    assert.equal(state.phase, phase);
    assert.ok(state[field]);
    assert.equal((state.humanGate as { reason: string; status: string }).reason, "needs_input");
    assert.equal((state.humanGate as { status: string }).status, "waiting");
  }
});

test("adaptive manager rejects invalid decisions and worktree mutation", async () => {
  for (const [action, status, phase] of [["invalid", "needs_fix", "adaptive_manager_decision"], ["mutate", "failed", "adaptive_manager_safety"]] as const) {
    const { workspace } = await setupFake();
    process.env.FAKE_MANAGER_ACTIONS = action;
    if (action === "mutate") spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
    const job = await createAdaptiveJob(workspace, `adaptive-${action}`);
    process.env.FAKE_JOB_DIR = job.directory;
    const state = await executeJob(workspace, job.jobId);
    assert.equal(state.status, status);
    assert.equal(state.phase, phase);
    await assert.rejects(() => readArtifact(workspace, job.jobId, "manager-decision-candidate.json"), /不允许读取/);
  }
});

test("NextAction parser rejects unknown fields, illegal combinations, and empty content", () => {
  assert.throws(() => parseNextAction({ action: "done", reason: "extra" }), /不支持字段/);
  assert.throws(() => parseNextAction({ action: "execute" }), /stage/);
  assert.throws(() => parseNextAction({ action: "ask", questions: [] }), /1 到 20/);
  assert.throws(() => parseNextAction({ action: "blocked", reason: " " }), /非空字符串/);
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
  const completed = await executeJob(workspace, job.jobId, "one more round", undefined, 1);
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
    taskContract: { goal: "adaptive goal", acceptanceCriteria: ["adaptive criterion"] },
    testCommand: "node -e \"process.exit(0)\"",
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
  const worktree = JSON.parse(await readFile(path.join(job.directory, "worktree.json"), "utf8")) as { path: string };
  assert.equal(existsSync(worktree.path), true);
  assert.equal(existsSync(path.join(worktree.path, "fake-change.txt")), true);
  assert.notEqual(paused.worktreeCleaned, true);

  const completed = await executeJob(workspace, job.jobId, "continue");
  assert.equal(completed.status, "done");
  assert.equal(existsSync(worktree.path), false);
  assert.match(await readFile(path.join(job.directory, "complete.patch"), "utf8"), /fake-change\.txt/);
  const result = JSON.parse(await readArtifact(workspace, job.jobId, "result.json"));
  assert.ok(result.changedFiles.includes("fake-change.txt"));
});

test("isolated adaptive maxRounds pause preserves its worktree", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  process.env.FAKE_MANAGER_ACTIONS = "execute";
  const job = await createJob({
    workspace,
    task: "isolated adaptive max rounds",
    taskContract: { goal: "adaptive goal", acceptanceCriteria: ["adaptive criterion"] },
    testCommand: "node -e \"process.exit(0)\"",
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
  const worktree = JSON.parse(await readFile(path.join(job.directory, "worktree.json"), "utf8")) as { path: string };
  assert.equal(existsSync(worktree.path), true);
  assert.equal(existsSync(path.join(worktree.path, "fake-change.txt")), true);
  assert.notEqual(paused.worktreeCleaned, true);
});

test("CLI adaptive flags persist opt-in settings", async () => {
  const { workspace } = await setupFake();
  const result = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "run", "--workspace", workspace, "--task", "cli adaptive", "--review", "--adaptive", "--adaptive-max-rounds", "1", "--manager-executor", "codebuddy", "--approval-before-complete"], { encoding: "utf8", env: { ...process.env, FAKE_JOB_DIR: "" } });
  assert.equal(result.status, 0, result.stderr);
  const jobId = JSON.parse(result.stdout).jobId as string;
  const directory = path.join(workspace, ".cbx", "jobs", jobId);
  const context = JSON.parse(await readFile(path.join(directory, "context.json"), "utf8"));
  assert.deepEqual(context.adaptive, { enabled: true, maxRounds: 1, managerExecutor: "codebuddy" });
  assert.equal(context.approvalBeforeComplete, true);
  const invalidRounds = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "continue", "missing", "--workspace", workspace, "--extra-rounds", "-1", "--foreground"], { encoding: "utf8" });
  assert.notEqual(invalidRounds.status, 0);
  assert.match(invalidRounds.stderr, /--extra-rounds 必须是 0 到 100/);
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
  assert.equal((state.humanGate as { reason: string; status: string }).reason, "needs_input");
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
  assert.equal(existsSync(path.join(job.directory, "audit.json")), false, "non-contract review keeps the legacy flow");
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
  const job = await createJob({ workspace, task: "仅阶段执行器", review: false, isolated: false, executor: "codebuddy", permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "stage-handshake-executor", taskContract: { acceptanceCriteria: ["旧流程验收"], stages: [{ name: "implement", executor: "opencode", task: "实现" }] } });
  process.env.FAKE_JOB_DIR = job.directory;
  try { assert.equal((await executeJob(workspace, job.jobId)).status, "done"); }
  finally {
    process.env.CBX_CODEBUDDY = script;
    delete process.env.CBX_OPENCODE;
  }
  const events = (await readFile(path.join(job.directory, "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.event === "executor_metadata").map(event => event.name), ["opencode", "opencode"]);
  assert.equal(existsSync(path.join(job.directory, "audit.json")), false, "review=false keeps the legacy contract flow");
  assert.equal(JSON.parse(await readArtifact(workspace, job.jobId, "result.json")).acceptanceEvidence[0].status, "evidence_available");
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

test("smart retry separates execution retries from fix retries", async () => {
  const { workspace } = await setupFake();
  const counter = path.join(workspace, "counter.txt");
  process.env.FAKE_COUNTER_FILE = counter;
  process.env.FAKE_EXIT_SEQUENCE = "1,1,0";
  const job = await createJob({ workspace, task: "智能重试", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 2, jobId: "smart-retry" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.attempt, 3);
});

test("dependency guard blocks unauthorized package.json changes", async () => {
  const { workspace } = await setupFake();
  await writeFile(path.join(workspace, "package.json"), '{"name":"test"}', "utf8");
  const job = await createJob({ workspace, task: "依赖守卫", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, dependencyGuard: true, jobId: "dep-guard" });
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_MUTATE_DEP = "1";
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "dependency_guard");
  assert.match(String(state.error), /未经授权修改了依赖文件/);
});

test("dependency guard allows unchanged package.json", async () => {
  const { workspace } = await setupFake();
  await writeFile(path.join(workspace, "package.json"), '{"name":"test"}', "utf8");
  const job = await createJob({ workspace, task: "依赖守卫通过", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, dependencyGuard: true, jobId: "dep-guard-ok" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
});

test("approval gate pauses and resumes a task", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({ workspace, task: "批准", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, approvalBeforeRun: true, jobId: "approval" });
  process.env.FAKE_JOB_DIR = job.directory;
  const waiting = await executeJob(workspace, job.jobId);
  assert.equal(waiting.status, "awaiting_approval");
  assert.deepEqual({ reason: (waiting.humanGate as { reason: string }).reason, status: (waiting.humanGate as { status: string }).status }, { reason: "before_run", status: "waiting" });
  const approved = await approveJob(workspace, job.jobId);
  assert.equal((approved.humanGate as { status: string }).status, "resolved");
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
});

test("completion approval preserves verified isolated work and completes without rerunning stages", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await createJob({ workspace, task: "approve completion", taskContract: { acceptanceCriteria: ["verified"] }, testCommand: "node -e \"process.exit(0)\"", review: true, isolated: true, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, approvalBeforeComplete: true, jobId: "completion-approval" });
  process.env.FAKE_JOB_DIR = job.directory;
  const waiting = await executeJob(workspace, job.jobId);
  assert.equal(waiting.status, "awaiting_approval");
  assert.equal(waiting.phase, "before_complete");
  assert.deepEqual({ reason: (waiting.humanGate as { reason: string }).reason, status: (waiting.humanGate as { status: string }).status }, { reason: "completion", status: "waiting" });
  const worktree = JSON.parse(await readFile(path.join(job.directory, "worktree.json"), "utf8")) as { path: string };
  assert.equal(existsSync(path.join(worktree.path, "fake-change.txt")), true);
  const attempt = waiting.attempt;

  const completed = await approveJob(workspace, job.jobId);
  assert.equal(completed.status, "done");
  assert.equal(completed.attempt, attempt, "完成审批不得重跑已验证 stage");
  assert.equal((completed.humanGate as { status: string }).status, "resolved");
  assert.equal(existsSync(worktree.path), false);
  assert.match(await readFile(path.join(job.directory, "complete.patch"), "utf8"), /fake-change\.txt/);
  await assert.rejects(() => approveJob(workspace, job.jobId), /不需要批准/);
});

test("completion approval rejects stale worktree evidence and keeps work for revalidation", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await createJob({ workspace, task: "stale completion", taskContract: { acceptanceCriteria: ["verified"] }, testCommand: "node -e \"process.exit(0)\"", review: true, isolated: true, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, approvalBeforeComplete: true, jobId: "completion-stale" });
  process.env.FAKE_JOB_DIR = job.directory;
  assert.equal((await executeJob(workspace, job.jobId)).phase, "before_complete");
  const worktree = JSON.parse(await readFile(path.join(job.directory, "worktree.json"), "utf8")) as { path: string };
  await writeFile(path.join(worktree.path, "fake-change.txt"), "changed after review\n", "utf8");
  const stale = await approveJob(workspace, job.jobId);
  assert.equal(stale.status, "needs_fix");
  assert.equal(stale.phase, "completion_evidence_stale");
  assert.equal(existsSync(worktree.path), true);
  await assert.rejects(() => approveJob(workspace, job.jobId), /不需要批准/);
});

test("the same terminal failure opens a Human Gate only at the third occurrence", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_EXIT_SEQUENCE = "1";
  const job = await createJob({ workspace, task: "repeat failure", review: false, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "repeated-failure" });
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
  assert.deepEqual({ reason: (third.humanGate as { reason: string }).reason, status: (third.humanGate as { status: string }).status }, { reason: "repeated_failure", status: "waiting" });
  assert.equal((third.failureTracker as { count: number }).count, 3);
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

test("review failure keeps residual artifacts unverified", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_REVIEW_CONTENT = "VERDICT: FAIL\nexample text\nVERDICT: PASS\n";
  const job = await createJob({ workspace, task: "严格 verdict", taskContract: { acceptanceCriteria: ["审查通过"] }, review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "strict-verdict" });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.reviewVerdict, "FAIL");
  const result = JSON.parse(await readArtifact(workspace, job.jobId, "result.json"));
  assert.deepEqual(result.acceptanceEvidence[0].artifacts, ["complete.patch", "test.log", "review.md"]);
  assert.equal(result.acceptanceEvidence[0].status, "unverified");
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
  assert.equal((state.humanGate as { reason: string }).reason, "semantic_conflict");
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
  const job = await createJob({ workspace, task: "保留父会话上下文", contextSnapshot: "计划：修改核心流程\n约束：不要新增依赖", testCommand: "node -e \"process.exit(0)\"", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "context-snapshot" });
  const promptFile = path.join(workspace, "prompts.txt");
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_PROMPT_FILE = promptFile;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(await readFile(path.join(job.directory, "context-snapshot.md"), "utf8"), "计划：修改核心流程\n约束：不要新增依赖");
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
    const pack = JSON.parse(await readArtifact(workspace, job.jobId, `${role}-context.json`));
    const snapshotRef = pack.artifacts.find((a: { name: string }) => a.name === "context-snapshot.md");
    assert.ok(snapshotRef, `${role} context pack 应包含 context-snapshot.md 的 artifact 引用`);
    assert.equal(snapshotRef.path, snapshotPath);
    assert.match(snapshotRef.sha256, /^[a-f0-9]{64}$/);
  }
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

test("3A.1 context pack redacts sensitive strings from acceptance criteria in all role packs", async () => {
  const { workspace } = await setupFake();
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ governance: { redactPatterns: ["SENSITIVE-\\d+"] } }), "utf8");
  const job = await createJob({ workspace, task: "redact context pack", taskContract: { goal: "test", acceptanceCriteria: ["must not leak SENSITIVE-12345"] }, testCommand: "node -e \"process.exit(0)\"", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, adaptive: { enabled: true, maxRounds: 2 }, jobId: "pack-redaction" });
  const promptFile = path.join(workspace, "pack-prompts.txt");
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_PROMPT_FILE = promptFile;
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
  for (const role of ["manager", "executor", "auditor"] as const) {
    const pack = JSON.parse(await readArtifact(workspace, job.jobId, `${role}-context.json`));
    const serialized = JSON.stringify(pack);
    assert.doesNotMatch(serialized, /SENSITIVE-12345/);
    assert.ok(serialized.length <= CONTEXT_PACK_MAX_CHARS, `${role} pack 超过 ${CONTEXT_PACK_MAX_CHARS} 字符上限`);
    assert.doesNotThrow(() => parseContextPack(pack), `${role} pack 格式无效`);
  }
  const prompts = await readFile(promptFile, "utf8");
  assert.doesNotMatch(prompts, /SENSITIVE-12345/);
});

test("3A.3 background before_complete approval resolves queue entry to done without lingering awaiting_approval", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await createJob({ workspace, task: "bg approve completion", taskContract: { acceptanceCriteria: ["verified"] }, testCommand: "node -e \"process.exit(0)\"", review: true, isolated: true, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, approvalBeforeComplete: true, autoCommit: true, jobId: "bg-completion-approval" });
  process.env.FAKE_JOB_DIR = job.directory;
  await startBackground(workspace, job.jobId);
  // 等待 job 到达 before_complete
  const deadline = Date.now() + 10_000;
  let state: JobState;
  while (Date.now() < deadline) {
    state = await loadState(workspace, job.jobId);
    if (state.status === "awaiting_approval") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  state = await loadState(workspace, job.jobId);
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.phase, "before_complete");
  const entry = (await listQueue(workspace)).entries.find(item => item.jobId === job.jobId);
  assert.equal(entry?.status, "awaiting_approval");
  assert.equal(entry?.pid, undefined);
  // 等待 executeJob 释放 run.lock（approveJob 需要获取同一锁）
  const approveDeadline = Date.now() + 5_000;
  let completed: JobState | undefined;
  while (Date.now() < approveDeadline) {
    try { completed = await approveJob(workspace, job.jobId); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(completed, "approveJob 应在超时前成功");
  assert.equal(completed!.status, "done");
  assert.equal((completed!.humanGate as { status: string }).status, "resolved");
  // 队列中对应 entry 应为 done，无遗留 awaiting_approval
  const afterQueue = (await listQueue(workspace)).entries.filter(item => item.jobId === job.jobId);
  assert.equal(afterQueue.length, 1);
  assert.equal(afterQueue[0].status, "done");
});

test("3A.4 completion approval with autoCommit failure preserves worktree and verified changes", async () => {
  const { workspace } = await setupFake();
  // 初始化 git 仓库；用空 GIT_AUTHOR_NAME/COMMITTER_NAME 让 approve 阶段的 git commit 失败
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial", "--author=CBX Test <cbx@example.test>"], { cwd: workspace, encoding: "utf8" });
  const job = await createJob({ workspace, task: "commit fail", taskContract: { acceptanceCriteria: ["verified"] }, testCommand: "node -e \"process.exit(0)\"", review: true, isolated: true, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, approvalBeforeComplete: true, autoCommit: true, jobId: "commit-fail-preserve" });
  process.env.FAKE_JOB_DIR = job.directory;
  const waiting = await executeJob(workspace, job.jobId);
  assert.equal(waiting.phase, "before_complete");
  const worktree = JSON.parse(await readFile(path.join(job.directory, "worktree.json"), "utf8")) as { path: string };
  assert.equal(existsSync(path.join(worktree.path, "fake-change.txt")), true);
  const previousAuthor = process.env.GIT_AUTHOR_NAME;
  const previousCommitter = process.env.GIT_COMMITTER_NAME;
  process.env.GIT_AUTHOR_NAME = "";
  process.env.GIT_COMMITTER_NAME = "";
  let failed: JobState;
  try {
    failed = await approveJob(workspace, job.jobId);
  } finally {
    if (previousAuthor === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = previousAuthor;
    if (previousCommitter === undefined) delete process.env.GIT_COMMITTER_NAME; else process.env.GIT_COMMITTER_NAME = previousCommitter;
  }
  assert.equal(failed.status, "failed");
  assert.equal(failed.phase, "git_commit");
  // worktree 和已验证修改仍保留（approveJobLocked 的 commit 失败分支不清 worktree）
  assert.equal(existsSync(worktree.path), true);
  assert.equal(existsSync(path.join(worktree.path, "fake-change.txt")), true);
});

test("3A.5 verification_gate repeated failure triggers human gate at third occurrence", async () => {
  const { workspace } = await setupFake();
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");
  // 构造一个每次执行都会失败的任务 ✓ 但通过 verification_gate 触发，而非 executor 失败
  // 让 fake agent 正常完成，但测试命令失败，使 finish 中 verification_gate 拦截
  process.env.FAKE_EXIT_SEQUENCE = "0";
  const job = await createJob({ workspace, task: "verification repeat", taskContract: { acceptanceCriteria: ["must-pass"] }, testCommand: "node -e \"process.exit(1)\"", review: true, isolated: false, permissionMode: "auto", maxTurns: 10, timeoutMs: 2_000, maxRetries: 0, jobId: "verification-repeat" });
  process.env.FAKE_JOB_DIR = job.directory;
  // 第一次：测试失败 → needs_fix
  const first = await executeJob(workspace, job.jobId);
  assert.equal(first.status, "needs_fix");
  // 检查 failureTracker 计数
  // verification_gate 不应被排除在 repeated_failure 统计之外
  // 第一次失败 count=1，第二次 count=2，第三次 count=3 → humanGate
  for (let i = 0; i < 2; i++) {
    process.env.FAKE_JOB_DIR = job.directory;
    const state = await executeJob(workspace, job.jobId);
    if (i === 0) {
      assert.equal(state.humanGate, undefined, "第二次失败不应触发 humanGate");
    } else {
      assert.equal(state.phase, "repeated_failure");
      assert.equal((state.humanGate as { reason: string }).reason, "repeated_failure");
      assert.equal((state.failureTracker as { count: number }).count, 3);
    }
  }
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
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ approval: { beforeRun: true, beforeComplete: true } }), "utf8");
  assert.deepEqual((await loadConfig(workspace)).approval, { beforeRun: true, beforeComplete: true });
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ approval: { beforeComplete: "yes" } }), "utf8");
  await assert.rejects(() => loadConfig(workspace), /approval\.beforeComplete/);
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ notifications: { timeoutMs: 10 } }), "utf8");
  await assert.rejects(() => loadConfig(workspace), /notifications\.timeoutMs/);
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ governance: { unknown: true } }), "utf8");
  await assert.rejects(() => loadConfig(workspace), /governance 不支持字段/);
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ adaptive: { enabled: true, maxRounds: 3, managerExecutor: "opencode" } }), "utf8");
  assert.deepEqual((await loadConfig(workspace)).adaptive, { enabled: true, maxRounds: 3, managerExecutor: "opencode" });
  for (const [adaptive, error] of [[{ unknown: true }, /adaptive 不支持字段/], [{ enabled: "yes" }, /adaptive\.enabled/], [{ maxRounds: 0 }, /adaptive\.maxRounds/], [{ managerExecutor: "" }, /adaptive\.managerExecutor/]] as const) {
    await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ adaptive }), "utf8");
    await assert.rejects(() => loadConfig(workspace), error);
  }
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
