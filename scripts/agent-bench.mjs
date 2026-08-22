#!/usr/bin/env node
// Agent 基准校准：对每个可用的执行器跑一套小任务，测量真实成功率 / token / 墙钟。
// 结果不落新持久化——它输出的是与战绩层（executors/stats.ts）同口径的数字，
// 把基准任务跑在真实 workspace 即可自然喂给 auto 路由的战绩决胜与分类加权。
//
// 用法：
//   npm run build && npm run bench:agents                        # 全部可用执行器 × 内置套件
//   npm run bench:agents -- --executor qwen                       # 只校准指定执行器（可重复）
//   npm run bench:agents -- --tasks my-bench.json                 # 自定义套件
//   npm run bench:agents -- --timeout-ms 600000 --max-turns 30
//
// 内置套件：每个任务在全新临时 git 仓库中执行（种子文件先提交），互不污染、可重放。
// 自定义套件 JSON：[{ "task": "...", "test": "node -e ...", "seed": [{ "path": "...", "body": "..." }] }]
//
// 注意：会真实调用编码 CLI（消耗 token / 网络 / 凭据），仅适合本地人工或手动触发，
// 不属于 npm test 默认套件。任何执行器 0 成功 → 非零退出（校准信号：该 agent 不可用）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { discoverAgents } from "../dist/src/agent-registry.js";
import { createJob, executeJob } from "../dist/src/core.js";
import { classifyTask } from "../dist/src/task-category.js";

/** 内置基准套件：小、确定、可机器验证（test 命令即验收标准）。 */
const BUILTIN_TASKS = [
  {
    id: "feature-add",
    task: "实现 utils/add.js：导出 add(a, b)，返回两数之和。不要修改其他文件。",
    test: "node -e \"const {add}=require('./utils/add.js'); if(add(2,3)!==5||add(-1,1)!==0) process.exit(1)\"",
  },
  {
    id: "bugfix-sub",
    task: "修复 utils/sub.js 中 subtract 的缺陷：当前错误地返回 a+b，应返回 a-b。只改这一处。",
    test: "node -e \"const {subtract}=require('./utils/sub.js'); if(subtract(5,3)!==2||subtract(0,1)!==-1) process.exit(1)\"",
    seed: [
      {
        path: "utils/sub.js",
        body: "function subtract(a, b) {\n  return a + b;\n}\nmodule.exports = { subtract };\n",
      },
    ],
  },
  {
    id: "feature-reverse",
    task: "实现 utils/reverse.js：导出 reverse(text)，返回字符反转后的字符串。",
    test: "node -e \"const {reverse}=require('./utils/reverse.js'); if(reverse('abc')!=='cba'||reverse('')!=='') process.exit(1)\"",
  },
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const executors = args
  .filter((_, i) => args[i - 1] === "--executor")
  .filter(Boolean);
const tasksFile = flag("--tasks");
const timeoutMs = Number(flag("--timeout-ms", 300_000));
const maxTurns = Number(flag("--max-turns", 25));

function makeBenchRepo(task) {
  const ws = mkdtempSync(path.join(os.tmpdir(), "cbx-bench-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: ws, stdio: "ignore" });
  for (const file of task.seed ?? []) {
    const target = path.join(ws, ...file.path.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.body, "utf8");
  }
  writeFileSync(path.join(ws, "README.md"), "cbx agent bench\n", "utf8");
  spawnSync("git", ["add", "."], { cwd: ws, stdio: "ignore" });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "cbx-bench",
    GIT_AUTHOR_EMAIL: "bench@cbx.test",
    GIT_COMMITTER_NAME: "cbx-bench",
    GIT_COMMITTER_EMAIL: "bench@cbx.test",
  };
  spawnSync("git", ["commit", "-m", "init", "--no-verify"], {
    cwd: ws,
    stdio: "ignore",
    env: gitEnv,
  });
  return ws;
}

async function main() {
  const tasks = tasksFile
    ? JSON.parse(await readFile(tasksFile, "utf8"))
    : BUILTIN_TASKS;
  if (!Array.isArray(tasks) || tasks.some((t) => !t.task || !t.test))
    throw new Error("基准套件必须是 [{task, test, seed?}] 数组。");

  const { probes } = await discoverAgents(process.cwd());
  const candidates = probes.filter(
    (p) =>
      p.available &&
      (executors.length === 0 ||
        executors.includes(p.name) ||
        p.aliases.some((a) => executors.includes(a))),
  );
  if (candidates.length === 0) {
    console.error("没有可用的执行器（探测均不可用或 --executor 过滤为空）。");
    process.exit(1);
  }
  console.log(
    `校准 ${candidates.map((p) => p.name).join(", ")} × ${tasks.length} 个任务（超时 ${timeoutMs}ms，轮次上限 ${maxTurns}）\n`,
  );

  const results = [];
  for (const probe of candidates) {
    for (const task of tasks) {
      const category = classifyTask(task.task);
      const ws = makeBenchRepo(task);
      const jobId = `bench-${probe.name}-${task.id}-${Date.now()}`.replace(
        /[^a-zA-Z0-9-]/g,
        "-",
      );
      process.stdout.write(`▶ ${probe.name} / ${task.id}（${category}）… `);
      try {
        const job = await createJob({
          workspace: ws,
          task: task.task,
          testCommand: task.test,
          review: false,
          isolated: false,
          executor: probe.name,
          permissionMode: "auto",
          maxTurns,
          timeoutMs,
          maxRetries: 0,
          jobId,
        });
        const state = await executeJob(ws, job.jobId);
        const durationMs =
          Date.parse(state.updatedAt) - Date.parse(state.createdAt);
        results.push({
          executor: probe.name,
          task: task.id,
          category,
          status: state.status,
          tokens: state.tokenUsage ?? null,
          durationMs: Number.isFinite(durationMs) ? durationMs : null,
        });
        console.log(
          `${state.status}（${Math.round(durationMs / 1000)}s，token ${state.tokenUsage ?? "?"}）`,
        );
      } catch (error) {
        results.push({
          executor: probe.name,
          task: task.id,
          category,
          status: "error",
          tokens: null,
          durationMs: null,
        });
        console.log(`error：${error instanceof Error ? error.message : error}`);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    }
  }

  // 汇总（与战绩层同口径：成功率、均值 token、任务墙钟、分类分布）
  console.log("\n===== 校准汇总 =====");
  const byExecutor = new Map();
  for (const row of results) {
    const entry =
      byExecutor.get(row.executor) ??
      { runs: 0, done: 0, tokens: [], durations: [], categories: new Map() };
    entry.runs += 1;
    if (row.status === "done") entry.done += 1;
    if (row.tokens != null) entry.tokens.push(row.tokens);
    if (row.durationMs != null) entry.durations.push(row.durationMs);
    const cat = entry.categories.get(row.category) ?? { runs: 0, done: 0 };
    cat.runs += 1;
    if (row.status === "done") cat.done += 1;
    entry.categories.set(row.category, cat);
    byExecutor.set(row.executor, entry);
  }
  for (const [executor, entry] of byExecutor) {
    const avg = (list) =>
      list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null;
    const cats = [...entry.categories.entries()]
      .map(([name, c]) => `${name} ${c.done}/${c.runs}`)
      .join("，");
    console.log(
      `${executor}: ${entry.done}/${entry.runs} 成 | 均 token ${avg(entry.tokens) ?? "?"} | 均墙钟 ${Math.round((avg(entry.durations) ?? 0) / 1000)}s | ${cats}`,
    );
  }
  const broken = [...byExecutor.entries()].filter(([, e]) => e.done === 0);
  if (broken.length > 0) {
    console.error(
      `\n以下执行器 0 成功（校准信号：agent 不可用或契约不兼容）：${broken.map(([n]) => n).join(", ")}`,
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
