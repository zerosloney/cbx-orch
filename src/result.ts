import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { saveJson, loadJobContext, now } from "./storage.js";
import { jobDir, pruneAfterTerminal, writeApprovalState, writeState } from "./state.js";
import { listArtifacts } from "./artifacts.js";
import { criterionDefinitions, reconcileVerifiedProgress, type StructuredAudit, type VerifiedProgress } from "./progress.js";
import { structuredAuditRequested, evidenceHashes } from "./evidence.js";
import { estimateTokens } from "./context-pack.js";
import type { JobState } from "./types.js";

/**
 * 终态/暂停态收尾收敛：状态写盘 + result.json 生成（+可选保留期清理）一次完成。
 * 替代此前散落在 execution.ts / approval.ts 的 writeState→writeResult(→pruneAfterTerminal)
 * 三连副本——任何一处漏掉 writeResult 会让 result.json 停留在旧状态。
 */
export async function finalizeState(
  workspace: string,
  jobId: string,
  updates: Record<string, unknown>,
  options: { queueEntryId?: string; prune?: boolean } = {},
): Promise<JobState> {
  const state = await writeState(workspace, jobId, updates, options.queueEntryId);
  await writeResult(workspace, jobId, state);
  if (options.prune) await pruneAfterTerminal(workspace);
  return state;
}

/** approval 路径的对偶：writeApprovalState 携带队列条目终态映射，后续收尾同 finalizeState。 */
export async function finalizeApprovalState(
  workspace: string,
  jobId: string,
  updates: Record<string, unknown>,
  queueStatus: "done" | "failed",
  options: { prune?: boolean } = {},
): Promise<JobState> {
  const state = await writeApprovalState(workspace, jobId, updates, queueStatus);
  await writeResult(workspace, jobId, state);
  if (options.prune) await pruneAfterTerminal(workspace);
  return state;
}

export async function writeResult(workspace: string, jobId: string, state: JobState): Promise<void> {
  const directory = jobDir(workspace, jobId);
  if (state.audit) await saveJson(path.join(directory, "audit.json"), state.audit);
  if (state.verifiedProgress) await saveJson(path.join(directory, "verified-progress.json"), state.verifiedProgress);
  const files = await listArtifacts(workspace, jobId);
  const context = await loadJobContext(directory);
  const text = async (name: string): Promise<string | null> => existsSync(path.join(directory, name)) ? readFile(path.join(directory, name), "utf8") : null;
  const handback = await text("handback.md");
  const status = await text("git-status.txt");
  const agentLog = await text("agent.log");
  const estimatedTokens = agentLog !== null ? estimateTokens(agentLog) : null;
  const artifactHashes: Record<string, string> = {};
  const stableEvidence = new Set(["request.md", "context-snapshot.md", "context-contract.json", "understanding.json", "handback.md", "review.md", "audit.json", "verified-progress.json", "test.log", "git-status.txt", "diff.patch", "complete.patch", "untracked-files.txt"]);
  for (const file of files) {
    if (stableEvidence.has(file) || (file.startsWith("stage-") && file.endsWith("-handback.md"))) {
      artifactHashes[file] = createHash("sha256").update(await readFile(path.join(directory, file))).digest("hex");
    }
  }
  const changedFiles = (status ?? "").split(/\r?\n/).filter(Boolean).map(line => line.slice(3).replace(/^.* -> /, ""));
  const requiredEvidenceArtifacts = ["complete.patch", "test.log", ...(context.reviewRequested ? ["review.md"] : [])];
  const evidenceArtifacts = requiredEvidenceArtifacts.filter(file => existsSync(path.join(directory, file)));
  const evidenceAvailable = state.status === "done" && state.testExitCode === 0 && (!context.reviewRequested || state.reviewVerdict === "PASS" || (!structuredAuditRequested(context) && (state.reviewVerdict === null || state.reviewVerdict === undefined))) && evidenceArtifacts.length === requiredEvidenceArtifacts.length;
  const progress = state.verifiedProgress as VerifiedProgress | undefined;
  const progressById = new Map((progress?.criteria ?? []).map(item => [item.id, item]));
  const acceptanceEvidence = criterionDefinitions(context.taskContract?.acceptanceCriteria ?? []).map(({ id, criterion }) => {
    const judgement = progressById.get(id);
    const verified = structuredAuditRequested(context) ? judgement?.status === "verified" : true;
    return { criterion, status: evidenceAvailable && verified ? "evidence_available" : "unverified", artifacts: judgement?.evidence.map(item => item.artifact) ?? evidenceArtifacts };
  });
  await saveJson(path.join(directory, "result.json"), {
    jobId, status: state.status, phase: state.phase, attempt: state.attempt,
    estimatedTokens,
    error: state.error ?? null, executorExitCode: state.executorExitCode ?? null,
    testExitCode: state.testExitCode ?? null, reviewVerdict: state.reviewVerdict ?? null,
    baseCommit: context.baseCommit ?? null, baseBranch: context.baseBranch ?? null, baseDirty: context.baseDirty ?? null,
    baselineDrift: state.baselineDrift ?? false, changedFiles, handback,
    tests: [{ command: context.testCommand ?? null, exitCode: state.testExitCode ?? null, timedOut: state.phase === "testing" ? Boolean(state.timedOut) : false }],
    acceptanceEvidence, audit: state.audit ?? null, verifiedProgress: progress ?? null, humanGate: state.humanGate ?? null, artifactHashes, files,
    stages: Array.isArray(state.stages) ? state.stages : null,
    // P0-2: 暴露执行器调用预算/实际消耗，让 UI 展示"内外 loop 乘数"实际值。
    configuredMaxTurns: state.configuredMaxTurns ?? context.maxTurns ?? null,
    executorInvocations: state.executorInvocations ?? 0,
    stageInvocations: state.stageInvocations ?? {},
    updatedAt: now(),
  });
}
