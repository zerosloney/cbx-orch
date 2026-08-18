import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { loadJson } from "./storage.js";
import { snapshotDiff, collectDiff } from "./git-ops.js";
import { invokeExecutor } from "./runner.js";
import { createManagerContextPack } from "./context-pack.js";
import {
  managerPrompt,
  parseNextAction,
  type NextAction,
} from "./adaptive-manager.js";
import { contextArtifacts } from "./artifacts.js";
import type { JobContext, JobState } from "./types.js";
import type { ProcessResult } from "./process-runner.js";

export class ManagerWorktreeMutationError extends Error {}
export class ManagerDecisionError extends Error {}
export class ManagerInvocationError extends Error {}

export async function requestAdaptiveAction(params: {
  workspace: string;
  directory: string;
  workdir: string;
  context: JobContext;
  round: number;
  state: JobState;
  userSupplement: string;
  redact: (text: string) => string;
}): Promise<NextAction> {
  const {
    workspace,
    directory,
    workdir,
    context,
    round,
    state,
    userSupplement,
    redact,
  } = params;
  const candidate = path.join(directory, "manager-decision-candidate.json");
  if (existsSync(candidate)) await unlink(candidate);
  const before = await snapshotDiff(workdir);
  const adaptive = context.adaptive!;
  const contextPack = await createManagerContextPack({
    directory,
    taskContract: context.taskContract,
    verifiedProgress: state.verifiedProgress,
    audit: state.audit,
    recentFailure: {
      phase: state.phase,
      error: state.error as string | undefined,
      retryReason: state.retryReason as string | undefined,
      count: (state.failureTracker as { count?: number } | undefined)?.count,
    },
    userInstructions: userSupplement,
    artifactNames: contextArtifacts(directory, [
      "context-snapshot.md",
      "complete.patch",
      "test.log",
      "review.md",
      "handback.md",
      "audit.json",
      "verified-progress.json",
    ]),
    redact,
    budget: context.contextBudget,
    round,
    maxRounds: adaptive.maxRounds,
  });
  let result: ProcessResult | undefined;
  let invocationError: unknown;
  try {
    result = await invokeExecutor(
      adaptive.managerExecutor ?? context.executor,
      workspace,
      directory,
      workdir,
      managerPrompt(candidate, contextPack.path),
      context.permissionMode,
      context.maxTurns,
      context.timeoutMs,
      { role: "manager", jobId: context.jobId },
    );
  } catch (error) {
    invocationError = error;
  }
  const after = await snapshotDiff(workdir);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await collectDiff(directory, workdir);
    throw new ManagerWorktreeMutationError(
      "Adaptive Manager 修改了工作区，任务已安全停止。",
    );
  }
  if (invocationError)
    throw new ManagerInvocationError(
      invocationError instanceof Error
        ? invocationError.message
        : String(invocationError),
    );
  if (!result)
    throw new ManagerInvocationError("Adaptive Manager 未返回执行结果。");
  if (result.code !== 0 || result.timedOut)
    throw new ManagerInvocationError(
      result.timedOut
        ? `Adaptive Manager 超时（${context.timeoutMs}ms）`
        : "Adaptive Manager 执行失败。",
    );
  if (!existsSync(candidate))
    throw new ManagerDecisionError(
      "Adaptive Manager 未生成 manager-decision-candidate.json。",
    );
  let raw: unknown;
  try {
    raw = await loadJson<unknown>(candidate);
  } catch (error) {
    await unlink(candidate);
    throw new ManagerDecisionError(
      error instanceof Error ? error.message : String(error),
    );
  }
  await unlink(candidate);
  try {
    return parseNextAction(raw);
  } catch (error) {
    throw new ManagerDecisionError(
      error instanceof Error ? error.message : String(error),
    );
  }
}
