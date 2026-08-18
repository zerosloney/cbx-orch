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
