import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createJob, executeJob } from "./helpers.js";

const cliPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "cli.js",
);

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(workspace: string, ...args: string[]): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, CBX_JSON: "1" },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
}

async function makeJob(
  workspace: string,
  jobId: string,
  task = "cli 测试任务",
) {
  return createJob({
    workspace,
    task,
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId,
  });
}

// ---------- status ----------
test("cli status: 已存在 job 输出 state JSON", async () => {
  const workspace = await makeWorkspace();
  await makeJob(workspace, "cli-status");
  const out = runCli(workspace, "status", "cli-status");
  assert.equal(out.status, 0);
  assert.match(out.stdout, /"jobId": "cli-status"/);
});

test("cli status: 缺 jobId 时非 0 退出 + 用法提示", async () => {
  const workspace = await makeWorkspace();
  const out = runCli(workspace, "status");
  assert.equal(out.status, 1);
  assert.match(out.stderr, /请提供任务 ID/);
});

// ---------- list ----------
test("cli list: 列出 workspace 内 jobs", async () => {
  const workspace = await makeWorkspace();
  await makeJob(workspace, "cli-list-1");
  await makeJob(workspace, "cli-list-2");
  const out = runCli(workspace, "list");
  assert.equal(out.status, 0);
  const jobs = JSON.parse(out.stdout) as Array<{ jobId: string }>;
  const ids = jobs.map((j) => j.jobId);
  assert.ok(ids.includes("cli-list-1"));
  assert.ok(ids.includes("cli-list-2"));
});

// ---------- queue ----------
test("cli queue pause/resume: 切换暂停状态", async () => {
  const workspace = await makeWorkspace();
  const paused = runCli(workspace, "queue", "pause");
  assert.equal(paused.status, 0);
  assert.match(paused.stdout, /"paused": true/);
  const resumed = runCli(workspace, "queue", "resume");
  assert.equal(resumed.status, 0);
  assert.match(resumed.stdout, /"paused": false/);
});

test("cli queue: 无 action 时列出队列", async () => {
  const workspace = await makeWorkspace();
  const out = runCli(workspace, "queue");
  assert.equal(out.status, 0);
  assert.match(out.stdout, /"maxConcurrent"/);
});

// ---------- dispatch ----------
test("cli dispatch: 返回调度结果", async () => {
  const workspace = await makeWorkspace();
  const out = runCli(workspace, "dispatch");
  assert.equal(out.status, 0);
  // 空 queue 时 dispatch 应返回 0 dispatched
  const body = JSON.parse(out.stdout) as { dispatched?: number };
  assert.ok(typeof body === "object");
});

// ---------- health/metrics ----------
test("cli health: 输出健康指标", async () => {
  const workspace = await makeWorkspace();
  const out = runCli(workspace, "health");
  assert.equal(out.status, 0);
  const body = JSON.parse(out.stdout) as {
    status: string;
    metrics: Record<string, unknown>;
  };
  assert.equal(body.status, "ok");
});

test("cli metrics: 与 health 同义", async () => {
  const workspace = await makeWorkspace();
  const out = runCli(workspace, "metrics");
  assert.equal(out.status, 0);
  assert.match(out.stdout, /"status": "ok"/);
});

// ---------- logs / files / result ----------
test("cli logs: 未执行 job 无 events.ndjson 时非 0 退出", async () => {
  const workspace = await makeWorkspace();
  await makeJob(workspace, "cli-logs");
  const out = runCli(workspace, "logs", "cli-logs");
  // 未执行 → events.ndjson 不存在 → readArtifact ENOENT → exitCode 1
  assert.equal(out.status, 1);
});

test("cli files: 无 result.json 时输出提示", async () => {
  const workspace = await makeWorkspace();
  await makeJob(workspace, "cli-files");
  const out = runCli(workspace, "files", "cli-files");
  assert.equal(out.status, 0);
  assert.match(out.stdout, /result\.json|尚无/);
});

test("cli result: 无 result.json 时非 0 退出", async () => {
  const workspace = await makeWorkspace();
  await makeJob(workspace, "cli-result");
  const out = runCli(workspace, "result", "cli-result");
  // result.json 不存在 → readArtifact ENOENT → main catch → exitCode 1
  assert.equal(out.status, 1);
});

// ---------- review ----------
test("cli review: 无 review.md 时输出提示", async () => {
  const workspace = await makeWorkspace();
  await makeJob(workspace, "cli-review");
  const out = runCli(workspace, "review", "cli-review");
  assert.equal(out.status, 0);
  assert.match(out.stdout, /review\.md|尚无/);
});

// ---------- 未知命令 → usage ----------
test("cli 未知命令输出 usage 提示", async () => {
  const workspace = await makeWorkspace();
  const out = runCli(workspace, "nonexistent-cmd");
  assert.equal(out.status, 0);
  assert.match(out.stdout, /用法：cbx/);
});

// ---------- files: 有 result.json 时输出 ----------
test("cli files: 执行后输出 result.json", async () => {
  const workspace = await makeWorkspace();
  const job = await makeJob(workspace, "cli-files2", "任务内容");
  await executeJob(workspace, job.jobId, "", undefined);
  const out = runCli(workspace, "files", "cli-files2");
  assert.equal(out.status, 0);
  // 执行后 result.json 应存在，files 解析 JSON 输出
  const body = JSON.parse(out.stdout) as { jobId?: string };
  assert.equal(body.jobId, "cli-files2");
});

// ---------- logs: 有 events 时输出 ----------
test("cli logs: 有事件的 job 输出 ndjson 行", async () => {
  const workspace = await makeWorkspace();
  const job = await makeJob(workspace, "cli-logs2");
  await executeJob(workspace, job.jobId, "", undefined);
  const out = runCli(workspace, "logs", "cli-logs2");
  assert.equal(out.status, 0);
  assert.ok(out.stdout.length > 0);
});
