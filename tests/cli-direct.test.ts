import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../src/cli.js";
import { createJob, cancelJob } from "../src/core.js";

async function runMain(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode = 0;

  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalIsTTY = process.stdin.isTTY;

  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__TEST_EXIT_${code}`);
  }) as typeof process.exit;

  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  (process.stdin as unknown as { isTTY: boolean }).isTTY = true;

  try {
    await main(args);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("__TEST_EXIT_")) {
      // process.exit() 被调用，属于预期行为
    } else {
      throw e;
    }
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    (process.stdin as unknown as { isTTY: boolean }).isTTY = originalIsTTY;
  }

  return { code: exitCode, stdout: logs.join("\n"), stderr: errors.join("\n") };
}

// =============================================================================
// 基础命令（无 job 依赖）
// =============================================================================

test("cli direct: help", async () => {
  const { code, stdout } = await runMain(["help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("用法：cbx"));
});

test("cli direct: version", async () => {
  const { code, stdout } = await runMain(["version"]);
  assert.equal(code, 0);
  assert.ok(/^\d+\.\d+\.\d+/.test(stdout.trim()));
});

test("cli direct: list empty workspace", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["list", "--workspace", ws]);
  assert.equal(code, 0);
  const jobs = JSON.parse(stdout);
  assert.ok(Array.isArray(jobs));
});

test("cli direct: list --all cross workspace", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["list", "--all", "--workspace", ws]);
  assert.equal(code, 0);
  const combined = JSON.parse(stdout);
  assert.ok(Array.isArray(combined));
});

test("cli direct: health empty workspace", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["health", "--workspace", ws]);
  assert.equal(code, 0);
  const h = JSON.parse(stdout);
  assert.equal(h.status, "ok");
});

test("cli direct: health --all cross workspace", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["health", "--all", "--workspace", ws]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.ok(Array.isArray(result.workspaces));
});

test("cli direct: dispatch empty workspace", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["dispatch", "--workspace", ws]);
  assert.equal(code, 0);
  const q = JSON.parse(stdout);
  assert.ok(Array.isArray(q.entries));
});

test("cli direct: queue list/pause/resume", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");

  const { code: c1, stdout: out1 } = await runMain(["queue", "--workspace", ws]);
  assert.equal(c1, 0);
  assert.equal(JSON.parse(out1).paused, false);

  const { code: c2 } = await runMain(["queue", "pause", "--workspace", ws]);
  assert.equal(c2, 0);

  const { code: c3 } = await runMain(["queue", "resume", "--workspace", ws]);
  assert.equal(c3, 0);
});

test("cli direct: ws command", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["ws", "--workspace", ws]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.ok(result.workspaces);
});

test("cli direct: stop-review-gate", async () => {
  const { code, stdout } = await runMain(["stop-review-gate"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "");
});

// =============================================================================
// 错误路径（参数缺失 / job 不存在）
// =============================================================================

test("cli direct: batch missing task", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["batch", "--workspace", ws]), /请至少提供一个任务/);
});

test("cli direct: batch unsupported --job-id", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["batch", "--workspace", ws, "--job-id", "x"]), /不支持 --job-id/);
});

test("cli direct: forget missing --yes", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["forget", "--workspace", ws, "test-job"]), /forget 会删除/);
});

test("cli direct: purge missing --yes", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["purge", "--workspace", ws, "test-job"]), /purge 会删除/);
});

test("cli direct: export invalid format", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  await assert.rejects(runMain(["export", "--workspace", ws, "--format", "xml", job.jobId]), /必须是 text 或 markdown/);
});

test("cli direct: status nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["status", "--workspace", ws, "nonexistent"]), /不存在/);
});

test("cli direct: logs nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["logs", "--workspace", ws, "nonexistent"]), /ENOENT/);
});

test("cli direct: files nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain(["files", "--workspace", ws, "nonexistent"]);
  assert.equal(code, 0);
  assert.ok(Array.isArray(JSON.parse(stdout)));
});

test("cli direct: result nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["result", "--workspace", ws, "nonexistent"]), /ENOENT/);
});

test("cli direct: review nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain(["review", "--workspace", ws, "nonexistent"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("尚无 review.md"));
});

test("cli direct: cancel nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["cancel", "--workspace", ws, "nonexistent"]), /不存在/);
});

test("cli direct: clean nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain(["clean", "--workspace", ws, "nonexistent"]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).jobId, "nonexistent");
});

test("cli direct: retry nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["retry", "--workspace", ws, "nonexistent"]), /不存在/);
});

test("cli direct: approve nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["approve", "--workspace", ws, "nonexistent"]), /不存在/);
});

test("cli direct: continue nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["continue", "--workspace", ws, "nonexistent"]), /不存在/);
});

// =============================================================================
// 需要 job 的正常路径
// =============================================================================

test("cli direct: start command", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain(["start", "--workspace", ws, "--task", "test task"]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "queued");
  assert.ok(result.jobId);
});

test("cli direct: run with --ci exits 2 on failure", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code } = await runMain([
    "run", "--workspace", ws, "--task", "test", "--executor", "codebuddy",
    "--timeout-ms", "100", "--max-turns", "1", "--ci",
  ]);
  assert.equal(code, 2);
});

test("cli direct: run with --template missing", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({ templates: {} }), "utf8");
  await assert.rejects(runMain(["run", "--workspace", ws, "--template", "missing"]), /模板不存在/);
});

test("cli direct: batch normal execution", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain([
    "batch", "--workspace", ws, "--task", "task1", "--task", "task2",
    "--timeout-ms", "100", "--max-turns", "1",
  ]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.total, 2);
  assert.ok(Array.isArray(result.jobs));
});

test("cli direct: batch --wait exits 2 on unfinished", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code } = await runMain([
    "batch", "--workspace", ws, "--task", "task1",
    "--timeout-ms", "100", "--max-turns", "1",
    "--wait", "--wait-timeout-ms", "1000",
  ]);
  assert.equal(code, 2);
});

test("cli direct: export normal execution", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["export", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("test") || stdout.includes(job.jobId));
});

test("cli direct: status existing job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["status", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  const state = JSON.parse(stdout);
  assert.equal(state.jobId, job.jobId);
});

test("cli direct: review existing job without review.md", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["review", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("尚无 review.md"));
});

test("cli direct: forget --yes", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  await cancelJob(ws, job.jobId);
  const { code, stdout } = await runMain(["forget", "--workspace", ws, "--yes", job.jobId]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.jobId, job.jobId);
});

test("cli direct: clean existing job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["clean", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.jobId, job.jobId);
});

test("cli direct: retry cancelled job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  await cancelJob(ws, job.jobId);
  const { code, stdout } = await runMain(["retry", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.jobId, job.jobId);
});

test("cli direct: cancel existing queued job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["cancel", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.jobId, job.jobId);
});

test("cli direct: continue background", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["continue", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.jobId, job.jobId);
  assert.equal(result.status, "queued");
});

test("cli direct: run --task-file", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const taskFile = path.join(ws, "task.txt");
  await writeFile(taskFile, "从文件读取的任务", "utf8");
  const { code, stderr } = await runMain([
    "run", "--workspace", ws, "--task-file", taskFile,
    "--executor", "codebuddy", "--timeout-ms", "100", "--max-turns", "1",
  ]);
  assert.equal(code, 0);
  assert.ok(!stderr.includes("请提供非空的 --task"));
});
