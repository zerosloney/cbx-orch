import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createJob,
  executeJob,
  initializeGitWorkspace,
  setupFake,
} from "./helpers.js";

// stage-runner.ts 未覆盖区段：验收失败重试（fix retry）→ 终态 needs_fix、
// 验收超时分支、无 review 请求时的 skipReview 收尾路径。

test("stage: 验收失败消耗 fix retry 后转 needs_fix 终态", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "fix retry 覆盖",
    testCommand: 'node -e "process.exit(1)"',
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 1,
    jobId: "stage-fix-retry",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const result = await executeJob(workspace, job.jobId);
  assert.equal(result.status, "needs_fix");
  assert.ok(result.error?.includes("验收命令失败"));
});

test("stage: 验收重试预算耗尽直接 needs_fix", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "无重试覆盖",
    testCommand: 'node -e "process.exit(2)"',
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "stage-no-retry",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const result = await executeJob(workspace, job.jobId);
  assert.equal(result.status, "needs_fix");
});

test("stage: 验收命令超时走 timedOut 分支", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "验收超时覆盖",
    testCommand: 'node -e "setTimeout(console.log, 8000)"',
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 1_000,
    maxRetries: 0,
    jobId: "stage-test-timeout",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const result = await executeJob(workspace, job.jobId);
  assert.equal(result.status, "needs_fix");
  assert.ok(result.error?.includes("验收命令超时"));
});

test("stage: review=false 验收通过走 skipReview 收尾", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "skip review 覆盖",
    testCommand: 'node -e "process.exit(0)"',
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "stage-skip-review",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const result = await executeJob(workspace, job.jobId);
  assert.equal(result.status, "done");
});

test("stage: reviewer 修改工作区触发 review_failed 终止", async () => {
  const { workspace } = await setupFake();
  // 快照比对依赖 git status（未跟踪文件检测），workspace 必须是 git 仓库
  await initializeGitWorkspace(workspace);
  const job = await createJob({
    workspace,
    task: "reviewer 改动覆盖",
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "stage-review-mutate",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_REVIEW_MUTATE = "1";
  try {
    const result = await executeJob(workspace, job.jobId);
    assert.equal(result.status, "review_failed");
    assert.ok(result.error?.includes("审查代理修改了工作区"));
  } finally {
    delete process.env.FAKE_REVIEW_MUTATE;
  }
});

test("stage: review 代理退出非零（重试预算耗尽）转 review_failed", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "review 失败覆盖",
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "stage-review-fail",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  // 退出序列按共享计数器推进：实现(0) → review(1) 触发 fix retry → 实现(0) → review(1) 预算耗尽 → review_failed
  process.env.FAKE_COUNTER_FILE = path.join(workspace, "exit-counter.txt");
  process.env.FAKE_EXIT_SEQUENCE = "0,1,0,1";
  try {
    const result = await executeJob(workspace, job.jobId);
    assert.equal(result.status, "review_failed");
  } finally {
    process.env.FAKE_EXIT_SEQUENCE = "0";
    delete process.env.FAKE_COUNTER_FILE;
  }
});
