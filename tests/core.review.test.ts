import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  setupFake,
  createJob,
  executeJob,
  loadConfig,
  readArtifact,
  runReviewGate,
  stopReviewGateHook,
} from "./helpers.js";

test("runReviewGate skips when there are no uncommitted changes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-gate-skip-"));
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
  const result = await runReviewGate(workspace, {
    executor: "codebuddy",
    timeoutMs: 5_000,
  });
  assert.equal(result.pass, true);
  assert.equal(result.verdict, "SKIP");
});

test("runReviewGate returns PASS verdict from executor for uncommitted changes", async () => {
  const { workspace, script } = await setupFake();
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
  await writeFile(path.join(workspace, "README.md"), "changed\n", "utf8");
  process.env.FAKE_REVIEW_VERDICT = "PASS";
  const result = await runReviewGate(workspace, {
    executor: "codebuddy",
    timeoutMs: 10_000,
  });
  assert.equal(result.pass, true);
  assert.equal(result.verdict, "PASS");
});

test("runReviewGate returns FAIL verdict from executor and block decision", async () => {
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
  await writeFile(path.join(workspace, "README.md"), "dangerous\n", "utf8");
  process.env.FAKE_REVIEW_VERDICT = "FAIL";
  process.env.FAKE_REVIEW_CONTENT = "VERDICT: FAIL\n\n# 问题\n\n- 引入危险模式";
  const result = await runReviewGate(workspace, {
    executor: "codebuddy",
    timeoutMs: 10_000,
  });
  assert.equal(result.pass, false);
  assert.equal(result.verdict, "FAIL");
  assert.match(result.reason, /引入危险模式/);
});

test("stopReviewGateHook returns null when reviewGate disabled (fail-open default)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-gate-off-"));
  spawnSync("git", ["init", "-b", "main"], {
    cwd: workspace,
    encoding: "utf8",
  });
  await writeFile(path.join(workspace, "README.md"), "x\n", "utf8");
  const decision = await stopReviewGateHook(workspace);
  assert.equal(decision, null);
});

test("stopReviewGateHook returns null when reviewGate enabled but no changes", async () => {
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
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ reviewGate: { enabled: true } }),
    "utf8",
  );
  const decision = await stopReviewGateHook(workspace);
  assert.equal(decision, null);
});

test("reviewGate config field is accepted and rejects unknown nested keys", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-gate-config-"));
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ reviewGate: { enabled: true } }),
    "utf8",
  );
  const config = await loadConfig(workspace);
  assert.equal(config.reviewGate?.enabled, true);
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ reviewGate: { unknown: 1 } }),
    "utf8",
  );
  await assert.rejects(
    () => loadConfig(workspace),
    /reviewGate 不支持字段：unknown/,
  );
});

test("stopReviewGateHook fail-open 放行当 .cbx.json 非法（loadConfig 抛异常不逃逸）", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-gate-bad-config-"),
  );
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ reviewGate: { unknown: 1 } }),
    "utf8",
  );
  const decision = await stopReviewGateHook(workspace);
  assert.equal(decision, null);
});

test("multi-stage chain runs each stage with its own executor and accumulates stage reports", async () => {
  const { workspace, script } = await setupFake();
  process.env.CBX_OPENCODE = script;
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
    task: "多阶段任务",
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "staged",
    taskContract: {
      goal: "接力链",
      stages: [
        { name: "scaffold", executor: "codebuddy", task: "搭骨架" },
        { name: "implement", executor: "opencode", task: "填实现" },
        { name: "x/../evil", executor: "codebuddy", task: "t3" },
      ],
    },
  });
  process.env.FAKE_JOB_DIR = job.directory;
  let state: { status: string; stages?: unknown[] };
  try {
    state = await executeJob(workspace, job.jobId);
  } finally {
    delete process.env.CBX_OPENCODE;
  }
  assert.equal(state.status, "done");
  // result.json 应包含 stages 数组，每 stage 记录 executor 和 verdict
  const result = JSON.parse(
    await readArtifact(workspace, job.jobId, "result.json"),
  );
  assert.ok(
    Array.isArray(result.stages),
    "result.json should have stages array",
  );
  assert.equal(result.stages.length, 3);
  assert.equal(result.stages[0].name, "scaffold");
  assert.equal(result.stages[0].executor, "codebuddy");
  assert.equal(result.stages[1].name, "implement");
  assert.equal(result.stages[1].executor, "opencode");
  // 每 stage 应有独立的 handback 副本
  assert.ok(
    existsSync(path.join(job.directory, "stage-0-scaffold-handback.md")),
    "stage-0 handback copy should exist",
  );
  assert.ok(
    existsSync(path.join(job.directory, "stage-1-implement-handback.md")),
    "stage-1 handback copy should exist",
  );
  // 恶意 stage name（含路径分隔符）必须被清洗，副本落在 job 目录内，不得路径穿越
  assert.ok(
    existsSync(path.join(job.directory, "stage-2-x-..-evil-handback.md")),
    "hostile stage name should be sanitized",
  );
  // 事件流应有 stage_started / stage_finished
  const events = await readFile(
    path.join(job.directory, "events.ndjson"),
    "utf8",
  );
  assert.match(events, /"event":"stage_started"/);
  assert.match(events, /"event":"stage_finished"/);
});

test("normalizeTaskContract rejects invalid stages and accepts valid ones", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-"));
  // 空 stages 数组应拒绝
  await assert.rejects(
    () =>
      createJob({
        workspace,
        task: "test",
        review: false,
        isolated: false,
        permissionMode: "auto",
        maxTurns: 5,
        jobId: "bad-empty",
        taskContract: { stages: [] },
      }),
    /stages 必须是非空数组/,
  );
  // 缺少 executor 应拒绝
  await assert.rejects(
    () =>
      createJob({
        workspace,
        task: "test",
        review: false,
        isolated: false,
        permissionMode: "auto",
        maxTurns: 5,
        jobId: "bad-noexec",
        taskContract: {
          stages: [{ name: "s1", task: "do" }] as unknown as {
            name: string;
            executor: string;
            task: string;
          }[],
        },
      }),
    /executor 必须是非空字符串/,
  );
  // 合法 stages 应持久化到 context-contract.json
  const job = await createJob({
    workspace,
    task: "test",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "good-stages",
    taskContract: {
      stages: [{ name: "s1", executor: "codebuddy", task: "do something" }],
    },
  });
  const contract = JSON.parse(
    await readFile(path.join(job.directory, "context-contract.json"), "utf8"),
  );
  assert.equal(contract.stages[0].name, "s1");
  assert.equal(contract.stages[0].executor, "codebuddy");
});
