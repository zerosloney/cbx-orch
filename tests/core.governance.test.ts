import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  fakeAgent,
  setupFake,
  createAdaptiveJob,
  initializeGitWorkspace,
  approveJob,
  cancelJob,
  createJob,
  executeJob,
  health,
  listJobs,
  listQueue,
  loadConfig,
  loadState,
  mergeConfig,
  pauseQueue,
  readArtifact,
  readEventsIncremental,
  resumeQueue,
  retryQueueJob,
  serveQueue,
  startBackground,
  runReviewGate,
  stopReviewGateHook,
  acquireServiceLease,
  loadPersistedQueue,
  loadPersistedState,
  savePersistedStateAndQueue,
  BUILTIN_EXECUTORS,
  resolveExecutor,
  parseNextAction,
  CONTEXT_PACK_MAX_CHARS,
  parseContextPack,
  createHumanGate,
  extendRoundLimit,
  parseHumanGate,
  resolveHumanGate,
  type JobState,
} from "./helpers.js";

test("dispatchQueue reclaims a running entry whose worker never started (no heartbeat, past grace)", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ maxConcurrent: 1 }),
    "utf8",
  );
  const job = await createJob({
    workspace,
    task: "僵尸 worker",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "zombie",
  });
  // 手工注入一个 running entry，pid 指向当前进程（processAlive=true）但无 heartbeat 且 startedAt 远超 grace
  const fakeOldStartedAt = new Date(Date.now() - 120_000).toISOString();
  await savePersistedStateAndQueue(
    workspace,
    job.jobId,
    { ...(await loadState(workspace, job.jobId)), status: "running" },
    {
      maxConcurrent: 1,
      paused: true,
      updatedAt: new Date().toISOString(),
      entries: [
        {
          queueId: "zombie-entry",
          jobId: job.jobId,
          workspace,
          extra: "",
          status: "running",
          createdAt: fakeOldStartedAt,
          startedAt: fakeOldStartedAt,
          pid: process.pid,
          priority: 0,
        },
      ],
    },
  );
  // 确认无 heartbeat 文件
  assert.equal(existsSync(path.join(job.directory, "worker.heartbeat")), false);
  await (await import("../src/core.js")).dispatchQueue(workspace);
  const after = (await listQueue(workspace)).entries.find(
    (e) => e.queueId === "zombie-entry",
  );
  // 进程虽活但无 heartbeat 且超 grace → 应回收（paused 阻止重 spawn，entry 应落到 queued）
  assert.equal(
    after?.status,
    "queued",
    "stale entry should be reclaimed to queued despite live pid",
  );
});

test("dispatchQueue reclaims a live pid whose heartbeat stopped advancing", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ maxConcurrent: 1 }),
    "utf8",
  );
  const job = await createJob({
    workspace,
    task: "停止心跳",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "stale-heartbeat",
  });
  const staleAt = new Date(Date.now() - 120_000);
  const heartbeat = path.join(job.directory, "worker.heartbeat");
  await writeFile(heartbeat, staleAt.toISOString(), "utf8");
  await utimes(heartbeat, staleAt, staleAt);
  await savePersistedStateAndQueue(
    workspace,
    job.jobId,
    { ...(await loadState(workspace, job.jobId)), status: "running" },
    {
      maxConcurrent: 1,
      paused: true,
      updatedAt: new Date().toISOString(),
      entries: [
        {
          queueId: "stale-heartbeat-entry",
          jobId: job.jobId,
          workspace,
          extra: "",
          status: "running",
          createdAt: staleAt.toISOString(),
          startedAt: staleAt.toISOString(),
          pid: process.pid,
          priority: 0,
        },
      ],
    },
  );
  await (await import("../src/core.js")).dispatchQueue(workspace);
  assert.equal(
    (await listQueue(workspace)).entries.find(
      (entry) => entry.queueId === "stale-heartbeat-entry",
    )?.status,
    "queued",
  );
});
