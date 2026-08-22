import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJob, executeJob, setupFake } from "./helpers.js";
import { agentDirs } from "../src/agent-registry.js";
import { ROUTE_AUTO } from "../src/executors/route.js";

// 失败降级链（harness router 第二级）测试：auto 路由的执行失败按 ranked 顺位换 agent 重试；
// 显式 executor 不降级；测试失败走同 agent 的 fix 循环；链耗尽保持原 agent 终态。

interface RoutingAudit {
  executor: string;
  routing: {
    mode: string;
    route_to: string;
    fallbacks?: Array<{ from: string; to: string; reason: string }>;
  };
}

async function writeSpec(
  workspace: string,
  name: string,
  capabilities: string[],
): Promise<string> {
  await mkdir(agentDirs(workspace).workspace, { recursive: true });
  await writeFile(
    path.join(agentDirs(workspace).workspace, `${name}.json`),
    JSON.stringify({
      name,
      label: name,
      candidates: [`cbx-${name}-cli`],
      args: ["run", "{prompt}"],
      capabilities,
    }),
    "utf8",
  );
  return `CBX_${name.replace(/[^a-z0-9]/g, "_").toUpperCase()}`;
}

async function readContext(directory: string): Promise<RoutingAudit> {
  return JSON.parse(
    await readFile(path.join(directory, "context.json"), "utf8"),
  ) as RoutingAudit;
}

async function readEvents(directory: string): Promise<string> {
  return readFile(path.join(directory, "events.ndjson"), "utf8");
}

test("executor=auto 执行失败降级到下一个 ranked agent 并完成", async () => {
  const { workspace, script } = await setupFake();
  // agent-a 永远失败；agent-b 复用 setupFake 的 fake agent（写 handback、退出 0）。
  const failScript = path.join(path.dirname(script), "fail-agent.mjs");
  await writeFile(failScript, "process.exit(1);\n", "utf8");
  const aEnv = await writeSpec(workspace, "agent-a", ["react"]);
  const bEnv = await writeSpec(workspace, "agent-b", ["react"]);
  process.env[aEnv] = failScript;
  process.env[bEnv] = script;
  const job = await createJob({
    workspace,
    task: "实现一个 React 组件",
    testCommand: 'node -e "process.exit(0)"',
    review: false,
    isolated: false,
    executor: ROUTE_AUTO,
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 1,
    jobId: "fallback-success",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  try {
    const result = await executeJob(workspace, job.jobId);
    assert.equal(result.status, "done");
    // 降级审计：context.executor 指向最终 agent，routing.fallbacks 记录链，route_to 保留原始路由
    const context = await readContext(job.directory);
    assert.equal(context.executor, "agent-b");
    assert.equal(context.routing.mode, "auto");
    assert.equal(context.routing.route_to, "agent-a");
    assert.equal(context.routing.fallbacks?.length, 1);
    assert.equal(context.routing.fallbacks![0].from, "agent-a");
    assert.equal(context.routing.fallbacks![0].to, "agent-b");
    assert.ok(context.routing.fallbacks![0].reason.includes("失败"));
    // 事件流与 result 反映降级
    const events = await readEvents(job.directory);
    assert.ok(events.includes("executor_fallback"));
    assert.ok(events.includes("agent-b"));
    assert.equal(result.stages?.[0]?.executor, "agent-b");
  } finally {
    delete process.env[aEnv];
    delete process.env[bEnv];
    process.env.FAKE_JOB_DIR = "";
  }
});

test("降级链耗尽：无下一个可用候选时保持原 agent 至终态", async () => {
  const { workspace, script } = await setupFake();
  const failScript = path.join(path.dirname(script), "fail-agent.mjs");
  await writeFile(failScript, "process.exit(1);\n", "utf8");
  // 只注册一个能力命中者：fallback exclude 它之后无可路由候选
  const aEnv = await writeSpec(workspace, "agent-a", ["react"]);
  process.env[aEnv] = failScript;
  const job = await createJob({
    workspace,
    task: "实现一个 React 组件",
    review: false,
    isolated: false,
    executor: ROUTE_AUTO,
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 1,
    jobId: "fallback-exhausted",
  });
  try {
    const result = await executeJob(workspace, job.jobId);
    assert.equal(result.status, "failed");
    const context = await readContext(job.directory);
    assert.equal(context.executor, "agent-a");
    assert.equal(context.routing.fallbacks, undefined);
    assert.ok(!(await readEvents(job.directory)).includes("executor_fallback"));
  } finally {
    delete process.env[aEnv];
  }
});

test("显式声明的 executor 不参与降级（尊重任务作者的选择）", async () => {
  const { workspace, script } = await setupFake();
  const failScript = path.join(path.dirname(script), "fail-agent.mjs");
  await writeFile(failScript, "process.exit(1);\n", "utf8");
  const aEnv = await writeSpec(workspace, "agent-a", ["react"]);
  const bEnv = await writeSpec(workspace, "agent-b", ["react"]);
  process.env[aEnv] = failScript;
  process.env[bEnv] = script;
  const job = await createJob({
    workspace,
    task: "实现一个 React 组件",
    review: false,
    isolated: false,
    executor: "agent-a",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 1,
    jobId: "fallback-explicit",
  });
  try {
    const result = await executeJob(workspace, job.jobId);
    assert.equal(result.status, "failed");
    const context = await readContext(job.directory);
    assert.equal(context.routing, undefined);
    assert.equal(context.executor, "agent-a");
    assert.ok(!(await readEvents(job.directory)).includes("executor_fallback"));
  } finally {
    delete process.env[aEnv];
    delete process.env[bEnv];
  }
});

test("测试失败走同 agent 的 fix 循环，不触发执行降级", async () => {
  const { workspace, script } = await setupFake();
  // agent-a 执行成功（fake agent）但验收命令永远失败：fix 重试应保持同 agent
  const aEnv = await writeSpec(workspace, "agent-a", ["react"]);
  const bEnv = await writeSpec(workspace, "agent-b", ["react"]);
  process.env[aEnv] = script;
  process.env[bEnv] = script;
  const job = await createJob({
    workspace,
    task: "实现一个 React 组件",
    testCommand: 'node -e "process.exit(1)"',
    review: false,
    isolated: false,
    executor: ROUTE_AUTO,
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 1,
    jobId: "fallback-no-fix-swap",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  try {
    const result = await executeJob(workspace, job.jobId);
    assert.equal(result.status, "needs_fix");
    const context = await readContext(job.directory);
    assert.equal(context.executor, "agent-a");
    assert.equal(context.routing.fallbacks, undefined);
    const events = await readEvents(job.directory);
    assert.ok(!events.includes("executor_fallback"));
  } finally {
    delete process.env[aEnv];
    delete process.env[bEnv];
    process.env.FAKE_JOB_DIR = "";
  }
});
