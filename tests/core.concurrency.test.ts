import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, loadState, listJobs } from "../src/core.js";

/**
 * 确定性并发回归测试：覆盖 storage.ts 中 database() 的 Promise 缓存并发去重。
 *
 * 背景：database() 使用 Map<string, Promise<CbxDatabase>> 缓存同 workspace 的连接 Promise。
 * 并发调用同 workspace 的 createJob 会经 savePersistedState -> database(workspace) 触发缓存。
 * 若缓存正常：单连接，无 SQLite busy/migrate 冲突；若缓存有 bug：可能触发重复 migrate、WAL 冲突。
 *
 * 约束：纯单进程 async 并发（Promise.all），不 spawn 子进程，不用 sleep/wall-clock。
 */
test("并发 createJob（同 workspace、不同 jobId）经 Promise.all 全部成功，验证 database Promise 缓存去重", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-concurrent-createJob-"),
  );
  const jobId1 = "concurrent-a";
  const jobId2 = "concurrent-b";
  const jobId3 = "concurrent-c";

  // 并发创建 3 个 job，触发并发 database(workspace) 调用
  const [job1, job2, job3] = await Promise.all([
    createJob({
      workspace,
      task: "并发任务 A",
      review: false,
      isolated: false,
      permissionMode: "auto",
      maxTurns: 5,
      jobId: jobId1,
    }),
    createJob({
      workspace,
      task: "并发任务 B",
      review: false,
      isolated: false,
      permissionMode: "auto",
      maxTurns: 5,
      jobId: jobId2,
    }),
    createJob({
      workspace,
      task: "并发任务 C",
      review: false,
      isolated: false,
      permissionMode: "auto",
      maxTurns: 5,
      jobId: jobId3,
    }),
  ]);

  // 1. 全部 resolve
  assert.ok(job1, "job1 应 resolve");
  assert.ok(job2, "job2 应 resolve");
  assert.ok(job3, "job3 应 resolve");

  // 2. 3 个 jobId 各异
  assert.notEqual(job1.jobId, job2.jobId);
  assert.notEqual(job1.jobId, job3.jobId);
  assert.notEqual(job2.jobId, job3.jobId);
  assert.equal(job1.jobId, jobId1);
  assert.equal(job2.jobId, jobId2);
  assert.equal(job3.jobId, jobId3);

  // 3. 各自 loadState 可读回
  const state1 = await loadState(workspace, jobId1);
  const state2 = await loadState(workspace, jobId2);
  const state3 = await loadState(workspace, jobId3);

  assert.equal(state1.jobId, jobId1);
  assert.equal(state2.jobId, jobId2);
  assert.equal(state3.jobId, jobId3);
  assert.equal(state1.status, "queued");
  assert.equal(state2.status, "queued");
  assert.equal(state3.status, "queued");

  // 4. 目录与 state.json 落盘正常
  assert.ok(job1.directory.includes(jobId1));
  assert.ok(job2.directory.includes(jobId2));
  assert.ok(job3.directory.includes(jobId3));

  // 5. listJobs 可见 3 个 job
  const all = await listJobs(workspace);
  const ids = all.map((j) => j.jobId).sort();
  assert.deepEqual(ids, [jobId1, jobId2, jobId3]);
});

test("并发 loadState（同 workspace、相同 jobId）多次并发读取，返回一致 state 且不抛错", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-concurrent-loadState-"),
  );
  const job = await createJob({
    workspace,
    task: "并发读取",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "concurrent-read",
  });

  // 并发多次读取同一 job 的 state，验证缓存与并发安全
  const [s1, s2, s3, s4, s5] = await Promise.all([
    loadState(workspace, job.jobId),
    loadState(workspace, job.jobId),
    loadState(workspace, job.jobId),
    loadState(workspace, job.jobId),
    loadState(workspace, job.jobId),
  ]);

  // 全部 resolve 且内容一致
  for (const s of [s1, s2, s3, s4, s5]) {
    assert.equal(s.jobId, job.jobId);
    assert.equal(s.status, "queued");
    assert.equal(s.phase, "queued");
  }
});
