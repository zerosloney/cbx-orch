import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, jobDir } from "../src/core.js";
import { DEFAULT_TOKEN_BUDGET } from "../src/context-pack.js";

// 补测 jobs.ts normalizeContextBudget 分支（L17-28 未覆盖）。
// normalizeContextBudget 是内部函数，通过 createJob 间接调用。
// 覆盖目标：有 tokenBudget 对象时 pick 有效值/缺失值回退默认。

test("createJob: context.tokenBudget 部分角色提供值，其余回退默认", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-jobs-budget-"));
  await writeFile(
    path.join(ws, ".cbx.json"),
    JSON.stringify({
      context: { tokenBudget: { manager: 500, executor: 700 } },
    }),
    "utf8",
  );
  const { jobId, directory } = await createJob({
    workspace: ws,
    task: "budget test",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "budget-test",
  });
  assert.equal(jobId, "budget-test");
  const ctx = JSON.parse(await readFile(path.join(directory, "context.json"), "utf8")) as {
    contextBudget: { manager: number; executor: number; auditor: number };
  };
  assert.equal(ctx.contextBudget.manager, 500);
  assert.equal(ctx.contextBudget.executor, 700);
  assert.equal(ctx.contextBudget.auditor, DEFAULT_TOKEN_BUDGET.auditor);
});

test("createJob: context.tokenBudget 全部角色提供有效值", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-jobs-budget-full-"));
  await writeFile(
    path.join(ws, ".cbx.json"),
    JSON.stringify({
      context: { tokenBudget: { manager: 200, executor: 300, auditor: 400 } },
    }),
    "utf8",
  );
  const { directory } = await createJob({
    workspace: ws,
    task: "full budget",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "full-budget",
  });
  const ctx = JSON.parse(await readFile(path.join(directory, "context.json"), "utf8")) as {
    contextBudget: { manager: number; executor: number; auditor: number };
  };
  assert.equal(ctx.contextBudget.manager, 200);
  assert.equal(ctx.contextBudget.executor, 300);
  assert.equal(ctx.contextBudget.auditor, 400);
});

test("createJob: 无 context.tokenBudget 时使用全默认值", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-jobs-budget-default-"));
  const { directory } = await createJob({
    workspace: ws,
    task: "default budget",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "default-budget",
  });
  const ctx = JSON.parse(await readFile(path.join(directory, "context.json"), "utf8")) as {
    contextBudget: { manager: number; executor: number; auditor: number };
  };
  assert.deepEqual(ctx.contextBudget, DEFAULT_TOKEN_BUDGET);
});
