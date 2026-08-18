import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approveJob,
  approveJobAndStart,
  createJob,
  executeJob,
  jobDir,
} from "../src/core.js";
import { savePersistedState } from "../src/storage.js";
import { saveJson } from "../src/file-utils.js";
import { setupFake } from "./helpers.js";

// 补测 approval.ts 未覆盖分支：
// - L23-27: 缺少 humanGate 且 phase 不匹配 → 抛 E_STATE_CONFLICT
// - L132-134: approveJobAndStart → status==="queued" → startBackground 重新入队

test("approveJob: 缺少 humanGate 且 phase 非 before_run/before_complete 时抛错", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-approve-nogate-"));
  const jobId = "nogate-test";
  const directory = jobDir(ws, jobId);
  // 创建 job 目录（approveJob 内部 withFileLock 需要 run.lock 路径存在）
  await mkdir(directory, { recursive: true });
  // 手动构造异常状态：awaiting_approval 但无 humanGate，phase 不匹配任何已知分支
  const state = {
    jobId,
    status: "awaiting_approval",
    phase: "unknown_phase",
    workspace: ws,
    jobDir: directory,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempt: 0,
  };
  await savePersistedState(ws, jobId, state);
  await saveJson(path.join(directory, "state.json"), state);
  // approveJob → approveJobLocked → state.humanGate 假 → phase 不匹配 → 抛错
  await assert.rejects(
    () => approveJob(ws, jobId),
    /缺少 Human Gate/,
  );
});

test("approveJobAndStart: before_run 审批后自动入队并执行完成", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "approveAndStart",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    approvalBeforeRun: true,
    jobId: "approve-start",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const waiting = await executeJob(workspace, job.jobId);
  assert.equal(waiting.status, "awaiting_approval");
  // approveJobAndStart = approveJob + startBackground（重新入队）
  const approved = await approveJobAndStart(workspace, job.jobId);
  assert.equal(approved.status, "queued");
  assert.equal(
    (approved.humanGate as { status: string }).status,
    "resolved",
  );
  // executeJob 直接执行（跳过队列调度器）验证任务能正常完成
  const done = await executeJob(workspace, job.jobId);
  assert.equal(done.status, "done");
});
