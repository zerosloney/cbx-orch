import { existsSync } from "node:fs";
import path from "node:path";
import {
  loadJson,
  loadJobContext,
  now,
  withFileLock,
  prunePersistedData,
} from "./storage.js";
import {
  loadState,
  loadConfig,
  writeState,
  writeApprovalState,
  jobDir,
} from "./state.js";
import { contextRedactor } from "./artifacts.js";
import { writeResult } from "./result.js";
import {
  createHumanGate,
  parseHumanGate,
  resolveHumanGate,
} from "./human-gate.js";
import {
  parsePendingCompletion,
  evidenceHashes,
  completionEvidenceValid,
  worktreeSha256,
} from "./evidence.js";
import { snapshotDiff, commitWorktree } from "./git-ops.js";
import { cleanupWorktree } from "./worktree.js";
import type { JobState, Json } from "./types.js";

async function approveJobLocked(
  workspaceInput: string,
  jobId: string,
): Promise<JobState> {
  const workspace = path.resolve(workspaceInput);
  const state = await loadState(workspace, jobId);
  if (state.status !== "awaiting_approval")
    throw new Error(`任务当前不需要批准：${jobId}`);
  const gate = state.humanGate
    ? parseHumanGate(state.humanGate)
    : state.phase === "before_run"
      ? createHumanGate("before_run", { detail: "任务执行前需要人工批准。" })
      : state.phase === "before_complete"
        ? createHumanGate("completion", { detail: "等待完成审批。" })
        : (() => {
            throw new Error("等待审批的任务缺少 Human Gate。");
          })();
  if (gate.status !== "waiting")
    throw new Error("Human Gate 已解决，不能重复批准。");
  const config = await loadConfig(workspace);
  const redact = contextRedactor(config.governance);
  const retentionDays = config.governance?.retentionDays;
  if (state.phase === "before_run" && gate.reason === "before_run") {
    return writeApprovalState(
      workspace,
      jobId,
      {
        status: "queued",
        phase: "queued",
        approved: true,
        approvalRequired: false,
        humanGate: resolveHumanGate(gate, "approved", redact),
      },
      "done",
    );
  }
  if (state.phase !== "before_complete" || gate.reason !== "completion")
    throw new Error("审批状态与 Human Gate 不一致。");
  const directory = jobDir(workspace, jobId);
  const context = await loadJobContext(directory);
  const pending = parsePendingCompletion(state.pendingCompletion);
  const worktreeFile = path.join(directory, "worktree.json");
  const recorded = existsSync(worktreeFile)
    ? await loadJson<{ path: string }>(worktreeFile)
    : undefined;
  const workdir = context.isolated ? recorded?.path : workspace;
  const hashes = await evidenceHashes(directory);
  const evidenceMatches =
    JSON.stringify(hashes) === JSON.stringify(pending.evidenceHashes);
  const snapshotMatches =
    Boolean(workdir && existsSync(workdir)) &&
    worktreeSha256(await snapshotDiff(workdir!)) === pending.worktreeSha256;
  if (
    !evidenceMatches ||
    !snapshotMatches ||
    !completionEvidenceValid(context, state, hashes)
  ) {
    const humanGate = resolveHumanGate(
      gate,
      "approval rejected because completion evidence changed",
      redact,
    );
    const stale = await writeApprovalState(
      workspace,
      jobId,
      {
        status: "needs_fix",
        phase: "completion_evidence_stale",
        approvalRequired: false,
        pendingCompletion: null,
        humanGate,
        error: "完成审批证据或 worktree 已变化；拒绝完成，请重新执行验证。",
      },
      "failed",
    );
    await writeResult(workspace, jobId, stale);
    await prunePersistedData(workspace, retentionDays);
    return stale;
  }
  const updates: Json = {
    status: "done",
    phase: "done",
    approvalRequired: false,
    completionApproved: true,
    approvedAt: now(),
    pendingCompletion: null,
    humanGate: resolveHumanGate(gate, "approved", redact),
    error: null,
  };
  if (context.autoCommit) {
    try {
      updates.gitCommit =
        commitWorktree(workdir!, context.commitMessage) ?? null;
    } catch (error) {
      const failed = await writeApprovalState(
        workspace,
        jobId,
        {
          status: "failed",
          phase: "git_commit",
          approvalRequired: false,
          pendingCompletion: null,
          humanGate: resolveHumanGate(
            gate,
            "approval accepted; commit failed",
            redact,
          ),
          error: String(error),
          gitCommit: null,
        },
        "failed",
      );
      await writeResult(workspace, jobId, failed);
      await prunePersistedData(workspace, retentionDays);
      return failed;
    }
  }
  await writeApprovalState(workspace, jobId, updates, "done");
  if (!context.keepWorktree) {
    try {
      await cleanupWorktree(workspace, jobId);
      await writeState(workspace, jobId, { worktreeCleaned: true });
    } catch (error) {
      await writeState(workspace, jobId, { cleanupError: String(error) });
    }
  }
  const completed = await loadState(workspace, jobId);
  await writeResult(workspace, jobId, completed);
  await prunePersistedData(workspace, retentionDays);
  return completed;
}

export async function approveJob(
  workspaceInput: string,
  jobId: string,
): Promise<JobState> {
  const workspace = path.resolve(workspaceInput);
  return withFileLock(
    path.join(jobDir(workspace, jobId), "run.lock"),
    () => approveJobLocked(workspace, jobId),
    { retries: 0, busyMessage: `任务正在运行中：${jobId}` },
  );
}
