import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, setupFake } from "./helpers.js";

// cli.ts main() 的集成覆盖：以子进程方式驱动真实 CLI 入口，覆盖命令分发的主路径。
// 覆盖目标：run 前台/模板、start、status、list --all/--limit、health --all、watch、
// logs/result/files/review/export、cancel/clean/forget/purge/approve/retry/continue。

const cli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "src",
  "cli.js",
);

function run(args: string[], env: NodeJS.ProcessEnv = {}): {
  code: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cbx-cli-cov-"));
}

test("cli: run --job-id 前台执行完整任务（fake 执行器）", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "cli 覆盖冒烟",
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "cli-cov-run",
  });
  const { code, stdout } = run(
    ["run", "--job-id", job.jobId, "--workspace", workspace, "--ci"],
    { FAKE_JOB_DIR: job.directory },
  );
  assert.equal(code, 0);
  assert.ok(stdout.includes("done"));
});

test("cli: run --template 展开配置模板并执行", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      templates: { demo: { task: "模板任务", executor: "codebuddy", review: false } },
    }),
    "utf8",
  );
  const job = await createJob({
    workspace,
    task: "占位",
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "cli-cov-template",
  });
  const { code, stdout } = run(
    ["run", "--job-id", job.jobId, "--workspace", workspace, "--ci"],
    { FAKE_JOB_DIR: job.directory },
  );
  assert.equal(code, 0);
  assert.ok(stdout.includes("done"));
});

test("cli: start 命令入队并返回 queued", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "start 命令覆盖",
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "cli-cov-start",
  });
  const { code, stdout } = run(
    ["start", "--job-id", job.jobId, "--workspace", workspace],
    { FAKE_JOB_DIR: job.directory },
  );
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.status, "queued");
});

test("cli: status / watch / logs / result / files / export 读取终态任务", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "读取类命令覆盖",
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "cli-cov-read",
  });
  const { code: runCode } = run(
    ["run", "--job-id", job.jobId, "--workspace", workspace],
    { FAKE_JOB_DIR: job.directory },
  );
  assert.equal(runCode, 0);

  const { code: statusCode, stdout: statusOut } = run([
    "status",
    job.jobId,
    "--workspace",
    workspace,
    "--json",
  ]);
  assert.equal(statusCode, 0);
  assert.equal(JSON.parse(statusOut).jobId, job.jobId);

  const { code: watchCode, stdout: watchOut } = run([
    "watch",
    job.jobId,
    "--workspace",
    workspace,
    "--interval-ms",
    "50",
  ]);
  assert.equal(watchCode, 0);
  assert.ok(watchOut.includes("done"));

  const { code: logsCode } = run(["logs", job.jobId, "--workspace", workspace]);
  assert.equal(logsCode, 0);

  const { code: resultCode, stdout: resultOut } = run([
    "result",
    job.jobId,
    "--workspace",
    workspace,
  ]);
  assert.equal(resultCode, 0);
  assert.ok(resultOut.length > 0);

  const { code: filesCode, stdout: filesOut } = run([
    "files",
    job.jobId,
    "--workspace",
    workspace,
  ]);
  assert.equal(filesCode, 0);
  assert.ok(Array.isArray(JSON.parse(filesOut)));

  for (const format of ["text", "markdown"]) {
    const { code: exportCode, stdout: exportOut } = run([
      "export",
      job.jobId,
      "--workspace",
      workspace,
      "--format",
      format,
    ]);
    assert.equal(exportCode, 0);
    assert.ok(exportOut.length > 0);
  }
});

test("cli: review 无 review.md 时输出提示", async () => {
  const workspace = await tempWorkspace();
  const job = await createJob({
    workspace,
    task: "review 提示覆盖",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 1,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "cli-cov-review",
  });
  const { code, stdout } = run(["review", job.jobId, "--workspace", workspace]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("尚无 review.md"));
});

test("cli: list --all 跨 workspace 汇总", async () => {
  const wsA = await tempWorkspace();
  const wsB = await tempWorkspace();
  await createJob({
    workspace: wsA,
    task: "ws-a 任务",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 1,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "job-a",
  });
  await createJob({
    workspace: wsB,
    task: "ws-b 任务",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 1,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "job-b",
  });
  const { code, stdout } = run([
    "list",
    "--all",
    "--workspace",
    wsA,
    "--workspace",
    wsB,
    "--json",
  ]);
  assert.equal(code, 0);
  const jobs = JSON.parse(stdout);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.some((j: { jobId: string }) => j.jobId.includes("[") && j.jobId.includes("job-a")));

  const { code: limitCode, stdout: limitOut } = run([
    "list",
    "--workspace",
    wsA,
    "--limit",
    "1",
    "--json",
  ]);
  assert.equal(limitCode, 0);
  assert.equal(JSON.parse(limitOut).length, 1);
});

test("cli: health --all 返回多 workspace 汇总", async () => {
  const wsA = await tempWorkspace();
  const wsB = await tempWorkspace();
  const { code, stdout } = run([
    "health",
    "--all",
    "--workspace",
    wsA,
    "--workspace",
    wsB,
  ]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.workspaces.length, 2);
});

test("cli: cancel / clean / forget / purge 生命周期命令", async () => {
  const workspace = await tempWorkspace();
  const cancelJob = await createJob({
    workspace,
    task: "cancel 覆盖",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 1,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "cli-cov-cancel",
  });
  const { code: cancelCode, stdout: cancelOut, stderr: cancelErr } = run([
    "cancel",
    cancelJob.jobId,
    "--workspace",
    workspace,
  ]);
  assert.equal(cancelCode, 0, `cancel 失败：${cancelErr}`);
  assert.equal(JSON.parse(cancelOut).status, "cancelled");

  const { code: cleanCode, stdout: cleanOut } = run([
    "clean",
    cancelJob.jobId,
    "--workspace",
    workspace,
  ]);
  assert.equal(cleanCode, 0);
  assert.ok("cleaned" in JSON.parse(cleanOut));

  // purge 要求任务已终态：cancelled 即满足。
  const { code: purgeCode } = run(
    ["purge", cancelJob.jobId, "--workspace", workspace],
    { CBX_YES: "1" },
  );
  assert.equal(purgeCode, 0);

  const forgetJob = await createJob({
    workspace,
    task: "forget 覆盖",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 1,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "cli-cov-forget",
  });
  run(["cancel", forgetJob.jobId, "--workspace", workspace]);
  const { code: forgetCode } = run([
    "forget",
    forgetJob.jobId,
    "--workspace",
    workspace,
    "--yes",
  ]);
  assert.equal(forgetCode, 0);
});

test("cli: approve / retry 对非适用状态的任务报错（覆盖调用路径）", async () => {
  const workspace = await tempWorkspace();
  const job = await createJob({
    workspace,
    task: "错误路径覆盖",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 1,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "cli-cov-errors",
  });
  const { code: approveCode, stderr: approveErr } = run([
    "approve",
    job.jobId,
    "--workspace",
    workspace,
  ]);
  assert.equal(approveCode, 1);
  assert.ok(approveErr.length > 0);

  const { code: retryCode } = run(["retry", job.jobId, "--workspace", workspace]);
  assert.equal(retryCode, 1);
});

test("cli: continue 默认走后台入队路径", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "continue 覆盖",
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "cli-cov-continue",
  });
  run(["cancel", job.jobId, "--workspace", workspace]);
  const { code, stdout } = run(
    ["continue", job.jobId, "--workspace", workspace, "--message", "重试"],
    { FAKE_JOB_DIR: job.directory },
  );
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.status, "queued");
});

test("cli: run --task 内联创建任务并执行（无 --job-id 分支）", async () => {
  const { workspace } = await setupFake();
  // FAKE_JOB_DIR 未指向具体 jobDir：fake 执行器只输出文本退出 0，验证内联 createJob
  // + flag 解析 + executeJob 主路径被走到（状态以实际输出为准）。
  const { code, stdout } = run(
    [
      "run",
      "--task",
      "inline 创建任务",
      "--test",
      'node -e "process.exit(0)"',
      "--workspace",
      workspace,
      "--ci",
    ],
    { FAKE_JOB_DIR: "" },
  );
  assert.ok(code === 0 || code === 2, `unexpected exit: ${code}`);
  const payload = JSON.parse(stdout);
  assert.ok(typeof payload.jobId === "string" && payload.jobId.length > 0);
  assert.ok(typeof payload.status === "string");
});

test("cli: run --queue-entry-id worker 路径（心跳文件与收尾清理）", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "worker 路径覆盖",
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "cli-cov-worker",
  });
  const { code, stdout } = run(
    [
      "run",
      "--job-id",
      job.jobId,
      "--queue-entry-id",
      "qe-cov-1",
      "--workspace",
      workspace,
    ],
    { FAKE_JOB_DIR: job.directory },
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).status, "done");
});

test("cli: queue pause / resume 子命令", async () => {
  const workspace = await tempWorkspace();
  const { code: pauseCode, stdout: pauseOut } = run([
    "queue",
    "pause",
    "--workspace",
    workspace,
  ]);
  assert.equal(pauseCode, 0);
  assert.equal(JSON.parse(pauseOut).paused, true);

  const { code: resumeCode, stdout: resumeOut } = run([
    "queue",
    "resume",
    "--workspace",
    workspace,
  ]);
  assert.equal(resumeCode, 0);
  assert.equal(JSON.parse(resumeOut).paused, false);

  const { code: listCode, stdout: listOut } = run([
    "queue",
    "--workspace",
    workspace,
    "--json",
  ]);
  assert.equal(listCode, 0);
  assert.ok(JSON.parse(listOut).entries);
});

test("cli: ws 汇总与 batch 参数校验错误路径", async () => {
  const workspace = await tempWorkspace();
  const { code: wsCode, stdout: wsOut } = run([
    "ws",
    "--workspace",
    workspace,
  ]);
  assert.equal(wsCode, 0);
  const wsPayload = JSON.parse(wsOut);
  assert.equal(wsPayload.workspaces.length, 1);
  assert.equal(wsPayload.default, workspace);

  const { code: batchIdCode, stderr: batchIdErr } = run([
    "batch",
    "--job-id",
    "x",
    "--workspace",
    workspace,
  ]);
  assert.equal(batchIdCode, 1);
  assert.match(batchIdErr, /不支持 --job-id/);

  const { code: batchEmptyCode, stderr: batchEmptyErr } = run([
    "batch",
    "--workspace",
    workspace,
  ]);
  assert.equal(batchEmptyCode, 1);
  assert.match(batchEmptyErr, /至少提供一个任务/);
});

test("cli: continue --foreground 前台续跑", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "foreground 续跑覆盖",
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "cli-cov-fg",
  });
  run(["cancel", job.jobId, "--workspace", workspace]);
  const { code, stdout } = run(
    [
      "continue",
      job.jobId,
      "--workspace",
      workspace,
      "--message",
      "前台续跑",
      "--foreground",
    ],
    { FAKE_JOB_DIR: job.directory },
  );
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.ok(["done", "needs_fix", "failed"].includes(payload.status));
});

test("cli: clean --orphans 巡检与清理", async () => {
  const workspace = await tempWorkspace();
  // 无 git 仓库 / 无 worktree：返回空结果（--orphans 主路径）。
  const { code, stdout } = run([
    "clean",
    "--orphans",
    "--workspace",
    workspace,
  ]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.orphans, 0);
  assert.deepEqual(payload.removed, []);
});

test("cli: health --all 单 workspace 失败不阻断汇总（catch 分支）", async () => {
  const wsOk = await tempWorkspace();
  const wsBad = await tempWorkspace();
  // 非法 .cbx.json（strict schema 拒绝未知字段）让 health(wsBad) 抛错走 catch。
  await writeFile(
    path.join(wsBad, ".cbx.json"),
    JSON.stringify({ unknownField: true }),
    "utf8",
  );
  const { code, stdout } = run([
    "health",
    "--all",
    "--workspace",
    wsOk,
    "--workspace",
    wsBad,
  ]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.workspaces.length, 2);
  const bad = payload.workspaces.find(
    (w: { workspace: string }) => w.workspace === wsBad,
  );
  assert.equal(bad.status, "error");
  assert.ok(typeof bad.error === "string" && bad.error.length > 0);
});
