import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "../src/cli-args.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "src", "cli.js");

function run(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ========== parseCliArgs 单元测试 ==========

test("parseCliArgs: 空参数", () => {
  const parsed = parseCliArgs([]);
  assert.deepEqual(parsed.positionals, []);
  assert.equal(parsed.option("--task"), undefined);
  assert.equal(parsed.has("--review"), false);
});

test("parseCliArgs: 位置参数", () => {
  const parsed = parseCliArgs(["run", "my-task"]);
  assert.deepEqual(parsed.positionals, ["run", "my-task"]);
});

test("parseCliArgs: 带值选项", () => {
  const parsed = parseCliArgs(["--task", "hello", "--workspace", "."]);
  assert.equal(parsed.option("--task"), "hello");
  assert.equal(parsed.option("--workspace"), ".");
  assert.equal(parsed.has("--task"), true);
});

test("parseCliArgs: 等号赋值", () => {
  const parsed = parseCliArgs(["--task=hello world", "--workspace=./foo"]);
  assert.equal(parsed.option("--task"), "hello world");
  assert.equal(parsed.option("--workspace"), "./foo");
});

test("parseCliArgs: 布尔开关", () => {
  const parsed = parseCliArgs(["--review", "--ci"]);
  assert.equal(parsed.has("--review"), true);
  assert.equal(parsed.has("--ci"), true);
  assert.equal(parsed.has("--no-review"), false);
});

test("parseCliArgs: --no-* 否定开关", () => {
  const parsed = parseCliArgs(["--no-review", "--no-isolated"]);
  assert.equal(parsed.has("--no-review"), true);
  assert.equal(parsed.has("--no-isolated"), true);
});

test("parseCliArgs: 重复选项取首个", () => {
  const parsed = parseCliArgs(["--workspace", "a", "--workspace", "b"]);
  assert.equal(parsed.option("--workspace"), "a");
  assert.deepEqual(parsed.all("--workspace"), ["a", "b"]);
});

test("parseCliArgs: -- 分隔符后的内容视为位置参数", () => {
  const parsed = parseCliArgs(["--task", "t", "--", "--not-an-option", "positional"]);
  assert.equal(parsed.option("--task"), "t");
  assert.deepEqual(parsed.positionals, ["--not-an-option", "positional"]);
});

test("parseCliArgs: 带值选项缺失值时抛错", () => {
  assert.throws(() => parseCliArgs(["--task"]), /选项 --task 缺少值/);
});

test("parseCliArgs: 带值选项后紧跟 -- 时抛错", () => {
  assert.throws(() => parseCliArgs(["--task", "--"]), /选项 --task 缺少值/);
});

test("parseCliArgs: intOption 解析整数", () => {
  const parsed = parseCliArgs(["--timeout-ms", "5000"]);
  assert.equal(parsed.intOption("--timeout-ms", 1000), 5000);
});

test("parseCliArgs: intOption 缺省返回 fallback", () => {
  const parsed = parseCliArgs([]);
  assert.equal(parsed.intOption("--timeout-ms", 3000), 3000);
  assert.equal(parsed.intOption("--timeout-ms", undefined), undefined);
});

test("parseCliArgs: intOption 非整数抛错", () => {
  const parsed = parseCliArgs(["--timeout-ms", "abc"]);
  assert.throws(() => parsed.intOption("--timeout-ms", 0), /必须是整数/);
});

test("parseCliArgs: intOption 浮点数抛错", () => {
  const parsed = parseCliArgs(["--timeout-ms", "3.14"]);
  assert.throws(() => parsed.intOption("--timeout-ms", 0), /必须是整数/);
});

test("parseCliArgs: intOption 越界抛错", () => {
  const parsed = parseCliArgs(["--timeout-ms", "50"]);
  assert.throws(() => parsed.intOption("--timeout-ms", 0, { min: 100 }), /必须是 100 到/);
});

test("parseCliArgs: intOption 负数无限大边界", () => {
  const parsed = parseCliArgs(["--priority", "-5"]);
  assert.equal(parsed.intOption("--priority", 0), -5);
});

test("parseCliArgs: option fallback", () => {
  const parsed = parseCliArgs([]);
  assert.equal(parsed.option("--workspace", "."), ".");
  assert.equal(parsed.option("--task", "default"), "default");
});

// ========== CLI 集成测试 ==========

test("cli: help 命令返回用法", () => {
  const { code, stdout } = run(["help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("用法：cbx"));
});

test("cli: --help 返回用法", () => {
  const { code, stdout } = run(["--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("用法：cbx"));
});

test("cli: -h 返回用法", () => {
  const { code, stdout } = run(["-h"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("用法：cbx"));
});

test("cli: version 命令返回版本", () => {
  const { code, stdout } = run(["version"]);
  assert.equal(code, 0);
  assert.ok(/^\d+\.\d+\.\d+/.test(stdout.trim()));
});

test("cli: --version 返回版本", () => {
  const { code, stdout } = run(["--version"]);
  assert.equal(code, 0);
  assert.ok(/^\d+\.\d+\.\d+/.test(stdout.trim()));
});

test("cli: -v 返回版本", () => {
  const { code, stdout } = run(["-v"]);
  assert.equal(code, 0);
  assert.ok(/^\d+\.\d+\.\d+/.test(stdout.trim()));
});

test("cli: 无命令时输出用法", () => {
  const { code, stdout } = run([]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("用法：cbx"));
});

test("cli: status 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["status", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: review 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["review", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: continue 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["continue", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: cancel 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["cancel", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: approve 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["approve", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: retry 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["retry", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: clean 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["clean", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: forget 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["forget", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: purge 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["purge", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: run 缺少 task 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["run", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供非空的 --task"));
});

test("cli: batch 缺少 task 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["batch", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请至少提供一个任务"));
});

test("cli: batch 不支持 --job-id", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["batch", "--workspace", workspace, "--job-id", "x"]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("不支持 --job-id"));
});

test("cli: queue pause/resume/list 子命令", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");
  const { code: codeList, stdout: outList } = run(["queue", "--workspace", workspace]);
  assert.equal(codeList, 0);
  const q = JSON.parse(outList);
  assert.equal(q.paused, false);

  const { code: codePause } = run(["queue", "pause", "--workspace", workspace]);
  assert.equal(codePause, 0);

  const { code: codeResume } = run(["queue", "resume", "--workspace", workspace]);
  assert.equal(codeResume, 0);
});

test("cli: health 命令返回状态", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = run(["health", "--workspace", workspace]);
  assert.equal(code, 0);
  const h = JSON.parse(stdout);
  assert.equal(h.status, "ok");
});

test("cli: export 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["export", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: logs 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["logs", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: result 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["result", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: files 缺少 jobId 时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["files", "--workspace", workspace]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("请提供任务 ID"));
});

test("cli: forget 缺少 --yes 且环境变量未设置时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["forget", "--workspace", workspace, "test-job"]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("forget 会删除"));
});

test("cli: purge 缺少 --yes 且环境变量未设置时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["purge", "--workspace", workspace, "test-job"]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("purge 会删除"));
});

test("cli: export --format 非法值抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const { code, stderr } = run(["export", "--workspace", workspace, "--format", "xml", "job1"]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("必须是 text 或 markdown"));
});

test("cli: run --template 不存在时抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ templates: {} }), "utf8");
  const { code, stderr } = run(["run", "--workspace", workspace, "--template", "missing"]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("模板不存在"));
});

test("cli: run 使用 --task-file 读取任务", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  const taskFile = path.join(workspace, "task.txt");
  await writeFile(taskFile, "从文件读取的任务", "utf8");
  // 加 --timeout-ms 让任务快速失败，只验证参数解析阶段不提示缺 task
  const { code, stdout, stderr } = run(["run", "--workspace", workspace, "--task-file", taskFile, "--executor", "codebuddy", "--timeout-ms", "100", "--max-turns", "1", "--no-isolated"]);
  // run 命令失败时仍返回 0（除非 --ci）；验证参数解析已通过
  assert.equal(code, 0);
  const combined = stdout + stderr;
  assert.ok(!combined.includes("请提供非空的 --task"));
});

test("cli: dispatch 命令", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = run(["dispatch", "--workspace", workspace]);
  assert.equal(code, 0);
  const q = JSON.parse(stdout);
  assert.ok(Array.isArray(q.entries));
});

test("cli: list 命令", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = run(["list", "--workspace", workspace]);
  assert.equal(code, 0);
  const jobs = JSON.parse(stdout);
  assert.ok(Array.isArray(jobs));
});

test("cli: watch 对不存在的 job 会失败", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stderr } = run(["watch", "--workspace", workspace, "nonexistent"]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("不存在") || stderr.includes("找不到"));
});

test("cli: ws 命令返回 workspace 汇总", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = run(["ws", "--workspace", workspace]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.ok(result.workspaces);
});

test("cli: review-gate 命令（无改动时 skip）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-"));
  // 初始化 git
  const gitInit = spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  if (gitInit.status !== 0) {
    // git 不可用则跳过
    return;
  }
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "hello", "utf8");
  spawnSync("git", ["add", "."], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "init"], { cwd: workspace, encoding: "utf8" });

  const { code, stdout } = run(["review-gate", "--workspace", workspace]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.verdict, "SKIP");
});

test("cli: stop-review-gate hook（TTY 下空输入）", async () => {
  const { code, stdout } = run(["stop-review-gate"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "");
});
