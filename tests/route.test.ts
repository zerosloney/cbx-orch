import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseRoutingStrategy,
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

/** 种子历史任务：给同层决胜提供战绩（context.executor 归因 + state 终态）。 */
async function seedHistoryJob(
  workspace: string,
  jobId: string,
  executor: string,
  status: string,
  extra: { tokenUsage?: number; createdAt?: string; updatedAt?: string } = {},
): Promise<void> {
  const dir = path.join(workspace, ".cbx", "jobs", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({
      jobId,
      status,
      createdAt: extra.createdAt ?? "2026-08-01T00:00:00.000Z",
      updatedAt: extra.updatedAt ?? "2026-08-01T00:10:00.000Z",
      ...(extra.tokenUsage !== undefined ? { tokenUsage: extra.tokenUsage } : {}),
    }),
    "utf8",
  );
  await writeFile(path.join(dir, "context.json"), JSON.stringify({ executor }), "utf8");
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

test("routeStageExecutor: 能力同分按历史战绩（平滑成功率）决胜", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-route-tie-"));
  const aEnv = await writeCapabilitySpec(workspace, "agent-a", ["react"]);
  const bEnv = await writeCapabilitySpec(workspace, "agent-b", ["react"]);
  process.env[aEnv] = process.execPath;
  process.env[bEnv] = process.execPath;
  await seedHistoryJob(workspace, "h1", "agent-a", "done");
  await seedHistoryJob(workspace, "h2", "agent-a", "done");
  await seedHistoryJob(workspace, "h3", "agent-b", "failed");
  try {
    const decision = await routeStageExecutor({
      task: "写一个 React 组件",
      workspace,
    });
    assert.ok(decision);
    // 两 agent 能力分同为 1；agent-a 平滑成功率 (2+1)/(2+2)=0.75 > agent-b (0+1)/(1+2)≈0.33
    assert.equal(decision.executor, "agent-a");
    assert.ok(decision.notes.some((n) => n.includes("同层决胜")));
    const rankA = decision.ranked.find((r) => r.name === "agent-a");
    assert.equal(rankA?.stats?.runs, 2);
    assert.equal(rankA?.stats?.successRate, 1);
    assert.equal(decision.ranked.find((r) => r.name === "agent-b")?.stats?.runs, 1);
  } finally {
    delete process.env[aEnv];
    delete process.env[bEnv];
  }
});

test("routeStageExecutor: 成功率打平时按均值 token 升序决胜", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-route-tok-"));
  const aEnv = await writeCapabilitySpec(workspace, "agent-a", ["react"]);
  const bEnv = await writeCapabilitySpec(workspace, "agent-b", ["react"]);
  process.env[aEnv] = process.execPath;
  process.env[bEnv] = process.execPath;
  await seedHistoryJob(workspace, "h1", "agent-a", "done", { tokenUsage: 9_000 });
  await seedHistoryJob(workspace, "h2", "agent-b", "done", { tokenUsage: 1_000 });
  try {
    const decision = await routeStageExecutor({
      task: "写一个 React 组件",
      workspace,
    });
    assert.ok(decision);
    // 平滑成功率同为 (1+1)/(1+2)，agent-b 均值 token 更低 → 胜出
    assert.equal(decision.executor, "agent-b");
  } finally {
    delete process.env[aEnv];
    delete process.env[bEnv];
  }
});

test("routeStageExecutor: 并列双方均无历史时保持稳定顺序且不产生决胜 note", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-route-nohist-"));
  const aEnv = await writeCapabilitySpec(workspace, "agent-a", ["react"]);
  const bEnv = await writeCapabilitySpec(workspace, "agent-b", ["react"]);
  process.env[aEnv] = process.execPath;
  process.env[bEnv] = process.execPath;
  try {
    const decision = await routeStageExecutor({
      task: "写一个 React 组件",
      workspace,
    });
    assert.ok(decision);
    // 无任何历史：中性先验 0.5 打平 → 稳定性顺序（文件 spec 按名排序，agent-a 先）
    assert.equal(decision.executor, "agent-a");
    assert.ok(!decision.notes.some((n) => n.includes("同层决胜")));
    assert.equal(decision.ranked.find((r) => r.name === "agent-a")?.stats, undefined);
  } finally {
    delete process.env[aEnv];
    delete process.env[bEnv];
  }
});

test("routeReviewExecutor: 交叉验证决胜同样消费历史战绩", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-route-rev-tie-"));
  const aEnv = await writeCapabilitySpec(workspace, "agent-a", ["backend"]);
  const bEnv = await writeCapabilitySpec(workspace, "agent-b", ["backend"]);
  process.env[aEnv] = process.execPath;
  process.env[bEnv] = process.execPath;
  await seedHistoryJob(workspace, "h1", "agent-a", "failed");
  await seedHistoryJob(workspace, "h2", "agent-a", "failed");
  await seedHistoryJob(workspace, "h3", "agent-b", "done");
  try {
    const decision = await routeReviewExecutor({
      task: "实现 backend API",
      workspace,
      primary: "codebuddy",
    });
    assert.ok(decision);
    // primary=codebuddy 不在候选；agent-b 战绩更优 → 胜出
    assert.equal(decision.executor, "agent-b");
    assert.ok(decision.notes.some((n) => n.includes("同层决胜")));
  } finally {
    delete process.env[aEnv];
    delete process.env[bEnv];
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

test("parseRoutingStrategy: 合法值通过，非法值拒绝", () => {
  assert.equal(parseRoutingStrategy("best"), "best");
  assert.equal(parseRoutingStrategy("cheapest"), "cheapest");
  assert.equal(parseRoutingStrategy("fastest"), "fastest");
  assert.throws(() => parseRoutingStrategy("cheap"), /未知路由策略/);
  assert.throws(() => parseRoutingStrategy(42), /未知路由策略/);
});

test("策略 cheapest：能力同层按均值 token 升序选优", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-route-cheap-"));
  const aEnv = await writeCapabilitySpec(workspace, "agent-a", ["react"]);
  const bEnv = await writeCapabilitySpec(workspace, "agent-b", ["react"]);
  process.env[aEnv] = process.execPath;
  process.env[bEnv] = process.execPath;
  await seedHistoryJob(workspace, "h1", "agent-a", "done", { tokenUsage: 5_000 });
  await seedHistoryJob(workspace, "h2", "agent-b", "done", { tokenUsage: 1_000 });
  try {
    const decision = await routeStageExecutor({
      task: "写一个 React 组件",
      workspace,
      strategy: "cheapest",
    });
    assert.ok(decision);
    // 成功率同为 1/1，cheapest 按均值 token 选 agent-b
    assert.equal(decision.executor, "agent-b");
    assert.ok(decision.notes.some((n) => n.includes("策略 cheapest") && n.includes("1000")));
  } finally {
    delete process.env[aEnv];
    delete process.env[bEnv];
  }
});

test("策略 fastest：能力同层按任务墙钟升序选优", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-route-fast-"));
  const aEnv = await writeCapabilitySpec(workspace, "agent-a", ["react"]);
  const bEnv = await writeCapabilitySpec(workspace, "agent-b", ["react"]);
  process.env[aEnv] = process.execPath;
  process.env[bEnv] = process.execPath;
  await seedHistoryJob(workspace, "h1", "agent-a", "done", {
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:10:00.000Z", // 10 分钟
  });
  await seedHistoryJob(workspace, "h2", "agent-b", "done", {
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:01:00.000Z", // 1 分钟
  });
  try {
    const decision = await routeStageExecutor({
      task: "写一个 React 组件",
      workspace,
      strategy: "fastest",
    });
    assert.ok(decision);
    assert.equal(decision.executor, "agent-b");
    assert.ok(decision.notes.some((n) => n.includes("策略 fastest") && n.includes("60000")));
  } finally {
    delete process.env[aEnv];
    delete process.env[bEnv];
  }
});

test("策略 cheapest：同层无 token 样本时降级战绩决胜并记 note", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-route-cheap-dflt-"));
  const aEnv = await writeCapabilitySpec(workspace, "agent-a", ["react"]);
  const bEnv = await writeCapabilitySpec(workspace, "agent-b", ["react"]);
  process.env[aEnv] = process.execPath;
  process.env[bEnv] = process.execPath;
  // 只有状态历史，无 tokenUsage → cheapest 无指标样本
  await seedHistoryJob(workspace, "h1", "agent-b", "done");
  try {
    const decision = await routeStageExecutor({
      task: "写一个 React 组件",
      workspace,
      strategy: "cheapest",
    });
    assert.ok(decision);
    // 降级 best：agent-b 成功率更高 → 胜出
    assert.equal(decision.executor, "agent-b");
    assert.ok(decision.notes.some((n) => n.includes("降级为战绩决胜")));
  } finally {
    delete process.env[aEnv];
    delete process.env[bEnv];
  }
});

test("策略 cheapest：多跑零成的 agent 剔除（便宜是失败假象）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-route-cheap-broken-"));
  const aEnv = await writeCapabilitySpec(workspace, "agent-a", ["react"]);
  const cEnv = await writeCapabilitySpec(workspace, "agent-c", ["react"]);
  process.env[aEnv] = process.execPath;
  process.env[cEnv] = process.execPath;
  // agent-c：2 跑 0 成但只烧 100 token（快速失败）；agent-a：1 成 5000 token
  await seedHistoryJob(workspace, "h1", "agent-a", "done", { tokenUsage: 5_000 });
  await seedHistoryJob(workspace, "h2", "agent-c", "failed", { tokenUsage: 100 });
  await seedHistoryJob(workspace, "h3", "agent-c", "failed", { tokenUsage: 100 });
  try {
    const decision = await routeStageExecutor({
      task: "写一个 React 组件",
      workspace,
      strategy: "cheapest",
    });
    assert.ok(decision);
    // agent-c 被剔除（runs>=2 且 done=0），cheapest 选 agent-a
    assert.equal(decision.executor, "agent-a");
    assert.ok(decision.notes.some((n) => n.includes("agent-c")));
  } finally {
    delete process.env[aEnv];
    delete process.env[cEnv];
  }
});
