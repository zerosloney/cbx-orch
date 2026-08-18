import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  setupFake,
  initializeGitWorkspace,
  approveJob,
  createJob,
  executeJob,
  listQueue,
  loadState,
  readArtifact,
  startBackground,
  CONTEXT_PACK_MAX_CHARS,
  parseContextPack,
  type JobState,
} from "./helpers.js";

test("cbx_continue with empty snapshot deletes existing context-snapshot.md", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-continue-delete-"),
  );
  const job = await createJob({
    workspace,
    task: "待清空",
    contextSnapshot: "将删除",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 1,
    jobId: "continue-delete",
  });
  assert.equal(
    existsSync(path.join(job.directory, "context-snapshot.md")),
    true,
  );
  await startBackground(workspace, job.jobId, "修复", 0, "");
  assert.equal(
    existsSync(path.join(job.directory, "context-snapshot.md")),
    false,
  );
});

test("3A.1 context pack redacts sensitive strings from acceptance criteria in all role packs", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ governance: { redactPatterns: ["SENSITIVE-\\d+"] } }),
    "utf8",
  );
  const job = await createJob({
    workspace,
    task: "redact context pack",
    taskContract: {
      goal: "test",
      acceptanceCriteria: ["must not leak SENSITIVE-12345"],
    },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    adaptive: { enabled: true, maxRounds: 2 },
    jobId: "pack-redaction",
  });
  const promptFile = path.join(workspace, "pack-prompts.txt");
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_PROMPT_FILE = promptFile;
  assert.equal((await executeJob(workspace, job.jobId)).status, "done");
  for (const role of ["manager", "executor", "auditor"] as const) {
    const pack = JSON.parse(
      await readArtifact(workspace, job.jobId, `${role}-context.json`),
    );
    const serialized = JSON.stringify(pack);
    assert.doesNotMatch(serialized, /SENSITIVE-12345/);
    assert.ok(
      serialized.length <= CONTEXT_PACK_MAX_CHARS,
      `${role} pack 超过 ${CONTEXT_PACK_MAX_CHARS} 字符上限`,
    );
    assert.doesNotThrow(() => parseContextPack(pack), `${role} pack 格式无效`);
  }
  const prompts = await readFile(promptFile, "utf8");
  assert.doesNotMatch(prompts, /SENSITIVE-12345/);
});

test("3A.3 background before_complete approval resolves queue entry to done without lingering awaiting_approval", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await createJob({
    workspace,
    task: "bg approve completion",
    taskContract: { acceptanceCriteria: ["verified"] },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 10_000,
    maxRetries: 0,
    approvalBeforeComplete: true,
    autoCommit: true,
    jobId: "bg-completion-approval",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  await startBackground(workspace, job.jobId);
  // 等待 job 到达 before_complete
  const deadline = Date.now() + 20_000;
  let state: JobState;
  while (Date.now() < deadline) {
    state = await loadState(workspace, job.jobId);
    if (state.status === "awaiting_approval") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  state = await loadState(workspace, job.jobId);
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.phase, "before_complete");
  const entry = (await listQueue(workspace)).entries.find(
    (item) => item.jobId === job.jobId,
  );
  assert.equal(entry?.status, "awaiting_approval");
  assert.equal(entry?.pid, undefined);
  // 等待 executeJob 释放 run.lock（approveJob 需要获取同一锁）
  const approveDeadline = Date.now() + 20_000;
  let completed: JobState | undefined;
  while (Date.now() < approveDeadline) {
    try {
      completed = await approveJob(workspace, job.jobId);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.ok(completed, "approveJob 应在超时前成功");
  assert.equal(completed!.status, "done");
  assert.equal((completed!.humanGate as { status: string }).status, "resolved");
  // 队列中对应 entry 应为 done，无遗留 awaiting_approval
  const afterQueue = (await listQueue(workspace)).entries.filter(
    (item) => item.jobId === job.jobId,
  );
  assert.equal(afterQueue.length, 1);
  assert.equal(afterQueue[0].status, "done");
});

test("3A.4 completion approval with autoCommit failure preserves worktree and verified changes", async () => {
  const { workspace } = await setupFake();
  // 初始化 git 仓库；用空 GIT_AUTHOR_NAME/COMMITTER_NAME 让 approve 阶段的 git commit 失败
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
  spawnSync(
    "git",
    ["commit", "-m", "initial", "--author=CBX Test <cbx@example.test>"],
    { cwd: workspace, encoding: "utf8" },
  );
  const job = await createJob({
    workspace,
    task: "commit fail",
    taskContract: { acceptanceCriteria: ["verified"] },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    approvalBeforeComplete: true,
    autoCommit: true,
    jobId: "commit-fail-preserve",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const waiting = await executeJob(workspace, job.jobId);
  assert.equal(waiting.phase, "before_complete");
  const worktree = JSON.parse(
    await readFile(path.join(job.directory, "worktree.json"), "utf8"),
  ) as { path: string };
  assert.equal(existsSync(path.join(worktree.path, "fake-change.txt")), true);
  const previousAuthor = process.env.GIT_AUTHOR_NAME;
  const previousCommitter = process.env.GIT_COMMITTER_NAME;
  process.env.GIT_AUTHOR_NAME = "";
  process.env.GIT_COMMITTER_NAME = "";
  let failed: JobState;
  try {
    failed = await approveJob(workspace, job.jobId);
  } finally {
    if (previousAuthor === undefined) delete process.env.GIT_AUTHOR_NAME;
    else process.env.GIT_AUTHOR_NAME = previousAuthor;
    if (previousCommitter === undefined) delete process.env.GIT_COMMITTER_NAME;
    else process.env.GIT_COMMITTER_NAME = previousCommitter;
  }
  assert.equal(failed.status, "failed");
  assert.equal(failed.phase, "git_commit");
  // worktree 和已验证修改仍保留（approveJobLocked 的 commit 失败分支不清 worktree）
  assert.equal(existsSync(worktree.path), true);
  assert.equal(existsSync(path.join(worktree.path, "fake-change.txt")), true);
});

test("3A.5 verification_gate repeated failure triggers human gate at third occurrence", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ maxConcurrent: 1 }),
    "utf8",
  );
  // 构造一个每次执行都会失败的任务 ✓ 但通过 verification_gate 触发，而非 executor 失败
  // 让 fake agent 正常完成，但测试命令失败，使 finish 中 verification_gate 拦截
  process.env.FAKE_EXIT_SEQUENCE = "0";
  const job = await createJob({
    workspace,
    task: "verification repeat",
    taskContract: { acceptanceCriteria: ["must-pass"] },
    testCommand: 'node -e "process.exit(1)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "verification-repeat",
  });
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
      assert.equal(
        (state.humanGate as { reason: string }).reason,
        "repeated_failure",
      );
      assert.equal((state.failureTracker as { count: number }).count, 3);
    }
  }
});

test("governance redaction scrubs context snapshot by key name and regex pattern", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-redact-snapshot-"),
  );
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      governance: {
        redactFields: ["token", "api_key"],
        redactPatterns: ["sk-[a-zA-Z0-9]{6,}"],
      },
    }),
    "utf8",
  );
  const snapshot =
    "## 计划\n\nToken: secret-value-123\n- api_key: sk-internal\n使用 sk-abcdef123456 调用上游\n保留这行普通文本";
  const job = await createJob({
    workspace,
    task: "带敏感上下文",
    contextSnapshot: snapshot,
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 1,
    jobId: "redact-snapshot",
  });
  const persisted = await readFile(
    path.join(job.directory, "context-snapshot.md"),
    "utf8",
  );
  assert.doesNotMatch(
    persisted,
    /secret-value-123|sk-internal|sk-abcdef123456/,
  );
  assert.match(persisted, /\[REDACTED\]/);
  assert.match(persisted, /## 计划/);
  assert.match(persisted, /保留这行普通文本/);
});
