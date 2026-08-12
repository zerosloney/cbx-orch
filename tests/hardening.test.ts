import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJob, enqueueJob, readArtifact, cancelJobState, listQueue } from "../src/core.js";
import { parseCliArgs } from "../src/cli-args.js";
import { CbxError, isCbxError } from "../src/errors.js";
import {
  constantTimeEqual,
  loadJobContext,
  loadPersistedQueue,
  now,
  queueLockFile,
  redactText,
  savePersistedQueue,
  staleLock,
  updateJobContext,
  withFileLock,
  withQueueLock,
} from "../src/storage.js";
import { assertJobId, normalizeJobId } from "../src/validation.js";
import { snapshotDiff } from "../src/git-ops.js";
import { capture, captureAsync } from "../src/process-runner.js";

// ---- 统一 CLI 解析：位置参数与选项不再互相干扰 ----

test("parseCliArgs separates positionals from options regardless of order", () => {
  const parsed = parseCliArgs(["--workspace", "/tmp/ws", "job1", "--ci"]);
  assert.deepEqual(parsed.positionals, ["job1"]);
  assert.equal(parsed.option("--workspace"), "/tmp/ws");
  assert.equal(parsed.has("--ci"), true);
  assert.equal(parsed.has("--review"), false);
  assert.equal(parsed.option("--missing", "fallback"), "fallback");
});

test("parseCliArgs supports --name=value, repeated options and the -- separator", () => {
  const parsed = parseCliArgs([
    "--workspace=A",
    "--workspace",
    "B",
    "--",
    "--not-a-flag",
  ]);
  assert.equal(parsed.option("--workspace"), "A");
  assert.deepEqual(parsed.all("--workspace"), ["A", "B"]);
  assert.deepEqual(parsed.positionals, ["--not-a-flag"]);
  assert.throws(() => parseCliArgs(["--task"]), /缺少值/);
});

test("CLI review preserves non-missing review.md read errors", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-review-error-"));
  const job = await createJob({
    workspace,
    task: "CLI review error",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "cli-review-error",
  });
  await mkdir(path.join(job.directory, "review.md"));
  const cliPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "cli.js",
  );
  const result = spawnSync(
    process.execPath,
    [cliPath, "review", job.jobId, "--workspace", workspace],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /尚无 review\.md/);
  assert.match(`${result.stdout}\n${result.stderr}`, /EISDIR|directory|目录/i);
});

test("parseCliArgs does not swallow the -- separator as an option value", () => {
  // 回归：值选项紧跟 `--` 时，`--` 必须作为分隔符而非选项值；其余位置参数照常收集。
  assert.throws(() => parseCliArgs(["--task", "--", "foo"]), /缺少值/);
  const parsed = parseCliArgs(["run", "--message", "hi", "--", "--task"]);
  assert.equal(parsed.option("--message"), "hi");
  assert.deepEqual(parsed.positionals, ["run", "--task"]);
});

test("cli resolves jobId positionally even when flags come first", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-parse-"));
  const job = await createJob({
    workspace,
    task: "CLI 解析",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "cli-parse",
  });
  const cliPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "cli.js",
  );
  const flagsFirst = spawnSync(
    process.execPath,
    [cliPath, "status", "--workspace", workspace, job.jobId],
    { encoding: "utf8" },
  );
  assert.equal(flagsFirst.status, 0);
  assert.match(flagsFirst.stdout, /"jobId": "cli-parse"/);
  const positionalFirst = spawnSync(
    process.execPath,
    [cliPath, "status", job.jobId, "--workspace", workspace],
    { encoding: "utf8" },
  );
  assert.equal(positionalFirst.status, 0);
  // 缺失 jobId 时给出明确用法提示，而不是把 undefined 透传成“无效的任务 ID”。
  const missing = spawnSync(
    process.execPath,
    [cliPath, "status", "--workspace", workspace],
    { encoding: "utf8" },
  );
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /请提供任务 ID/);
});

// ---- 错误码：控制流按码判定，文案保持向后兼容 ----

test("errors carry stable codes while keeping user-facing messages", async () => {
  assert.throws(
    () => assertJobId("../evil"),
    (error: unknown) =>
      isCbxError(error, "E_INVALID_JOB_ID") &&
      /无效的任务 ID/.test((error as Error).message),
  );
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-err-codes-"));
  const job = await createJob({
    workspace,
    task: "错误码",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "err-codes",
  });
  await assert.rejects(
    () => readArtifact(workspace, job.jobId, "../context.json"),
    (error: unknown) =>
      isCbxError(error, "E_ARTIFACT_FORBIDDEN") &&
      /不允许读取/.test((error as Error).message),
  );
  assert.ok(new CbxError("E_LOCK_BUSY", "x") instanceof Error);
  assert.equal(isCbxError(new Error("plain")), false);
});

test("queue lock busy surfaces E_QUEUE_BUSY instead of a string match", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-qbusy-"));
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await withFileLock(
    queueLockFile(workspace),
    async () => {
      await assert.rejects(
        () => withQueueLock(workspace, async () => undefined, { retries: 0 }),
        (error: unknown) =>
          isCbxError(error, "E_QUEUE_BUSY") &&
          /队列正在被另一个调度器更新/.test((error as Error).message),
      );
    },
    { retries: 0 },
  );
});

// ---- context.json schema 校验 ----

test("context.json schema validation accepts valid files and rejects corruption", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-context-schema-"),
  );
  const job = await createJob({
    workspace,
    task: "schema",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "ctx-schema",
  });
  const context = await loadJobContext(job.directory);
  assert.equal(context.jobId, "ctx-schema");
  // 未知字段容忍（前向兼容）+ updateJobContext 往返。
  await updateJobContext(workspace, job.jobId, { futureField: 1 });
  assert.equal(
    (
      (await loadJobContext(job.directory)) as unknown as Record<
        string,
        unknown
      >
    ).futureField,
    1,
  );
  const file = path.join(job.directory, "context.json");
  const valid = JSON.parse(JSON.stringify(context)) as Record<string, unknown>;
  // 类型错误拒绝。
  await writeFile(file, JSON.stringify({ ...valid, maxTurns: "abc" }), "utf8");
  await assert.rejects(
    () => loadJobContext(job.directory),
    (error: unknown) =>
      isCbxError(error, "E_INVALID_CONTEXT") &&
      /maxTurns/.test((error as Error).message),
  );
  // 必填缺失拒绝。
  const { jobId: _jobId, ...missingRequired } = valid;
  await writeFile(file, JSON.stringify(missingRequired), "utf8");
  await assert.rejects(
    () => loadJobContext(job.directory),
    /context\.json 无效/,
  );
  // 非对象拒绝。
  await writeFile(file, "[]", "utf8");
  await assert.rejects(
    () => loadJobContext(job.directory),
    /context\.json 无效/,
  );
});

test("context.json rejects non-integer or negative executionRetries/fixRetries", async () => {
  // 回归：executionRetries/fixRetries 必须是 0 及以上的整数，防止 -1 触发零重试或 1.5 产生部分重试。
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ctx-int-"));
  const job = await createJob({
    workspace,
    task: "整数校验",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "ctx-int",
  });
  const context = await loadJobContext(job.directory);
  const file = path.join(job.directory, "context.json");
  for (const bad of [-1, 1.5, NaN]) {
    await writeFile(
      file,
      JSON.stringify({ ...context, executionRetries: bad }),
      "utf8",
    );
    await assert.rejects(
      () => loadJobContext(job.directory),
      (error: unknown) =>
        isCbxError(error, "E_INVALID_CONTEXT") &&
        /executionRetries/.test((error as Error).message),
    );
  }
  // 合法的 0 与正整数通过。
  await writeFile(
    file,
    JSON.stringify({ ...context, executionRetries: 0, fixRetries: 3 }),
    "utf8",
  );
  const ok = await loadJobContext(job.directory);
  assert.equal(ok.executionRetries, 0);
  assert.equal(ok.fixRetries, 3);
});

// ---- redactText 分支覆盖 ----

test("redactText masks configured fields in all key line shapes and applies patterns", () => {
  const input = [
    "api_key: s3cret",
    "- API_KEY = s3cret",
    "password: hunter2",
    "name: cbx",
    "inline secret sk-abc123 here",
  ].join("\n");
  const out = redactText(input, ["api_key", "password"], ["sk-[a-z0-9]+"]);
  assert.match(out, /^api_key: \[REDACTED\]$/m);
  assert.match(out, /^- API_KEY: \[REDACTED\]$/m);
  assert.match(out, /^password: \[REDACTED\]$/m);
  assert.match(out, /^name: cbx$/m);
  assert.match(out, /inline secret \[REDACTED\] here/);
  assert.ok(
    !out.includes("s3cret") &&
      !out.includes("hunter2") &&
      !out.includes("sk-abc123"),
  );
});

// ---- staleLock 分支覆盖 ----

test("staleLock: live pid owns the lock, dead pid or aged corrupt records are reclaimable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-stalelock-"));
  const file = path.join(dir, "x.lock");
  assert.equal(await staleLock(file, 30_000), false); // 文件不存在
  await writeFile(
    file,
    JSON.stringify({
      pid: 2_147_483_647,
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    }),
    "utf8",
  );
  assert.equal(await staleLock(file, 30_000), true); // 死 pid 立即可回收
  await writeFile(
    file,
    JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    }),
    "utf8",
  );
  assert.equal(await staleLock(file, 30_000), false); // 存活 pid 永远持有
  await writeFile(file, "{not-json", "utf8");
  const past = new Date(Date.now() - 120_000);
  await utimes(file, past, past);
  assert.equal(await staleLock(file, 30_000), true); // 损坏记录退回 mtime 判龄
  await writeFile(file, "{not-json", "utf8"); // 重写刷新 mtime
  assert.equal(await staleLock(file, 30_000), false); // 新的损坏记录不立即回收
});

// ---- git-ops 大文件截断分支 ----

test("untracked files over 200KB are truncated in diff snapshots", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-gittrunc-"));
  spawnSync("git", ["init", "-b", "main"], {
    cwd: workspace,
    encoding: "utf8",
  });
  await writeFile(path.join(workspace, "big.bin"), "a".repeat(250_000), "utf8");
  const snapshot = await snapshotDiff(workspace);
  assert.match(snapshot.untracked, /\[跳过超过 200KB 的文件\]/);
  assert.match(snapshot.complete, /\[文件超过 200KB，内容见 worktree\]/);
});

// ---- captureAsync：异步版进程捕获与同步 capture 结果一致 ----

test("captureAsync returns same result as sync capture and surfaces exit codes", async () => {
  const sync = capture(["node", "-e", "console.log('hi')"], ".");
  const async = await captureAsync(["node", "-e", "console.log('hi')"], ".");
  assert.equal(sync.code, 0);
  assert.equal(async.code, 0);
  assert.equal(async.stdout.trim(), "hi");
  // 非零退出码
  const fail = await captureAsync(["node", "-e", "process.exit(3)"], ".");
  assert.equal(fail.code, 3);
  // stderr 捕获
  const err = await captureAsync(["node", "-e", "console.error('boom')"], ".");
  assert.equal(err.code, 0);
  assert.match(err.stderr, /boom/);
  // 命令不存在 → code -1 + error 消息
  const missing = await captureAsync(["definitely-not-a-real-binary-xyz"], ".");
  assert.equal(missing.code, -1);
  assert.ok(missing.stderr.length > 0);
});

test("captureAsync 输出超上限时截断而非无限累积（UI 进程内存保护）", async () => {
  // 产出超过 4MB 上限的输出：捕获必须被截断到 MAX_CAPTURE_BYTES 以内，且保留尾部。
  const { MAX_CAPTURE_BYTES } = await import("../src/process-runner.js");
  const big = await captureAsync(
    ["node", "-e", "process.stdout.write('x'.repeat(5 * 1024 * 1024) + 'TAIL_MARKER')"],
    ".",
  );
  assert.equal(big.code, 0);
  assert.ok(
    Buffer.byteLength(big.stdout, "utf8") <= MAX_CAPTURE_BYTES,
    `stdout 超过上限：${Buffer.byteLength(big.stdout, "utf8")}`,
  );
  // BoundedOutput 保留尾部，截断后仍能看到末尾标记。
  assert.ok(big.stdout.endsWith("TAIL_MARKER"), "应保留输出的尾部");
});

// ---- 加密随机数与常量时间比较 ----

test("identifiers use crypto randomness and token comparison is constant-time", async () => {
  assert.match(normalizeJobId(), /^\d{14}-[0-9a-f]{6}$/);
  assert.equal(constantTimeEqual("token-123", "token-123"), true);
  assert.equal(constantTimeEqual("token-123", "token-124"), false);
  assert.equal(constantTimeEqual("short", "much-longer-token"), false);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-crypto-id-"));
  await savePersistedQueue(workspace, {
    maxConcurrent: 1,
    paused: true,
    updatedAt: now(),
    entries: [],
  });
  const job = await createJob({
    workspace,
    task: "随机数",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "crypto-id",
  });
  const entry = await enqueueJob(workspace, job.jobId, "", 0);
  assert.match(entry.queueId, /^[0-9a-z]+-[0-9a-f]{6}$/);
});

test("enqueueJob 对 awaiting_approval 的任务也拒绝重复入队", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-enqueue-dup-"));
  const job = await createJob({
    workspace,
    task: "重复入队",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "enqueue-dup",
  });
  await enqueueJob(workspace, job.jobId, "", 0);
  // 模拟任务进入 awaiting_approval：执行器终态映射会把队列条目标记成 awaiting_approval
  //（writeState + savePersistedStateAndFinishQueue 的 status 映射），此处等价复刻。
  const queue = await loadPersistedQueue<{
    maxConcurrent: number;
    paused: boolean;
    updatedAt: string;
    entries: Array<Record<string, unknown>>;
  }>(workspace, { maxConcurrent: 2, paused: false, entries: [], updatedAt: "" });
  for (const entry of queue.entries ?? [])
    if (entry.jobId === job.jobId) entry.status = "awaiting_approval";
  await savePersistedQueue(workspace, queue);
  await assert.rejects(
    enqueueJob(workspace, job.jobId, "", 0),
    /任务已经在队列中/,
  );
});

test("cancelJobState 原子写入取消终态：state 与队列条目一致", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cancel-state-"));
  const job = await createJob({
    workspace,
    task: "取消原子写",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "cancel-atomic",
  });
  await enqueueJob(workspace, job.jobId, "", 0);
  // 模拟运行中：把 entry 标记为 running + pid，使取消路径覆盖活跃分支。
  const queue = await loadPersistedQueue<{
    maxConcurrent: number;
    paused: boolean;
    updatedAt: string;
    entries: Array<Record<string, unknown>>;
  }>(workspace, { maxConcurrent: 2, paused: false, entries: [], updatedAt: "" });
  for (const e of queue.entries ?? [])
    if (e.jobId === job.jobId) {
      e.status = "running";
      e.pid = 999999;
    }
  await savePersistedQueue(workspace, queue);
  const state = await cancelJobState(workspace, job.jobId, {
    status: "cancelled",
    phase: "cancelled",
    cancelledAt: now(),
  });
  assert.equal(state.status, "cancelled");
  // 同一锁内完成：所有该 job 的队列条目必须同步标记 cancelled，不能残留 running。
  const after = await listQueue(workspace);
  const entries = after.entries.filter((e) => e.jobId === job.jobId);
  assert.ok(entries.length > 0, "队列中应存在该 job 的条目");
  for (const e of entries) assert.equal(e.status, "cancelled");
});

// ---- cbx export：任务结果导出（text / markdown / 缺失降级） ----

test("cbx export outputs text and markdown summaries for a finished job", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-export-"));
  const job = await createJob({
    workspace,
    task: "导出测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "export-job",
  });
  // 写入最小 result.json 模拟已完成任务
  const dir = path.join(workspace, ".cbx", "jobs", job.jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "result.json"),
    JSON.stringify({
      status: "done",
      phase: "done",
      stages: [
        {
          name: "impl",
          executor: "codebuddy",
          exitCode: 0,
          reviewVerdict: "PASS",
        },
      ],
      acceptanceEvidence: [
        { criterion: "功能可用", status: "evidence_available" },
      ],
      handback: "已完成实现",
      updatedAt: new Date().toISOString(),
    }),
    "utf8",
  );
  const cliPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "cli.js",
  );
  const text = spawnSync(
    process.execPath,
    [cliPath, "export", job.jobId, "--workspace", workspace],
    { encoding: "utf8" },
  );
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /export-job/);
  assert.match(text.stdout, /impl \/ codebuddy \/ PASS/);
  assert.match(text.stdout, /功能可用/);
  assert.match(text.stdout, /已完成实现/);

  const md = spawnSync(
    process.execPath,
    [
      cliPath,
      "export",
      job.jobId,
      "--workspace",
      workspace,
      "--format",
      "markdown",
    ],
    { encoding: "utf8" },
  );
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /^# 任务 export-job/m);
  assert.match(md.stdout, /\| impl \| codebuddy \| PASS \|/);
  assert.match(md.stdout, /- \[x\] 功能可用/);
});

test("cbx export falls back to basic state when result.json is missing", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-export-basic-"));
  const job = await createJob({
    workspace,
    task: "无结果",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "export-basic",
  });
  const cliPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "cli.js",
  );
  const out = spawnSync(
    process.execPath,
    [cliPath, "export", job.jobId, "--workspace", workspace],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /export-basic/);
  assert.match(out.stdout, /无 result\.json/);
});

test("cbx files 列出任务的 artifact 清单而非 result.json 内容", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-files-cli-"));
  const job = await createJob({
    workspace,
    task: "列出产物",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "files-cli",
  });
  const cliPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "cli.js",
  );
  const out = spawnSync(
    process.execPath,
    [cliPath, "files", job.jobId, "--workspace", workspace],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  const files = JSON.parse(out.stdout) as string[];
  // 新建任务至少包含这三个 artifact；listArtifacts 返回文件名数组（非 result.json 正文）。
  for (const name of ["request.md", "context.json", "state.json"])
    assert.ok(files.includes(name), `files 缺少 ${name}`);
  assert.ok(
    !out.stdout.includes('"status"'),
    "cbx files 不应输出 result.json 正文（status 字段）",
  );
});

test("cbx version/--version 输出版本号，--help 输出用法", async () => {
  const cliPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "cli.js",
  );
  for (const arg of ["version", "--version", "-v"]) {
    const out = spawnSync(process.execPath, [cliPath, arg], {
      encoding: "utf8",
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout.trim(), /^\d+\.\d+\.\d+/);
  }
  const help = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /用法：cbx/);
});
