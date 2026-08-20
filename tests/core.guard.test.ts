import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setupFake,
  createJob,
  executeJob,
  listQueue,
  loadState,
  pauseQueue,
  readArtifact,
  retryQueueJob,
  startBackground,
} from "./helpers.js";
import { loadJobContext } from "../src/context-schema.js";

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

test("a concurrent queue tx lock surfaces E_QUEUE_BUSY", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-tx-busy-"));
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  const { database: getDb } = await import("../src/storage.js");
  const cachedDb = await getDb(workspace);
  cachedDb.pragma("busy_timeout = 200");
  const { default: Database } = await import("better-sqlite3");
  const holdDb = new Database(path.join(workspace, ".cbx", "state.sqlite"));
  holdDb.pragma("busy_timeout = 100");
  holdDb.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(
      () => pauseQueue(workspace),
      /队列正在被另一个调度器更新/,
    );
  } finally {
    holdDb.exec("ROLLBACK");
    holdDb.close();
    cachedDb.pragma("busy_timeout = 5000");
  }
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

test("retryQueueJob rejects jobs waiting for approval", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-retry-approval-"),
  );
  const job = await createJob({
    workspace,
    task: "审批中的任务不能重试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    approvalBeforeRun: true,
    jobId: "retry-approval",
  });
  assert.equal(
    (await executeJob(workspace, job.jobId)).status,
    "awaiting_approval",
  );
  await assert.rejects(() => retryQueueJob(workspace, job.jobId), /等待审批/);
  assert.equal(
    (await loadState(workspace, job.jobId)).status,
    "awaiting_approval",
  );
});

test("createJob rejects blank tasks and fractional maxTurns", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-job-input-"));
  const base = {
    workspace,
    review: false,
    isolated: false,
    permissionMode: "auto",
  } as const;
  await assert.rejects(
    () => createJob({ ...base, task: " \n\t", maxTurns: 5 }),
    /task 必须是非空字符串/,
  );
  await assert.rejects(
    () => createJob({ ...base, task: "整数校验", maxTurns: 1.5 }),
    /maxTurns 必须是正整数/,
  );
});

test("execution profiles reject invalid combinations before job persistence", async () => {
  const { workspace } = await setupFake();
  const base = {
    workspace,
    task: "profile validation",
    review: true,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 5,
    testCommand: "npm test",
  } as const;
  const rejects = [
    {
      jobId: "profile-verified-no-test",
      options: { profile: "verified" as const, testCommand: undefined },
      message: /verified profile 要求 testCommand 非空/,
    },
    {
      jobId: "profile-verified-no-isolation",
      options: { profile: "verified" as const, isolated: false },
      message: /verified profile 要求 isolated=true/,
    },
    {
      jobId: "profile-verified-no-review",
      options: { profile: "verified" as const, review: false },
      message: /verified profile 要求 review=true/,
    },
    {
      jobId: "profile-governed-no-dependency-guard",
      options: {
        profile: "governed" as const,
        dependencyGuard: false,
        approvalBeforeComplete: true,
      },
      message: /governed profile 要求 dependencyGuard=true/,
    },
    {
      jobId: "profile-governed-no-approval",
      options: {
        profile: "governed" as const,
        dependencyGuard: true,
        approvalBeforeComplete: false,
      },
      message: /governed profile 要求 approvalBeforeComplete=true/,
    },
    {
      jobId: "profile-untrusted-mismatch",
      options: {
        profile: "untrusted" as const,
        dependencyGuard: true,
        approvalBeforeComplete: true,
        trustMode: "trusted" as const,
      },
      message: /untrusted profile 要求 trustMode=untrusted/,
    },
  ];
  for (const item of rejects) {
    await assert.rejects(
      () => createJob({ ...base, ...item.options, jobId: item.jobId }),
      item.message,
    );
    assert.equal(
      existsSync(path.join(workspace, ".cbx", "jobs", item.jobId)),
      false,
      `${item.jobId} 不应创建任务目录`,
    );
  }
});

test("valid execution profile is persisted and legacy context remains loadable", async () => {
  const { workspace } = await setupFake();
  const profiled = await createJob({
    workspace,
    task: "profile persistence",
    testCommand: "npm test",
    review: true,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 5,
    profile: "verified",
    jobId: "profile-persisted",
  });
  const persisted = JSON.parse(
    await readFile(path.join(profiled.directory, "context.json"), "utf8"),
  ) as { profile?: string };
  assert.equal(persisted.profile, "verified");
  assert.equal((await loadJobContext(profiled.directory)).profile, "verified");

  const legacy = await createJob({
    workspace,
    task: "legacy context",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "profile-legacy",
  });
  const legacyContext = await loadJobContext(legacy.directory);
  assert.equal(legacyContext.profile, undefined);
});

test("context schema rejects an unknown execution profile", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "invalid context profile",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "profile-invalid-context",
  });
  const contextFile = path.join(job.directory, "context.json");
  const context = JSON.parse(await readFile(contextFile, "utf8"));
  await writeFile(
    contextFile,
    JSON.stringify({ ...context, profile: "strict" }),
    "utf8",
  );
  await assert.rejects(
    () => loadJobContext(job.directory),
    /context\.json 无效：profile 缺省或为 fast\/verified\/governed\/untrusted。/,
  );
});
