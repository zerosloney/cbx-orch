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

test("end-to-end success runs fake agent, test, and review", async () => {
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
    task: "实现功能",
    taskContract: { acceptanceCriteria: ["验收通过"] },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "success",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.reviewVerdict, "PASS");
  assert.equal(
    (await readFile(path.join(job.directory, "handback.md"), "utf8")).trim(),
    "fake handback",
  );
  const events = await readFile(
    path.join(job.directory, "events.ndjson"),
    "utf8",
  );
  assert.ok(events.includes("process_finished"));
  assert.match(events, /"event":"executor_metadata","source":"builtin"/);
  assert.ok(
    (
      await readFile(path.join(job.directory, "complete.patch"), "utf8")
    ).includes("fake-change.txt"),
  );
  const result = JSON.parse(
    await readArtifact(workspace, job.jobId, "result.json"),
  );
  assert.equal(result.status, "done");
  assert.ok(result.changedFiles.includes("fake-change.txt"));
  assert.equal(result.handback.trim(), "fake handback");
  assert.match(result.artifactHashes["complete.patch"], /^[a-f0-9]{64}$/);
  assert.equal(result.acceptanceEvidence[0].status, "evidence_available");
  assert.equal(result.audit.completion, "complete");
  assert.equal(result.audit.cleanliness, "clean");
  assert.equal(result.audit.alignment, "aligned");
  assert.match(
    result.verifiedProgress.criteria[0].id,
    /^criterion-[a-f0-9]{16}$/,
  );
  assert.equal(result.verifiedProgress.criteria[0].status, "verified");
  assert.match(
    result.verifiedProgress.criteria[0].evidence[0].sha256,
    /^[a-f0-9]{64}$/,
  );
  assert.deepEqual(
    JSON.parse(await readArtifact(workspace, job.jobId, "audit.json")),
    result.audit,
  );
  assert.deepEqual(
    JSON.parse(
      await readArtifact(workspace, job.jobId, "verified-progress.json"),
    ),
    result.verifiedProgress,
  );
});

test("structured audit preserves partial criterion progress but blocks completion", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_AUDIT_MODE = "partial";
  const job = await createJob({
    workspace,
    task: "部分完成",
    taskContract: { acceptanceCriteria: ["标准 A", "标准 B"] },
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "partial-audit",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "verification_gate");
  const result = JSON.parse(
    await readArtifact(workspace, job.jobId, "result.json"),
  );
  assert.deepEqual(
    result.verifiedProgress.criteria.map(
      (item: { status: string }) => item.status,
    ),
    ["verified", "unverified"],
  );
  assert.deepEqual(
    result.acceptanceEvidence.map((item: { status: string }) => item.status),
    ["unverified", "unverified"],
  );
});

test("structured audit rejects evidence paths outside the safe artifact set", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_AUDIT_UNSAFE = "1";
  const job = await createJob({
    workspace,
    task: "非法证据",
    taskContract: { acceptanceCriteria: ["安全引用"] },
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "unsafe-audit",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "review_failed");
  assert.match(String(state.auditError), /不允许或不存在的产物/);
  await assert.rejects(
    () => readArtifact(workspace, job.jobId, "audit-candidate.json"),
    /不允许读取/,
  );
});

test("verified progress invalidates changed evidence and recovers with fresh audit", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "证据恢复",
    taskContract: { acceptanceCriteria: ["结果可信"] },
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "progress-recovery",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const first = await executeJob(workspace, job.jobId);
  assert.equal(first.status, "done");
  const stableId = (
    first.verifiedProgress as { criteria: Array<{ id: string }> }
  ).criteria[0].id;

  await writeFile(
    path.join(job.directory, "test.log"),
    "tampered evidence\n",
    "utf8",
  );
  process.env.FAKE_EXIT_SEQUENCE = "1";
  const failed = await executeJob(workspace, job.jobId);
  assert.equal(failed.status, "failed");
  assert.equal(
    (failed.verifiedProgress as { criteria: Array<{ status: string }> })
      .criteria[0].status,
    "invalidated",
  );

  process.env.FAKE_EXIT_SEQUENCE = "0";
  const recovered = await executeJob(workspace, job.jobId);
  assert.equal(recovered.status, "done");
  const recoveredCriterion = (
    recovered.verifiedProgress as {
      criteria: Array<{ id: string; status: string }>;
    }
  ).criteria[0];
  assert.equal(recoveredCriterion.id, stableId);
  assert.equal(recoveredCriterion.status, "verified");
});

test("complete audit cannot reuse prior progress for an unverified current criterion", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "拒绝矛盾审计",
    taskContract: { acceptanceCriteria: ["必须重新确认"] },
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "inconsistent-audit",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const first = await executeJob(workspace, job.jobId);
  assert.equal(first.status, "done");
  assert.equal(
    (first.verifiedProgress as { criteria: Array<{ status: string }> })
      .criteria[0].status,
    "verified",
  );

  process.env.FAKE_AUDIT_MODE = "inconsistent";
  const rejected = await executeJob(workspace, job.jobId);
  assert.equal(rejected.status, "review_failed");
  assert.match(String(rejected.auditError), /completion=complete.*verified/);
});
