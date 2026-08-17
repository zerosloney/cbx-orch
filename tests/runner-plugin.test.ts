import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, executeJob, loadConfig } from "../src/core.js";
import { resolveRunnerPlugin, runViaRunner } from "../src/runner-plugin.js";
import { assertExecutionPolicy } from "../src/validation.js";
import { initializeGitWorkspace, setupFake } from "./helpers.js";

// ---------- 配置 schema ----------

test("execution.runner 配置接受合法路径，拒绝非字符串", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-runner-schema-"));
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ execution: { trustMode: "untrusted", runner: "./fake-runner.mjs" } }),
    "utf8",
  );
  const config = await loadConfig(workspace);
  assert.equal(config.execution?.runner, "./fake-runner.mjs");
  assert.equal(config.execution?.trustMode, "untrusted");
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ execution: { runner: 42 } }),
    "utf8",
  );
  await assert.rejects(() => loadConfig(workspace), /execution\.runner/);
});

// ---------- 策略 ----------

test("untrusted 信任模式需要 runner 配置（isolated 仍是硬前提）", () => {
  assertExecutionPolicy("trusted", false);
  assertExecutionPolicy("trusted", true);
  assert.throws(
    () => assertExecutionPolicy("untrusted", true),
    /execution\.runner/,
  );
  assert.throws(
    () => assertExecutionPolicy("untrusted", false),
    /isolated/,
  );
  // 配置 runner 后放行（untrusted + isolated + runner）
  assertExecutionPolicy("untrusted", true, true);
});

// ---------- 插件加载与路径防护 ----------

test("resolveRunnerPlugin 拒绝路径穿越与非法 manifest", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-runner-load-"));
  await assert.rejects(
    () => resolveRunnerPlugin("../outside.mjs", workspace),
    /工作区内/,
  );
  // 合法 manifest
  await writeFile(
    path.join(workspace, "good-runner.mjs"),
    `export const manifest = { apiVersion: "cbx.runner/v1", name: "good-runner", version: "1.0.0" };\nexport async function run(request) { return { code: 0, timedOut: false, output: "ok" }; }\n`,
    "utf8",
  );
  const plugin = await resolveRunnerPlugin("./good-runner.mjs", workspace);
  assert.equal(plugin.manifest.name, "good-runner");
  const result = await runViaRunner(plugin, {
    workspace,
    directory: path.join(workspace, ".cbx", "jobs", "x"),
    workdir: workspace,
    command: ["node", "-e", "1"],
    shell: false,
    role: "stage",
    timeoutMs: 1000,
    env: {},
  });
  assert.deepEqual(result, { code: 0, timedOut: false, output: "ok" });
  // 非法 manifest（apiVersion 不符）
  await writeFile(
    path.join(workspace, "bad-runner.mjs"),
    `export const manifest = { apiVersion: "cbx.executor/v1", name: "bad", version: "1" };\nexport async function run() { return {}; }\n`,
    "utf8",
  );
  await assert.rejects(
    () => resolveRunnerPlugin("./bad-runner.mjs", workspace),
    /manifest 无效/,
  );
});

// ---------- 端到端：untrusted + runner 跑通任务 ----------

const FAKE_RUNNER_SOURCE = `
export const manifest = { apiVersion: "cbx.runner/v1", name: "fake-runner", version: "1.0.0", capabilities: ["execute"] };
export async function run(request) {
  const { spawnSync } = await import("node:child_process");
  const { appendFileSync } = await import("node:fs");
  const log = process.env.FAKE_RUNNER_LOG;
  if (log) appendFileSync(log, JSON.stringify({ role: request.role, shell: request.shell, command: request.command, workdir: request.workdir }) + "\\n");
  const result = request.shell
    ? spawnSync(request.command[0], { shell: true, cwd: request.workdir, encoding: "utf8", timeout: request.timeoutMs, env: { ...request.env } })
    : spawnSync(request.command[0], request.command.slice(1), { cwd: request.workdir, encoding: "utf8", timeout: request.timeoutMs, env: { ...request.env } });
  return { code: result.status ?? -1, timedOut: Boolean(result.error), output: String(result.stdout ?? "") + String(result.stderr ?? "") };
}
`;

test("untrusted 任务经 runner 插件执行完成（stage + test 都走 runner）", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const runnerLog = path.join(workspace, "runner-invocations.ndjson");
  process.env.FAKE_RUNNER_LOG = runnerLog;
  await writeFile(path.join(workspace, "fake-runner.mjs"), FAKE_RUNNER_SOURCE, "utf8");
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      execution: { trustMode: "untrusted", runner: "./fake-runner.mjs" },
    }),
    "utf8",
  );
  // 基线必须干净：runner 插件与配置属于工作区内容，先提交再建任务（isolated 基线校验）。
  spawnSync("git", ["add", "-A"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "add runner fixture", "--no-verify"], {
    cwd: workspace,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "cbx-test",
      GIT_AUTHOR_EMAIL: "cbx@test",
      GIT_COMMITTER_NAME: "cbx-test",
      GIT_COMMITTER_EMAIL: "cbx@test",
    },
  });
  const job = await createJob({
    workspace,
    task: "runner 执行任务",
    review: false,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 10_000,
    testCommand: 'node -e "process.exit(0)"',
    trustMode: "untrusted",
    jobId: "runner-job",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  // runner 被 stage 与 test 两处调用
  const invocations = await readFile(runnerLog, "utf8");
  assert.match(invocations, /"role":"stage"/);
  assert.match(invocations, /"role":"test"/);
  // 捕获输出落 agent.log / test.log
  const agentLog = await readFile(path.join(job.directory, "agent.log"), "utf8");
  assert.match(agentLog, /fake executor output/);
  const testLog = await readFile(path.join(job.directory, "test.log"), "utf8");
  assert.match(testLog, /退出码：0/);
});

test("untrusted 无 runner 配置时创建任务被拒绝", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  await assert.rejects(
    () =>
      createJob({
        workspace,
        task: "untrusted 无 runner",
        review: false,
        isolated: true,
        permissionMode: "auto",
        maxTurns: 10,
        trustMode: "untrusted",
      }),
    /execution\.runner/,
  );
});

test("runner 插件执行超时返回 timedOut（墙钟兜底）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-runner-timeout-"));
  // 故意用真实墙钟延迟：本测试就是验证 wall-clock 兜底对"无视 timeoutMs 的坏插件"生效，
  // 无法用 fake timers（插件在子进程 import 字符串源码里，且被测的正是真实时钟行为）。
  await writeFile(
    path.join(workspace, "slow-runner.mjs"),
    `
export const manifest = { apiVersion: "cbx.runner/v1", name: "slow-runner", version: "1.0.0" };
export async function run() {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, 5000);
  await promise;
  return { code: 0, timedOut: false, output: "late" };
}
`,
    "utf8",
  );
  const plugin = await resolveRunnerPlugin("./slow-runner.mjs", workspace);
  await assert.rejects(
    () =>
      runViaRunner(plugin, {
        workspace,
        directory: path.join(workspace, ".cbx"),
        workdir: workspace,
        command: ["node", "-e", "1"],
        shell: false,
        role: "test",
        timeoutMs: 200,
        env: {},
      }),
    /超时/,
  );
});
