import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectExecutorStats,
  smoothedSuccessRate,
  type ExecutorStats,
} from "../src/executors/stats.js";
import { renderAgentsTable } from "../src/formatting.js";
import type { AgentProbe } from "../src/agent-registry.js";

// 执行器战绩层测试：历史聚合口径（终态过滤/归因/均值）、平滑成功率先验、表格渲染。

async function seedHistoryJob(
  workspace: string,
  jobId: string,
  executor: string | null,
  status: string,
  extra: { tokenUsage?: number; updatedAt?: string } = {},
): Promise<void> {
  const dir = path.join(workspace, ".cbx", "jobs", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({
      jobId,
      status,
      updatedAt: extra.updatedAt ?? "2026-08-01T00:00:00.000Z",
      ...(extra.tokenUsage !== undefined ? { tokenUsage: extra.tokenUsage } : {}),
    }),
    "utf8",
  );
  if (executor !== null)
    await writeFile(
      path.join(dir, "context.json"),
      JSON.stringify({ executor }),
      "utf8",
    );
}

test("collectExecutorStats: 终态过滤、归因与 token 均值口径", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-stats-"));
  await seedHistoryJob(workspace, "a1", "alpha", "done", { tokenUsage: 1_000 });
  await seedHistoryJob(workspace, "a2", "alpha", "failed", { tokenUsage: 3_000 });
  await seedHistoryJob(workspace, "a3", "beta", "done");
  // cancelled / running 不计入（用户中止 / 未有结论）
  await seedHistoryJob(workspace, "b1", "beta", "cancelled");
  await seedHistoryJob(workspace, "b2", "beta", "running");
  // 缺 context.json（无法归因）与 awaiting_approval（未有结论）整体跳过
  await seedHistoryJob(workspace, "c1", null, "done");
  await seedHistoryJob(workspace, "d1", "delta", "awaiting_approval");

  const stats = await collectExecutorStats(workspace);
  assert.equal(stats.size, 2);
  const alpha = stats.get("alpha")!;
  assert.equal(alpha.runs, 2);
  assert.equal(alpha.done, 1);
  assert.equal(alpha.successRate, 0.5);
  assert.equal(alpha.avgTokens, 2_000);
  const beta = stats.get("beta")!;
  assert.equal(beta.runs, 1);
  assert.equal(beta.done, 1);
  assert.equal(beta.avgTokens, null);
});

test("collectExecutorStats: lastUsedAt 取最新 updatedAt；损坏/缺失目录容忍", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-stats-latest-"));
  await seedHistoryJob(workspace, "a1", "alpha", "done", {
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  await seedHistoryJob(workspace, "a2", "alpha", "done", {
    updatedAt: "2026-08-05T00:00:00.000Z",
  });
  const stats = await collectExecutorStats(workspace);
  assert.equal(stats.get("alpha")!.lastUsedAt, "2026-08-05T00:00:00.000Z");

  // 无 .cbx/jobs 的 workspace → 空表
  const empty = await mkdtemp(path.join(os.tmpdir(), "cbx-stats-empty-"));
  assert.equal((await collectExecutorStats(empty)).size, 0);
});

test("smoothedSuccessRate: 无历史中性先验 0.5，小样本不被极端化", () => {
  assert.equal(smoothedSuccessRate(undefined), 0.5);
  const oneRunOneDone = { runs: 1, done: 1 } as ExecutorStats;
  assert.ok(Math.abs(smoothedSuccessRate(oneRunOneDone) - 2 / 3) < 1e-9);
  const fourRunZeroDone = { runs: 4, done: 0 } as ExecutorStats;
  assert.ok(Math.abs(smoothedSuccessRate(fourRunZeroDone) - 1 / 6) < 1e-9);
  const perfectTen = { runs: 10, done: 10 } as ExecutorStats;
  assert.ok(Math.abs(smoothedSuccessRate(perfectTen) - 11 / 12) < 1e-9);
});

test("renderAgentsTable: 战绩列展示，无历史显示 —", () => {
  const probes: AgentProbe[] = [
    {
      name: "alpha",
      label: "Alpha",
      source: "builtin",
      aliases: [],
      capabilities: ["react"],
      available: true,
      command: ["alpha"],
    },
    {
      name: "beta",
      label: "Beta",
      source: "builtin",
      aliases: [],
      capabilities: [],
      available: false,
      command: null,
    },
  ];
  const stats = new Map<string, ExecutorStats>([
    [
      "alpha",
      {
        executor: "alpha",
        runs: 4,
        done: 3,
        successRate: 0.75,
        avgTokens: 1_234,
        avgDurationMs: 40_000,
        lastUsedAt: "2026-08-05T00:00:00.000Z",
      },
    ],
  ]);
  const table = renderAgentsTable(probes, [], stats);
  assert.ok(table.includes("Runs"));
  assert.ok(table.includes("75%"));
  assert.ok(table.includes("1234"));
  assert.ok(table.includes("AvgSec"));
  assert.ok(table.includes("40"));
  // beta 无历史 → 战绩列为 —（不含成功率百分比）
  const betaRow = table.split("\n").find((line) => line.includes("Beta"))!;
  assert.ok(!betaRow.includes("%"), "无历史的 agent 不应渲染成功率");
});
