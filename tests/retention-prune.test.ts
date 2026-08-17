import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  createJob,
  listJobs,
  loadConfig,
  loadState,
} from "../src/core.js";
import { pruneAfterTerminal, pruneExpiredJobs } from "../src/state.js";
import {
  getMetadata,
  savePersistedState,
} from "../src/storage.js";
import { createWebUiServer } from "../src/ui.js";
import { setupFake } from "./helpers.js";

const cliPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "cli.js",
);

/** 直接把 SQLite 里 job 的 updated_at（列 + state_json 内字段）回拨，模拟"很久以前就终态"的任务。 */
function backdateJob(workspace: string, jobId: string, daysAgo: number): void {
  const db = new Database(path.join(workspace, ".cbx", "state.sqlite"));
  try {
    const backdated = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const row = db
      .prepare("SELECT state_json FROM jobs WHERE job_id = ?")
      .get(jobId) as { state_json: string } | undefined;
    assert.ok(row, `回拨失败：${jobId} 不存在`);
    const state = JSON.parse(row.state_json) as Record<string, unknown>;
    state.updatedAt = backdated;
    db.prepare(
      "UPDATE jobs SET updated_at = ?, state_json = ? WHERE job_id = ?",
    ).run(backdated, JSON.stringify(state), jobId);
  } finally {
    db.close();
  }
}

// ---------- G3a: listJobs 分页 ----------

test("listJobs limit 返回最近 N 条（updated_at 倒序），缺省全量向后兼容", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-list-limit-"));
  const now = new Date().toISOString();
  for (const id of ["job-old", "job-mid", "job-new"]) {
    await savePersistedState(workspace, id, {
      jobId: id,
      status: "done",
      phase: "done",
      updatedAt: now,
    });
  }
  backdateJob(workspace, "job-old", 10);
  backdateJob(workspace, "job-mid", 5);

  assert.equal((await listJobs(workspace)).length, 3);
  const limited = await listJobs(workspace, { limit: 2 });
  assert.equal(limited.length, 2);
  assert.deepEqual(
    limited.map((job) => job.jobId),
    ["job-new", "job-mid"],
  );
  assert.deepEqual(
    (await listJobs(workspace, { limit: 1 })).map((job) => job.jobId),
    ["job-new"],
  );
});

// ---------- G3b: pruneExpiredJobs 语义 ----------

test("pruneExpiredJobs 只清理超过保留期的已终态任务", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-prune-expired-"));
  const now = new Date().toISOString();
  await savePersistedState(workspace, "old-done", {
    jobId: "old-done",
    status: "done",
    phase: "done",
    updatedAt: now,
  });
  await savePersistedState(workspace, "recent-done", {
    jobId: "recent-done",
    status: "done",
    phase: "done",
    updatedAt: now,
  });
  await savePersistedState(workspace, "old-fix", {
    jobId: "old-fix",
    status: "needs_fix",
    phase: "reviewing",
    updatedAt: now,
  });
  await savePersistedState(workspace, "active", {
    jobId: "active",
    status: "running",
    phase: "executing",
    updatedAt: now,
  });
  backdateJob(workspace, "old-done", 10);
  backdateJob(workspace, "old-fix", 10);

  const pruned = await pruneExpiredJobs(workspace, 3);
  assert.equal(pruned, 2);
  // 过期终态已删（SQLite + state.json + 目录 + tombstone）
  await assert.rejects(() => loadState(workspace, "old-done"), /不存在/);
  await assert.rejects(() => loadState(workspace, "old-fix"), /不存在/);
  assert.match(
    (await getMetadata(workspace, "forgotten:old-done")) ?? "",
    /^\d{4}-\d{2}-\d{2}T/,
  );
  // 近期终态与活跃任务保留
  assert.equal((await loadState(workspace, "recent-done")).status, "done");
  assert.equal((await loadState(workspace, "active")).status, "running");
});

test("pruneExpiredJobs 永不清理活跃状态（queued/awaiting_approval）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-prune-active-"));
  const now = new Date().toISOString();
  for (const [id, status] of [
    ["q", "queued"],
    ["appr", "awaiting_approval"],
    ["cancelled", "cancelled"],
  ] as const) {
    await savePersistedState(workspace, id, {
      jobId: id,
      status,
      phase: status === "cancelled" ? "cancelled" : "queued",
      updatedAt: now,
    });
    backdateJob(workspace, id, 10);
  }
  const pruned = await pruneExpiredJobs(workspace, 1);
  // cancelled 是终态可清理；queued / awaiting_approval 必须保留
  assert.equal(pruned, 1);
  assert.equal((await loadState(workspace, "q")).status, "queued");
  assert.equal((await loadState(workspace, "appr")).status, "awaiting_approval");
  await assert.rejects(() => loadState(workspace, "cancelled"), /不存在/);
});

test("pruneAfterTerminal 遵循 governance.pruneJobs（默认关闭不删任务）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-prune-policy-"));
  await savePersistedState(workspace, "old-done", {
    jobId: "old-done",
    status: "done",
    phase: "done",
    updatedAt: new Date().toISOString(),
  });
  backdateJob(workspace, "old-done", 10);
  // 无配置：不删 job（保留策略默认关闭）
  await pruneAfterTerminal(workspace);
  assert.equal((await listJobs(workspace)).length, 1);
  // 开启 pruneJobs + retentionDays=1：删
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ governance: { retentionDays: 1, pruneJobs: true } }),
    "utf8",
  );
  await pruneAfterTerminal(workspace);
  assert.equal((await listJobs(workspace)).length, 0);
  // 开启 pruneJobs 但 retentionDays 缺省：不删（无保留期无从判定）
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ governance: { pruneJobs: true } }),
    "utf8",
  );
  await savePersistedState(workspace, "old-done2", {
    jobId: "old-done2",
    status: "done",
    phase: "done",
    updatedAt: new Date().toISOString(),
  });
  backdateJob(workspace, "old-done2", 10);
  await pruneAfterTerminal(workspace);
  assert.equal((await listJobs(workspace)).length, 1);
});

test("strict schema 拒绝未知 governance 字段，接受 pruneJobs", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-prune-schema-"));
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      governance: { pruneJobs: true, retentionDays: 7, bogus: 1 },
    }),
    "utf8",
  );
  await assert.rejects(() => loadConfig(workspace), /bogus/);
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      governance: { pruneJobs: true, retentionDays: 7 },
    }),
    "utf8",
  );
  const config = await loadConfig(workspace);
  assert.equal(config.governance?.pruneJobs, true);
  assert.equal(config.governance?.retentionDays, 7);
});

// ---------- G3a: HTTP 与 CLI 表面 ----------

test("HTTP /api/jobs?limit= 截断列表，非法 limit 返回 400", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-limit-"));
  const now = new Date().toISOString();
  await savePersistedState(workspace, "job-a", {
    jobId: "job-a",
    status: "done",
    phase: "done",
    updatedAt: now,
  });
  await savePersistedState(workspace, "job-b", {
    jobId: "job-b",
    status: "done",
    phase: "done",
    updatedAt: now,
  });
  backdateJob(workspace, "job-a", 5);
  const server = createWebUiServer(workspace, "127.0.0.1", 0);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const limited = await fetch(`http://127.0.0.1:${port}/api/jobs?limit=1`);
    assert.equal(limited.status, 200);
    const limitedBody = (await limited.json()) as Array<{ jobId: string }>;
    assert.equal(limitedBody.length, 1);
    assert.equal(limitedBody[0].jobId, "job-b");
    // 非法 limit
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/jobs?limit=abc`)).status,
      400,
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/jobs?limit=0`)).status,
      400,
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/jobs?limit=10001`)).status,
      400,
    );
    // 缺省全量
    const allBody = (await (
      await fetch(`http://127.0.0.1:${port}/api/jobs`)
    ).json()) as Array<{ jobId: string }>;
    assert.equal(allBody.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("cbx list --limit N 只输出最近 N 条", async () => {
  const { workspace } = await setupFake();
  await createJob({
    workspace,
    task: "job-a",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    jobId: "job-a",
  });
  await createJob({
    workspace,
    task: "job-b",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    jobId: "job-b",
  });
  backdateJob(workspace, "job-a", 5);
  const out = spawnSync(
    process.execPath,
    [cliPath, "list", "--workspace", workspace, "--limit", "1"],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  const jobs = JSON.parse(out.stdout) as Array<{ jobId: string }>;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, "job-b");
  // 非法 limit 报错
  const bad = spawnSync(
    process.execPath,
    [cliPath, "list", "--workspace", workspace, "--limit", "0"],
    { encoding: "utf8" },
  );
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /1 到 10000/);
});
