import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJob, enqueueJob, readArtifact } from "../src/core.js";
import { parseCliArgs } from "../src/cli-args.js";
import { CbxError, isCbxError } from "../src/errors.js";
import { constantTimeEqual, loadJobContext, now, queueLockFile, redactText, savePersistedQueue, staleLock, updateJobContext, withFileLock, withQueueLock } from "../src/storage.js";
import { assertJobId, normalizeJobId } from "../src/validation.js";
import { snapshotDiff } from "../src/git-ops.js";

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
  const parsed = parseCliArgs(["--workspace=A", "--workspace", "B", "--", "--not-a-flag"]);
  assert.equal(parsed.option("--workspace"), "A");
  assert.deepEqual(parsed.all("--workspace"), ["A", "B"]);
  assert.deepEqual(parsed.positionals, ["--not-a-flag"]);
  assert.throws(() => parseCliArgs(["--task"]), /缺少值/);
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
  const job = await createJob({ workspace, task: "CLI 解析", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "cli-parse" });
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
  const flagsFirst = spawnSync(process.execPath, [cliPath, "status", "--workspace", workspace, job.jobId], { encoding: "utf8" });
  assert.equal(flagsFirst.status, 0);
  assert.match(flagsFirst.stdout, /"jobId": "cli-parse"/);
  const positionalFirst = spawnSync(process.execPath, [cliPath, "status", job.jobId, "--workspace", workspace], { encoding: "utf8" });
  assert.equal(positionalFirst.status, 0);
  // 缺失 jobId 时给出明确用法提示，而不是把 undefined 透传成“无效的任务 ID”。
  const missing = spawnSync(process.execPath, [cliPath, "status", "--workspace", workspace], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /请提供任务 ID/);
});

// ---- 错误码：控制流按码判定，文案保持向后兼容 ----

test("errors carry stable codes while keeping user-facing messages", async () => {
  assert.throws(() => assertJobId("../evil"), (error: unknown) => isCbxError(error, "E_INVALID_JOB_ID") && /无效的任务 ID/.test((error as Error).message));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-err-codes-"));
  const job = await createJob({ workspace, task: "错误码", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "err-codes" });
  await assert.rejects(() => readArtifact(workspace, job.jobId, "../context.json"), (error: unknown) => isCbxError(error, "E_ARTIFACT_FORBIDDEN") && /不允许读取/.test((error as Error).message));
  assert.ok(new CbxError("E_LOCK_BUSY", "x") instanceof Error);
  assert.equal(isCbxError(new Error("plain")), false);
});

test("queue lock busy surfaces E_QUEUE_BUSY instead of a string match", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-qbusy-"));
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await withFileLock(queueLockFile(workspace), async () => {
    await assert.rejects(
      () => withQueueLock(workspace, async () => undefined, { retries: 0 }),
      (error: unknown) => isCbxError(error, "E_QUEUE_BUSY") && /队列正在被另一个调度器更新/.test((error as Error).message),
    );
  }, { retries: 0 });
});

// ---- context.json schema 校验 ----

test("context.json schema validation accepts valid files and rejects corruption", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-context-schema-"));
  const job = await createJob({ workspace, task: "schema", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "ctx-schema" });
  const context = await loadJobContext(job.directory);
  assert.equal(context.jobId, "ctx-schema");
  // 未知字段容忍（前向兼容）+ updateJobContext 往返。
  await updateJobContext(workspace, job.jobId, { futureField: 1 });
  assert.equal((await loadJobContext(job.directory) as unknown as Record<string, unknown>).futureField, 1);
  const file = path.join(job.directory, "context.json");
  const valid = JSON.parse(JSON.stringify(context)) as Record<string, unknown>;
  // 类型错误拒绝。
  await writeFile(file, JSON.stringify({ ...valid, maxTurns: "abc" }), "utf8");
  await assert.rejects(() => loadJobContext(job.directory), (error: unknown) => isCbxError(error, "E_INVALID_CONTEXT") && /maxTurns/.test((error as Error).message));
  // 必填缺失拒绝。
  const { jobId: _jobId, ...missingRequired } = valid;
  await writeFile(file, JSON.stringify(missingRequired), "utf8");
  await assert.rejects(() => loadJobContext(job.directory), /context\.json 无效/);
  // 非对象拒绝。
  await writeFile(file, "[]", "utf8");
  await assert.rejects(() => loadJobContext(job.directory), /context\.json 无效/);
});

test("context.json rejects non-integer or negative executionRetries/fixRetries", async () => {
  // 回归：executionRetries/fixRetries 必须是 0 及以上的整数，防止 -1 触发零重试或 1.5 产生部分重试。
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ctx-int-"));
  const job = await createJob({ workspace, task: "整数校验", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "ctx-int" });
  const context = await loadJobContext(job.directory);
  const file = path.join(job.directory, "context.json");
  for (const bad of [-1, 1.5, NaN]) {
    await writeFile(file, JSON.stringify({ ...context, executionRetries: bad }), "utf8");
    await assert.rejects(() => loadJobContext(job.directory), (error: unknown) => isCbxError(error, "E_INVALID_CONTEXT") && /executionRetries/.test((error as Error).message));
  }
  // 合法的 0 与正整数通过。
  await writeFile(file, JSON.stringify({ ...context, executionRetries: 0, fixRetries: 3 }), "utf8");
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
  assert.ok(!out.includes("s3cret") && !out.includes("hunter2") && !out.includes("sk-abc123"));
});

// ---- staleLock 分支覆盖 ----

test("staleLock: live pid owns the lock, dead pid or aged corrupt records are reclaimable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-stalelock-"));
  const file = path.join(dir, "x.lock");
  assert.equal(await staleLock(file, 30_000), false); // 文件不存在
  await writeFile(file, JSON.stringify({ pid: 2_147_483_647, acquiredAt: new Date(Date.now() - 120_000).toISOString() }), "utf8");
  assert.equal(await staleLock(file, 30_000), true); // 死 pid 立即可回收
  await writeFile(file, JSON.stringify({ pid: process.pid, acquiredAt: new Date(Date.now() - 120_000).toISOString() }), "utf8");
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
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  await writeFile(path.join(workspace, "big.bin"), "a".repeat(250_000), "utf8");
  const snapshot = await snapshotDiff(workspace);
  assert.match(snapshot.untracked, /\[跳过超过 200KB 的文件\]/);
  assert.match(snapshot.complete, /\[文件超过 200KB，内容见 worktree\]/);
});

// ---- 加密随机数与常量时间比较 ----

test("identifiers use crypto randomness and token comparison is constant-time", async () => {
  assert.match(normalizeJobId(), /^\d{14}-[0-9a-f]{6}$/);
  assert.equal(constantTimeEqual("token-123", "token-123"), true);
  assert.equal(constantTimeEqual("token-123", "token-124"), false);
  assert.equal(constantTimeEqual("short", "much-longer-token"), false);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-crypto-id-"));
  await savePersistedQueue(workspace, { maxConcurrent: 1, paused: true, updatedAt: now(), entries: [] });
  const job = await createJob({ workspace, task: "随机数", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "crypto-id" });
  const entry = await enqueueJob(workspace, job.jobId, "", 0);
  assert.match(entry.queueId, /^[0-9a-z]+-[0-9a-f]{6}$/);
});
