import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  scoreTaskAgainstCapabilities,
  routeStageExecutor,
  routeReviewExecutor,
  ROUTE_AUTO,
} from "../src/executors/route.js";
import { agentDirs } from "../src/agent-registry.js";
import { createJob, setupFake } from "./helpers.js";

// Agent 路由层测试：打分确定性（纯函数）、exclude 交叉验证、executor=auto 端到端落盘。

test("scoreTaskAgainstCapabilities: 单 token 词边界匹配，不误伤子串", () => {
  assert.deepEqual(
    scoreTaskAgainstCapabilities("实现一个 python 脚本", ["python"]),
    { score: 1, hits: ["python"] },
  );
  // "python" 不应命中 "pythonista"
  assert.deepEqual(
    scoreTaskAgainstCapabilities("写一个 pythonista 工具", ["python"]),
    { score: 0, hits: [] },
  );
});

test("scoreTaskAgainstCapabilities: 大小写不敏感 + 多能力累加 + 短语包含", () => {
  assert.deepEqual(
    scoreTaskAgainstCapabilities("global REACT + FRONTEND stack", ["react", "frontend"]),
    { score: 2, hits: ["react", "frontend"] },
  );
  assert.deepEqual(
    scoreTaskAgainstCapabilities("训练一个 machine learning 模型", ["machine learning"]),
    { score: 1, hits: ["machine learning"] },
  );
});

test("scoreTaskAgainstCapabilities: 中文能力串整串包含匹配 + 无声明返回 0", () => {
  assert.deepEqual(
    scoreTaskAgainstCapabilities("重构后端接口的数据库访问层", ["数据库"]),
    { score: 1, hits: ["数据库"] },
  );
  assert.deepEqual(scoreTaskAgainstCapabilities("任意任务", undefined), {
    score: 0,
    hits: [],
  });
  assert.deepEqual(scoreTaskAgainstCapabilities("任意任务", []), {
    score: 0,
    hits: [],
  });
});

async function writeCapabilitySpec(workspace: string, name: string, caps: string[]): Promise<string> {
  await mkdir(agentDirs(workspace).workspace, { recursive: true });
  const env = `CBX_${name.replace(/[^a-z0-9]/g, "_").toUpperCase()}`;
  await writeFile(
    path.join(agentDirs(workspace).workspace, `${name}.json`),
    JSON.stringify({
      name,
      label: name,
      candidates: [`cbx-${name}-cli`],
      args: ["-p", "{prompt}"],
      capabilities: caps,
    }),
    "utf8",
  );
  return env;
}

test("routeStageExecutor: 命中能力者被路由，未命中返回 undefined", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-route-"));
  const feEnv = await writeCapabilitySpec(workspace, "fe-agent", ["frontend", "react"]);
  const prevFe = process.env[feEnv];
  process.env[feEnv] = process.execPath; // 指向真实可执行文件 → available=true
  try {
    const decision = await routeStageExecutor({
      task: "为仪表盘写一个 React 前端",
      workspace,
    });
    assert.ok(decision);
    assert.equal(decision.executor, "fe-agent");
    assert.ok(decision.ranked.some((r) => r.name === "fe-agent" && r.score > 0));
    assert.ok(decision.notes[0].includes("react"));

    // 不命中任何能力 → undefined（调用方回退默认）
    assert.equal(
      await routeStageExecutor({ task: "写一段与前端无关的纯后端逻辑", workspace }),
      undefined,
    );
  } finally {
    if (prevFe === undefined) delete process.env[feEnv];
    else process.env[feEnv] = prevFe;
  }
});

test("routeReviewExecutor: 排除主执行 agent 选其它交叉验证者", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-route-review-"));
  const feEnv = await writeCapabilitySpec(workspace, "fe-agent", ["frontend"]);
  const beEnv = await writeCapabilitySpec(workspace, "be-agent", ["backend"]);
  process.env[feEnv] = process.execPath;
  process.env[beEnv] = process.execPath;
  try {
    // primary=fe-agent，task 命中 fe。交叉验证应排除 fe，落到 be（be 未命中则回退自审）
    const decision = await routeReviewExecutor({
      task: "实现前端 React 页面",
      workspace,
      primary: "fe-agent",
    });
    // be-agent 无命中 → undefined，调用方回退主执行 agent 自审
    assert.equal(decision, undefined);

    // 两个 agent 都可用且 be 命中 → 排除 primary 后选 be
    const d2 = await routeReviewExecutor({
      task: "设计界面并实现 backend API 契约",
      workspace,
      primary: "fe-agent",
    });
    assert.ok(d2);
    assert.equal(d2.executor, "be-agent");
  } finally {
    delete process.env[feEnv];
    delete process.env[beEnv];
  }
});

test("createJob executor=auto: 路由到能力 agent 并落盘 context.routing", async () => {
  const { workspace, script } = await setupFake();
  const feEnv = await writeCapabilitySpec(workspace, "fe-agent", ["frontend", "react"]);
  process.env[feEnv] = script;
  try {
    const job = await createJob({
      workspace,
      task: "实现一个 React 前端仪表盘",
      review: true,
      isolated: false,
      executor: ROUTE_AUTO,
      permissionMode: "auto",
      maxTurns: 5,
      timeoutMs: 30_000,
      maxRetries: 0,
      jobId: "route-auto-integration",
    });
    const context = JSON.parse(
      await readFile(path.join(job.directory, "context.json"), "utf8"),
    ) as {
      executor: string;
      reviewRequested: boolean;
      routing: { mode: string; route_to: string; score: number; notes: string[] };
    };
    assert.equal(context.executor, "fe-agent");
    assert.ok(context.reviewRequested);
    assert.equal(context.routing.mode, "auto");
    assert.equal(context.routing.route_to, "fe-agent");
    assert.ok(context.routing.score >= 1);
    assert.ok(context.routing.notes.length >= 1);
    // review 任务 + executor=auto → reviewExecutor 也标记为 auto（交叉验证）
    const raw = JSON.parse(
      await readFile(path.join(job.directory, "context.json"), "utf8"),
    ) as { reviewExecutor: string };
    assert.equal(raw.reviewExecutor, ROUTE_AUTO);
  } finally {
    delete process.env[feEnv];
  }
});

test("createJob executor=auto: 无能力命中回退默认 codebuddy，不残留 auto", async () => {
  const { workspace } = await setupFake();
  const feEnv = await writeCapabilitySpec(workspace, "fe-agent", ["frontend"]);
  process.env[feEnv] = process.execPath;
  try {
    const job = await createJob({
      workspace,
      task: "写一段与任何能力都不相关的纯文本说明",
      review: false,
      isolated: false,
      executor: ROUTE_AUTO,
      permissionMode: "auto",
      maxTurns: 5,
      timeoutMs: 30_000,
      maxRetries: 0,
      jobId: "route-auto-fallback",
    });
    const context = JSON.parse(
      await readFile(path.join(job.directory, "context.json"), "utf8"),
    ) as { executor: string; routing: { route_to: string; rank: unknown }; reviewExecutor?: string };
    assert.equal(context.executor, "codebuddy");
    assert.equal(context.routing.route_to, "codebuddy");
    // 未启用审查 → reviewExecutor 不应残留 "auto"
    assert.ok(context.reviewExecutor === undefined || context.reviewExecutor !== ROUTE_AUTO);
  } finally {
    delete process.env[feEnv];
  }
});