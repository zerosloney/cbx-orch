import path from "node:path";
import {
  loadState,
  loadConfig,
  writeState,
  jobDir,
} from "./state.js";
import { contextRedactor } from "./artifacts.js";
import {
  parseHumanGate,
  resolveHumanGate,
  extendRoundLimit,
} from "./human-gate.js";
import { loadJobContext } from "./context-schema.js";
import { saveJson } from "./storage.js";
import { withFileLock } from "./lock.js";
import type { JobState } from "./types.js";

async function prepareContinuationUnlocked(
  workspace: string,
  jobId: string,
  instructions: string,
  extraRounds = 0,
): Promise<{ instructions: string; blocked?: JobState }> {
  if (!Number.isInteger(extraRounds) || extraRounds < 0)
    throw new Error("extra_rounds 必须是非负整数。");
  const state = await loadState(workspace, jobId);
  const config = await loadConfig(workspace);
  const redact = contextRedactor(config.governance);
  const safeInstructions = redact(instructions);
  if (!state.humanGate) {
    if (extraRounds) throw new Error("当前任务没有等待追加轮次的 Human Gate。");
    return { instructions: safeInstructions };
  }
  const gate = parseHumanGate(state.humanGate);
  if (gate.status === "resolved") {
    if (extraRounds) throw new Error("当前 Human Gate 已解决，不能追加轮次。");
    return { instructions: safeInstructions };
  }
  if (gate.reason === "before_run" || gate.reason === "completion")
    return { instructions: safeInstructions, blocked: state };
  if (gate.reason === "max_rounds") {
    if (!extraRounds) return { instructions: safeInstructions, blocked: state };
    const directory = jobDir(workspace, jobId);
    const context = await loadJobContext(directory);
    if (!context.adaptive?.enabled)
      throw new Error("max_rounds gate 缺少 Adaptive 配置。");
    context.adaptive.maxRounds = extendRoundLimit(
      context.adaptive.maxRounds,
      extraRounds,
    );
    await saveJson(path.join(directory, "context.json"), context);
  } else if (extraRounds) {
    throw new Error("extra_rounds 只能用于 max_rounds Human Gate。");
  }
  const humanGate = resolveHumanGate(gate, safeInstructions, redact);
  await writeState(workspace, jobId, {
    humanGate,
    continuationInstructions: humanGate.instructions ?? null,
    blockingQuestions: null,
    blockedReason: null,
    failureTracker: null,
    executionUsed: 0,
    fixUsed: 0,
    stageRetries: {},
  });
  return { instructions: safeInstructions };
}

export async function prepareContinuation(
  workspace: string,
  jobId: string,
  instructions: string,
  extraRounds = 0,
): Promise<{ instructions: string; blocked?: JobState }> {
  return withFileLock(
    path.join(jobDir(workspace, jobId), "gate.lock"),
    () =>
      prepareContinuationUnlocked(workspace, jobId, instructions, extraRounds),
    { retries: 0, busyMessage: `Human Gate 正在更新：${jobId}` },
  );
}
