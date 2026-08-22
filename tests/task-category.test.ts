import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyTask,
  isTaskCategory,
  TASK_CATEGORIES,
} from "../src/task-category.js";
import { collectExecutorStats } from "../src/executors/stats.js";
import { routeStageExecutor } from "../src/executors/route.js";
import { agentDirs } from "../src/agent-registry.js";
import { createJob, executeJob, setupFake } from "./helpers.js";

// 任务分类加权测试：确定性分类、战绩 (executor × 分类) 聚合、路由分类感知决胜、context 持久化。

test("classifyTask: 规则命中与优先级（bugfix > feature 等表述重叠场景）", () => {
  assert.equal(classifyTask("修复登录页在提交时报错的缺陷"), "bugfix");
  assert.equal(classifyTask("fix the broken import"), "bugfix"); // ASCII fix 词边界
  assert.equal(classifyTask("优化接口性能，列表太慢"), "performance");
  assert.equal(classifyTask("重构数据访问层，把 SQL 拼接抽离"), "refactor");
  assert.equal(classifyTask("为订单模块补测试，提升覆盖率"), "testing");
  assert.equal(classifyTask("补充 README 的部署文档"), "docs");
  assert.equal(classifyTask("实现并接入新的支付功能"), "feature");
  // 修复表述包含实现动词 → bugfix 优先（规则顺序即意图优先级）
  assert.equal(classifyTask("实现修复补丁的回归验证脚本时顺手修复 bug"), "bugfix");
  assert.equal(classifyTask("随便看看"), "chore");
});

test("isTaskCategory: 全集成员通过，非成员与非法类型拒绝", () => {
  for (const category of TASK_CATEGORIES)
    assert.ok(isTaskCategory(category), category);
  assert.ok(!isTaskCategory("misc"));
  assert.ok(!isTaskCategory(42));
  assert.ok(!isTaskCategory(undefined));
});

async function seedCategorizedJob(
  workspace: string,
  jobId: string,
  executor: string,
  status: string,
  category?: string,
): Promise<void> {
  const dir = path.join(workspace, ".cbx", "jobs", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({
      jobId,
      status,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:10:00.000Z",
    }),
    "utf8",
  );
  await writeFile(
    path.join(dir, "context.json"),
    JSON.stringify({ executor, ...(category ? { taskCategory: category } : {}) }),
    "utf8",
  );
}

test("collectExecutorStats: 按 (executor × 分类) 聚合，旧任务无分类只进全局", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cat-stats-"));
  await seedCategorizedJob(workspace, "a1", "agent-a", "done", "bugfix");
  await seedCategorizedJob(workspace, "a2", "agent-a", "done", "bugfix");
  await seedCategorizedJob(workspace, "a3", "agent-a", "failed", "feature");
  await seedCategorizedJob(workspace, "a4", "agent-a", "done"); // 无分类（旧任务）
  const stats = await collectExecutorStats(workspace);
  const alpha = stats.get("agent-a")!;
  assert.equal(alpha.runs, 4);
  assert.equal(alpha.done, 3);
  assert.deepEqual(alpha.categories, {
    bugfix: { runs: 2, done: 2 },
    feature: { runs: 1, done: 0 },
  });
});

test("路由分类感知决胜：分类样本推翻全局口径", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cat-route-"));
  for (const name of ["agent-a", "agent-b"]) {
    await mkdir(agentDirs(workspace).workspace, { recursive: true });
    await writeFile(
      path.join(agentDirs(workspace).workspace, `${name}.json`),
      JSON.stringify({
        name,
        label: name,
        candidates: [`cbx-${name}-cli`],
        args: ["run", "{prompt}"],
        capabilities: ["react"],
      }),
      "utf8",
    );
    process.env[`CBX_${name.replace(/-/g, "_").toUpperCase()}`] = process.execPath;
  }
  // agent-a：feature 5/5（全局 6 跑 5 成，平滑 0.75）但 bugfix 0/1（桶平滑 0.33）
  await seedCategorizedJob(workspace, "a1", "agent-a", "failed", "bugfix");
  for (let i = 0; i < 5; i += 1)
    await seedCategorizedJob(workspace, `af${i}`, "agent-a", "done", "feature");
  // agent-b：bugfix 1/1（桶平滑 0.67）但全局 3 跑 1 成（平滑 0.4）
  await seedCategorizedJob(workspace, "b1", "agent-b", "done", "bugfix");
  await seedCategorizedJob(workspace, "b2", "agent-b", "failed", "feature");
  await seedCategorizedJob(workspace, "b3", "agent-b", "failed", "feature");
  try {
    // bugfix 任务：全局口径会选 agent-a，分类口径正确翻转到 agent-b
    const bugfix = await routeStageExecutor({
      task: "修复 React 组件渲染的 bug",
      workspace,
    });
    assert.ok(bugfix);
    assert.equal(bugfix.executor, "agent-b");
    assert.ok(bugfix.notes.some((n) => n.includes("分类 bugfix")));
    assert.ok(bugfix.notes.some((n) => n.includes("bugfix 1/1")));
    // feature 任务：分类口径与全局一致选 agent-a
    const feature = await routeStageExecutor({
      task: "实现 React 新组件",
      workspace,
    });
    assert.ok(feature);
    assert.equal(feature.executor, "agent-a");
  } finally {
    delete process.env.CBX_AGENT_A;
    delete process.env.CBX_AGENT_B;
  }
});

test("createJob 持久化 taskCategory 到 context.json", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "修复空指针导致的崩溃",
    review: false,
    isolated: false,
    executor: "codebuddy",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "category-persist",
  });
  const context = JSON.parse(
    await readFile(path.join(job.directory, "context.json"), "utf8"),
  ) as { taskCategory: string };
  assert.equal(context.taskCategory, "bugfix");
});

test("model 选择：spec.modelArg + 任务 model 渲染到 spawn 参数（e2e）", async () => {
  const { workspace, script } = await setupFake();
  await mkdir(agentDirs(workspace).workspace, { recursive: true });
  await writeFile(
    path.join(agentDirs(workspace).workspace, "modelagent.json"),
    JSON.stringify({
      name: "modelagent",
      label: "Model Agent",
      candidates: ["cbx-modelagent-cli"],
      args: ["run", "{prompt}"],
      modelArg: "--model",
    }),
    "utf8",
  );
  process.env.CBX_MODELAGENT = script;
  const job = await createJob({
    workspace,
    task: "实现一个工具函数",
    testCommand: 'node -e "process.exit(0)"',
    review: false,
    isolated: false,
    executor: "modelagent",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    model: "test-model-x",
    jobId: "model-selection",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  try {
    const state = await executeJob(workspace, job.jobId);
    assert.equal(state.status, "done");
    const events = await readFile(
      path.join(job.directory, "events.ndjson"),
      "utf8",
    );
    const started = events
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.event === "process_started");
    const command = started.command as string[];
    const modelIndex = command.indexOf("--model");
    assert.ok(modelIndex >= 0, `--model 应出现在参数中：${command.join(" ")}`);
    assert.equal(command[modelIndex + 1], "test-model-x");
    // model 持久化到 context（审计/重试一致性）
    const context = JSON.parse(
      await readFile(path.join(job.directory, "context.json"), "utf8"),
    ) as { model: string };
    assert.equal(context.model, "test-model-x");
  } finally {
    delete process.env.CBX_MODELAGENT;
    process.env.FAKE_JOB_DIR = "";
  }
});
