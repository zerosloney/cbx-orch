import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finishSpan, publishEvent, startSpan } from "./observability.js";
import { inspectExecutorPlugin, type ExecutorResult, type ExecutorRequest } from "./executor.js";
import { findExecutable, resolveExecutor } from "./executors/builtin.js";
import { listPersistedStates, loadJson, loadPersistedState, loadRuntimeConfig, now, persistedMetrics, prunePersistedData, redactText, saveJson, savePersistedState, savePersistedStateAndFinishQueue, savePersistedStateAndQueue, savePersistedStateAndResolveApprovalQueue, updateJobContext, withFileLock, type RuntimeConfig } from "./storage.js";
import { runProcess, runShell, terminateTree, type ProcessResult } from "./process-runner.js";
import { auditAllowsCompletion, criterionDefinitions, parseStructuredAudit, reconcileVerifiedProgress, type StructuredAudit, type VerifiedProgress } from "./progress.js";
import { managerPrompt, normalizeAdaptiveOptions, parseNextAction, type AdaptiveOptions, type NextAction } from "./adaptive-manager.js";
import { createAuditorContextPack, createExecutorContextPack, createManagerContextPack, type ContextArtifact } from "./context-pack.js";
import { createHumanGate, extendRoundLimit, parseHumanGate, resolveHumanGate, trackFailure, type HumanGate } from "./human-gate.js";
import { cleanupRecordedWorktree, collectDiff, commitWorktree, gitDirtyFingerprint, gitRoot, prepareWorktree, snapshotDiff, snapshotGitBaseline, type GitBaseline } from "./git-ops.js";
import * as queue from "./queue.js";
import type { QueueEntry, QueueFile, QueueRuntime } from "./queue.js";
import { APP_VERSION } from "./version.js";
export type { QueueEntry, QueueEntryStatus, QueueFile } from "./queue.js";
import { assertJobId, normalizeJobId, validateWorkspace, validateTestCommand, validatePermissionMode, assertExecutionPolicy, normalizeTaskContract, type TaskStage as TaskStageType, type TaskContract as TaskContractType } from "./validation.js";
import { AUDIT_EVIDENCE_ARTIFACTS, evidenceHashes, completionEvidenceValid, parsePendingCompletion, worktreeSha256, structuredAuditRequested, type PendingCompletion } from "./evidence.js";
export { assertJobId, normalizeJobId, validateWorkspace, validateTestCommand, validatePermissionMode, assertExecutionPolicy, normalizeTaskContract } from "./validation.js";
export { AUDIT_EVIDENCE_ARTIFACTS, evidenceHashes, completionEvidenceValid, parsePendingCompletion, worktreeSha256, structuredAuditRequested } from "./evidence.js";
export type { PendingCompletion } from "./evidence.js";

export type Json = Record<string, unknown>;
export type JobStatus = "queued" | "running" | "awaiting_approval" | "needs_fix" | "review_failed" | "failed" | "done" | "cancelled";

export type CbxConfig = RuntimeConfig;

export interface JobContext {
  appVersion: string;
  jobId: string;
  workspace: string;
  createdAt: string;
  testCommand?: string;
  reviewRequested: boolean;
  isolated: boolean;
  permissionMode: string;
  maxTurns: number;
  timeoutMs: number;
  maxRetries: number;
  executionRetries: number;
  fixRetries: number;
  keepWorktree: boolean;
  reviewRules?: string;
  approvalBeforeRun: boolean;
  approvalBeforeComplete: boolean;
  autoBranch: boolean;
  autoCommit: boolean;
  commitMessage: string;
  executor: string;
  reviewExecutor?: string;
  taskContract?: TaskContractType;
  baseCommit?: string;
  baseBranch?: string;
  baseDirty?: boolean;
  baseStatus?: string;
  dirtyFingerprint?: string;
  trustMode: "trusted" | "untrusted";
  gitRoot?: string;
  adaptive?: AdaptiveOptions;
  dependencyGuard?: boolean;
}

export type TaskStage = TaskStageType;
export type TaskContract = TaskContractType;

export interface JobState {
  jobId: string;
  status: JobStatus;
  phase: string;
  workspace: string;
  jobDir: string;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  [key: string]: unknown;
}

/** 把降级路径的失败原因落到 job 事件流，避免裸吞导致排障无据。 */
function logJobEvent(workspace: string, jobId: string, event: string, detail: Record<string, unknown> = {}): void {
  try {
    appendFileSync(path.join(jobDir(workspace, jobId), "events.ndjson"), JSON.stringify({ event, jobId, ...detail, at: now() }) + "\n", "utf8");
  } catch { /* events file itself unreachable — nothing more we can do */ }
}

export function jobDir(workspace: string, jobId: string): string {
  assertJobId(jobId);
  return path.join(workspace, ".cbx", "jobs", jobId);
}

export async function loadState(workspace: string, jobId: string): Promise<JobState> {
  jobDir(workspace, jobId);
  const value = await loadPersistedState<JobState>(workspace, jobId);
  if (!value || typeof value !== "object") throw new Error(`任务不存在或状态文件损坏：${jobId}`);
  return value;
}

export async function loadConfig(workspaceInput: string): Promise<CbxConfig> {
  return loadRuntimeConfig(workspaceInput);
}

export function mergeConfig(config: CbxConfig, overrides: Partial<CbxConfig> & { approvalBeforeRun?: boolean; approvalBeforeComplete?: boolean; autoBranch?: boolean; autoCommit?: boolean; commitMessage?: string; trustMode?: "trusted" | "untrusted" }): Required<Pick<CbxConfig, "review" | "isolated" | "timeoutMs" | "maxRetries" | "maxTurns" | "keepWorktree" | "permissionMode" | "maxConcurrent" | "dependencyGuard">> & Pick<CbxConfig, "testCommand" | "reviewRules" | "executor" | "reviewExecutor"> & { approvalBeforeRun: boolean; approvalBeforeComplete: boolean; autoBranch: boolean; autoCommit: boolean; commitMessage: string; trustMode: "trusted" | "untrusted"; adaptive: AdaptiveOptions } {
  const adaptive = normalizeAdaptiveOptions(overrides.adaptive, normalizeAdaptiveOptions(config.adaptive));
  return {
    testCommand: overrides.testCommand ?? config.testCommand,
    review: overrides.review ?? config.review ?? false,
    isolated: overrides.isolated ?? config.isolated ?? false,
    timeoutMs: overrides.timeoutMs ?? config.timeoutMs ?? 30 * 60_000,
    maxRetries: overrides.maxRetries ?? config.maxRetries ?? 1,
    maxTurns: overrides.maxTurns ?? config.maxTurns ?? 50,
    keepWorktree: overrides.keepWorktree ?? config.keepWorktree ?? false,
    permissionMode: overrides.permissionMode ?? config.permissionMode ?? "auto",
    reviewRules: overrides.reviewRules ?? config.reviewRules,
    approvalBeforeRun: overrides.approvalBeforeRun ?? config.approval?.beforeRun ?? false,
    approvalBeforeComplete: overrides.approvalBeforeComplete ?? config.approval?.beforeComplete ?? false,
    maxConcurrent: overrides.maxConcurrent ?? config.maxConcurrent ?? 2,
    autoBranch: overrides.autoBranch ?? config.git?.autoBranch ?? false,
    autoCommit: overrides.autoCommit ?? config.git?.autoCommit ?? false,
    commitMessage: overrides.commitMessage ?? config.git?.commitMessage ?? "chore(cbx): apply task",
    executor: overrides.executor ?? config.executor ?? "codebuddy",
    reviewExecutor: overrides.reviewExecutor ?? config.reviewExecutor,
    trustMode: overrides.trustMode ?? config.execution?.trustMode ?? "trusted",
    dependencyGuard: overrides.dependencyGuard ?? config.dependencyGuard ?? false,
    adaptive,
  };
}

export async function writeState(workspace: string, jobId: string, updates: Json, queueEntryId?: string): Promise<JobState> {
  const state = await loadState(workspace, jobId);
  const previousStatus = state.status;
  Object.assign(state, updates, { updatedAt: now() });
  if (queueEntryId) await savePersistedStateAndFinishQueue(workspace, jobId, state, queueEntryId);
  else await savePersistedState(workspace, jobId, state);
  await saveJson(path.join(jobDir(workspace, jobId), "state.json"), state);
  await prunePersistedData(workspace, (await loadConfig(workspace)).governance?.retentionDays);
  try { await publishEvent(workspace, "job.state_changed", { jobId, previousStatus, status: state.status, phase: state.phase, attempt: state.attempt }); }
  catch { /* event delivery must not mask the durable state change */ }
  return state;
}

async function writeApprovalState(workspace: string, jobId: string, updates: Json, queueStatus: "done" | "failed"): Promise<JobState> {
  const state = await loadState(workspace, jobId);
  const previousStatus = state.status;
  Object.assign(state, updates, { updatedAt: now() });
  await savePersistedStateAndResolveApprovalQueue(workspace, jobId, state, queueStatus);
  await saveJson(path.join(jobDir(workspace, jobId), "state.json"), state);
  try { await publishEvent(workspace, "job.state_changed", { jobId, previousStatus, status: state.status, phase: state.phase, attempt: state.attempt }); }
  catch { /* durable approval transition must not depend on delivery */ }
  return state;
}

export async function createJob(options: {
  workspace: string;
  task: string;
  testCommand?: string;
  review: boolean;
  isolated: boolean;
  permissionMode: string;
  maxTurns: number;
  timeoutMs?: number;
  maxRetries?: number;
  keepWorktree?: boolean;
  allowUnsafePermissions?: boolean;
  reviewRules?: string;
  approvalBeforeRun?: boolean;
  approvalBeforeComplete?: boolean;
  autoBranch?: boolean;
  autoCommit?: boolean;
  commitMessage?: string;
  executor?: string;
  reviewExecutor?: string;
  trustMode?: "trusted" | "untrusted";
  contextSnapshot?: string;
  taskContract?: TaskContract;
  adaptive?: Partial<AdaptiveOptions>;
  dependencyGuard?: boolean;
  jobId?: string;
}): Promise<{ jobId: string; directory: string }> {
  const workspace = path.resolve(options.workspace);
  validateWorkspace(workspace);
  validateTestCommand(options.testCommand);
  validatePermissionMode(options.permissionMode, options.allowUnsafePermissions);
  assertExecutionPolicy(options.trustMode ?? "trusted", options.isolated);
  if (!Number.isFinite(options.maxTurns) || options.maxTurns < 1) throw new Error("maxTurns 必须是正整数。");
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100)) throw new Error("timeoutMs 必须不小于 100ms。");
  if (options.maxRetries !== undefined && (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)) throw new Error("maxRetries 必须是非负整数。");
  const adaptive = normalizeAdaptiveOptions(options.adaptive);
  if (adaptive.enabled && !options.review) throw new Error("adaptive.enabled=true 需要 review=true，以便 done 通过结构化证据门。");
  const taskContract = normalizeTaskContract(options.taskContract) ?? (adaptive.enabled ? { goal: options.task.trim() } : undefined);
  // autoCommit 隐含 isolated：提交到 worktree 才安全，避免把主工作区无关改动一起提交。
  // 不抛错——autoCommit=true 时自动开启 isolated，保留告警让用户知道发生了隐含提升。
  if (options.autoCommit && !options.isolated) {
    console.error("cbx 提示：autoCommit=true 已隐含开启 isolated=true（提交到 worktree，避免污染主工作区）。");
    options.isolated = true;
  }
  // 测试命令黑名单是软防线（正则可被变体绕过）。非隔离时强警告：cbx 不保证命令安全，应运行在受控环境。
  if (options.testCommand && !options.isolated) {
    console.error(`cbx 警告：测试命令将在主工作区执行（isolated=false），cbx 不保证其安全性：${options.testCommand}`);
  }
  const jobId = normalizeJobId(options.jobId);
  const directory = jobDir(workspace, jobId);
  if (existsSync(directory)) throw new Error(`任务已存在：${jobId}`);
  // legacy 导入可能把 .cbx/jobs/<id>/ 目录清掉但 SQLite 记录仍在；仅查目录会让同 jobId 静默覆盖旧 state。
  const persisted = await loadPersistedState<unknown>(workspace, jobId);
  if (persisted) throw new Error(`任务已存在（SQLite 有记录但目录缺失）：${jobId}`);
  await mkdir(directory, { recursive: true });
  const request = `# 任务\n\n## 目标\n\n${taskContract?.goal ?? options.task.trim()}\n\n## 验收标准\n\n${taskContract?.acceptanceCriteria?.map(item => `- ${item}`).join("\n") || "- 以目标和验收命令为准。"}\n\n## 非目标\n\n${taskContract?.nonGoals?.map(item => `- ${item}`).join("\n") || "- 未指定。"}\n\n## 约束\n\n${taskContract?.constraints?.map(item => `- ${item}`).join("\n") || "- 只修改完成目标所需的文件。"}\n\n## 验收命令\n\n${options.testCommand ?? "未指定；请根据项目现有脚本选择最相关的检查。"}\n\n## 执行规则\n\n- 先检查项目结构和现有测试，再修改。\n- 完成后运行验收命令。\n- 将修改摘要、测试命令、测试结果和遗留问题写入 handback.md。\n`;
  await writeFile(path.join(directory, "request.md"), request, "utf8");
  const governance = (await loadConfig(workspace)).governance;
  const snapshot = redactText(options.contextSnapshot ?? "", governance?.redactFields, governance?.redactPatterns);
  if (snapshot) await writeFile(path.join(directory, "context-snapshot.md"), snapshot, "utf8");
  if (taskContract) await saveJson(path.join(directory, "context-contract.json"), taskContract);
  const baseline = snapshotGitBaseline(workspace);
  const dirtyFingerprint = gitDirtyFingerprint(workspace);
  const context: JobContext = {
    appVersion: APP_VERSION, jobId, workspace, createdAt: now(), testCommand: options.testCommand,
    reviewRequested: options.review, isolated: options.isolated, permissionMode: options.permissionMode,
    maxTurns: options.maxTurns, timeoutMs: options.timeoutMs ?? 30 * 60_000,
    maxRetries: options.maxRetries ?? 1, executionRetries: Math.max(1, (options.maxRetries ?? 1) + 1),
    fixRetries: Math.max(1, (options.maxRetries ?? 1)), keepWorktree: options.keepWorktree ?? false,
    reviewRules: options.reviewRules, approvalBeforeRun: options.approvalBeforeRun ?? false, approvalBeforeComplete: options.approvalBeforeComplete ?? false,
    autoBranch: options.autoBranch ?? false, autoCommit: options.autoCommit ?? false,
    commitMessage: options.commitMessage ?? "chore(cbx): apply task",
    executor: options.executor ?? "codebuddy", reviewExecutor: options.reviewExecutor,
    adaptive: adaptive.enabled ? { ...adaptive, managerExecutor: adaptive.managerExecutor ?? options.executor ?? "codebuddy" } : undefined,
    taskContract,
    trustMode: options.trustMode ?? "trusted",
    gitRoot: baseline?.root ?? gitRoot(workspace), baseCommit: baseline?.commit, baseBranch: baseline?.branch,
    baseDirty: baseline?.dirty, baseStatus: baseline?.status, dirtyFingerprint,
    dependencyGuard: options.dependencyGuard ?? false,
  };
  await saveJson(path.join(directory, "context.json"), context);
  const state: JobState = {
    jobId, status: "queued", phase: "queued", workspace, jobDir: directory,
    createdAt: now(), updatedAt: now(), attempt: 0,
  };
  await savePersistedState(workspace, jobId, state);
  await saveJson(path.join(directory, "state.json"), state);
  return { jobId, directory };
}

export async function cleanupWorktree(workspaceInput: string, jobId: string): Promise<boolean> {
  const workspace = path.resolve(workspaceInput);
  const directory = jobDir(workspace, jobId);
  return cleanupRecordedWorktree(workspace, directory);
}

function promptFor(phase: string, extra = "", label = "编码代理", contextPack: string): string {
  return `你是 ${label} 执行代理。\n\n只读取当前角色上下文包：\n- ${contextPack}\n\n上下文包是编排器生成的最小化脱敏投影；只可额外读取其中 artifacts 明确列出的文件，不要读取任何未列材料或历史轨迹。\n当前阶段：${phase}\n\n${extra}`;
}

async function invokeBuiltin(spec: ReturnType<typeof resolveExecutor> & {}, directory: string, workdir: string, prompt: string, permissionMode: string, maxTurns: number, timeoutMs: number): Promise<ProcessResult> {
  const executable = findExecutable(spec);
  const args = [...executable.slice(1), ...spec.buildArgs({ prompt, permissionMode, maxTurns })];
  const command = executable[0];
  const eventsFile = path.join(directory, "events.ndjson");
  const outputLog = path.join(directory, "agent.log");
  appendFileSync(eventsFile, JSON.stringify({ event: "executor_metadata", source: "builtin", name: spec.name, version: APP_VERSION, at: now() }) + "\n", "utf8");
  appendFileSync(eventsFile, JSON.stringify({ event: "process_started", command: [command, ...args], cwd: workdir, at: now() }) + "\n", "utf8");
  const result = await runProcess(command, args, workdir, timeoutMs, outputLog, path.join(directory, "active.pid"));
  appendFileSync(eventsFile, JSON.stringify({ event: "process_finished", returncode: result.code, timedOut: result.timedOut, at: now() }) + "\n", "utf8");
  return result;
}

export async function invokeExecutor(executor: string, workspace: string, directory: string, workdir: string, prompt: string, permissionMode: string, maxTurns: number, timeoutMs: number): Promise<ProcessResult> {
  const builtin = resolveExecutor(executor);
  if (builtin) return invokeBuiltin(builtin, directory, workdir, prompt, permissionMode, maxTurns, timeoutMs);
  const config = await loadConfig(workspace);
  const identity = await inspectExecutorPlugin(executor, workspace, config.plugins);
  const request: ExecutorRequest = { directory, workdir, prompt, permissionMode, maxTurns, timeoutMs, executor, plugin: { policy: config.plugins, sha256: identity.sha256 } };
  appendFileSync(path.join(directory, "events.ndjson"), JSON.stringify({ event: "executor_metadata", source: identity.source, name: identity.name, version: identity.version, apiVersion: identity.apiVersion, capabilities: identity.capabilities, sha256: identity.sha256, at: now() }) + "\n", "utf8");
  appendFileSync(path.join(directory, "events.ndjson"), JSON.stringify({ event: "plugin_started", executor: identity.name, at: now() }) + "\n", "utf8");
  const requestFile = path.join(directory, "plugin-request.json");
  const resultFile = path.join(directory, "plugin-result.json");
  await saveJson(requestFile, request);
  const host = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-host.js");
  const processResult = await runProcess(process.execPath, [host, executor, workspace, requestFile, resultFile], workdir, timeoutMs, path.join(directory, "agent.log"), path.join(directory, "active.pid"));
  let pluginResult: ExecutorResult = { code: processResult.code, timedOut: processResult.timedOut, output: processResult.output };
  if (!processResult.timedOut && existsSync(resultFile)) {
    try { pluginResult = JSON.parse(await readFile(resultFile, "utf8")) as ExecutorResult; }
    catch { pluginResult = { code: -1, output: "executor plugin returned an invalid result" }; }
    finally { await unlink(resultFile).catch(() => undefined); }
  } else {
    // Compatibility fallback for an older plugin-host.js left in a development dist directory.
    const marker = /CBX_PLUGIN_RESULT=([A-Za-z0-9+/=]+)/g;
    const matches = [...processResult.output.matchAll(marker)];
    if (!processResult.timedOut && matches.length) {
      try { pluginResult = JSON.parse(Buffer.from(matches.at(-1)![1], "base64").toString("utf8")) as ExecutorResult; }
      catch { pluginResult = { code: -1, output: "executor plugin returned an invalid result" }; }
    }
  }
  const normalized = { code: Number(pluginResult.code ?? processResult.code), timedOut: processResult.timedOut || Boolean(pluginResult.timedOut), output: String(pluginResult.output ?? processResult.output) };
  appendFileSync(path.join(directory, "events.ndjson"), JSON.stringify({ event: "plugin_finished", executor, code: normalized.code, timedOut: normalized.timedOut, at: now() }) + "\n", "utf8");
  return normalized;
}

async function runTest(directory: string, workdir: string, command: string | undefined, timeoutMs: number): Promise<ProcessResult> {
  if (!command) { await writeFile(path.join(directory, "test.log"), "未指定测试命令。\n", "utf8"); return { code: 0, timedOut: false, output: "" }; }
  const logFile = path.join(directory, "test.log");
  await writeFile(logFile, `$ ${command}\n\n`, "utf8");
  const result = await runShell(command, workdir, timeoutMs, logFile, path.join(directory, "active.pid"));
  await appendFile(logFile, `\n退出码：${result.code}\n超时：${result.timedOut}\n内存输出已截断：${Boolean(result.outputTruncated)}\n`, "utf8");
  return result;
}

const ARTIFACTS = new Set(["request.md", "context-snapshot.md", "context-contract.json", "understanding.json", "context.json", "state.json", "events.ndjson", "agent.log", "handback.md", "review.md", "audit.json", "verified-progress.json", "manager-context.json", "executor-context.json", "auditor-context.json", "test.log", "git-status.txt", "diff.patch", "complete.patch", "untracked-files.txt", "result.json"]);
const AUDIT_CANDIDATE = "audit-candidate.json";

function contextArtifacts(directory: string, names: readonly ContextArtifact[]): ContextArtifact[] {
  return names.filter(name => existsSync(path.join(directory, name)));
}

function contextRedactor(governance?: RuntimeConfig["governance"]): (text: string) => string {
  return text => redactText(text, governance?.redactFields, governance?.redactPatterns);
}

export async function listJobs(workspaceInput: string): Promise<JobState[]> {
  const workspace = path.resolve(workspaceInput);
  return listPersistedStates<JobState>(workspace);
}

async function saveStateAndQueue(workspace: string, jobId: string, state: Record<string, unknown>, queueFile: QueueFile): Promise<void> {
  const previousStatus = (await loadState(workspace, jobId)).status;
  await savePersistedStateAndQueue(workspace, jobId, state, queueFile);
  await saveJson(path.join(jobDir(workspace, jobId), "state.json"), state);
  await prunePersistedData(workspace, (await loadConfig(workspace)).governance?.retentionDays);
  try { await publishEvent(workspace, "job.state_changed", { jobId, previousStatus, status: state.status, phase: state.phase, attempt: state.attempt }); }
  catch { /* durable state and queue transaction must not depend on delivery */ }
}

export async function readArtifact(workspaceInput: string, jobId: string, artifact: string): Promise<string> {
  // 与 listArtifacts 的动态发现保持一致：stage 交接副本 stage-<index>-<name>-handback.md 可读，
  // 但仍按白名单正则校验，防止路径穿越。
  if (!ARTIFACTS.has(artifact) && !/^stage-\d+-[A-Za-z0-9._-]+-handback\.md$/.test(artifact)) throw new Error(`不允许读取任务文件：${artifact}`);
  return readFile(path.join(jobDir(path.resolve(workspaceInput), jobId), artifact), "utf8");
}

export async function readEventsIncremental(workspaceInput: string, jobId: string, since = 0): Promise<{ events: string[]; next_offset: number }> {
  // intentional-simple: 行级游标 + 逐行 JSON.parse 校验。events.ndjson 单 job 最多几百行，O(n) 扫描无压力。
  // worker 用 appendFileSync 追加；并发写入时最后一条可能截断，parse 失败则停在此处，下次调用补齐。
  const raw = await readArtifact(workspaceInput, jobId, "events.ndjson");
  const lines = raw.split("\n");
  const events: string[] = [];
  let offset = since;
  for (let i = since; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try { JSON.parse(line); } catch { break; }
    events.push(line);
    offset = i + 1;
  }
  return { events, next_offset: offset };
}

export async function listArtifacts(workspaceInput: string, jobId: string): Promise<string[]> {
  const directory = jobDir(path.resolve(workspaceInput), jobId);
  const files: string[] = [];
  for (const file of ARTIFACTS) if (existsSync(path.join(directory, file))) files.push(file);
  // Stage-specific handback copies follow a dynamic pattern; discover them at listing time.
  try {
    const entries = await readdir(directory);
    for (const entry of entries) if (entry.startsWith("stage-") && entry.endsWith("-handback.md")) files.push(entry);
  } catch { /* job directory may not exist yet */ }
  return files;
}

async function writeResult(workspace: string, jobId: string, state: JobState): Promise<void> {
  const directory = jobDir(workspace, jobId);
  if (state.audit) await saveJson(path.join(directory, "audit.json"), state.audit);
  if (state.verifiedProgress) await saveJson(path.join(directory, "verified-progress.json"), state.verifiedProgress);
  const files = await listArtifacts(workspace, jobId);
  const context = await loadJson<JobContext>(path.join(directory, "context.json"));
  const text = async (name: string): Promise<string | null> => existsSync(path.join(directory, name)) ? readFile(path.join(directory, name), "utf8") : null;
  const handback = await text("handback.md");
  const status = await text("git-status.txt");
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
    error: state.error ?? null, executorExitCode: state.executorExitCode ?? null,
    testExitCode: state.testExitCode ?? null, reviewVerdict: state.reviewVerdict ?? null,
    baseCommit: context.baseCommit ?? null, baseBranch: context.baseBranch ?? null, baseDirty: context.baseDirty ?? null,
    baselineDrift: state.baselineDrift ?? false, changedFiles, handback,
    tests: [{ command: context.testCommand ?? null, exitCode: state.testExitCode ?? null, timedOut: state.phase === "testing" ? Boolean(state.timedOut) : false }],
    acceptanceEvidence, audit: state.audit ?? null, verifiedProgress: progress ?? null, humanGate: state.humanGate ?? null, artifactHashes, files,
    stages: Array.isArray(state.stages) ? state.stages : null,
    updatedAt: now(),
  });
}

interface Understanding { interpretedGoal?: string; plannedFiles?: string[]; acceptanceCriteria?: string[]; assumptions?: string[]; blockingQuestions?: string[]; }

function semanticReviewFailure(review: string): boolean {
  return review.split(/\r?\n/).slice(1, 4).some(line => /^CLASSIFICATION\s*:\s*(SEMANTIC|CONTRACT|BASELINE)$/i.test(line.trim()));
}

interface BaselineDrift { commitDrift: boolean; dirtyDrift: boolean; currentBaseline?: GitBaseline; currentDirtyFingerprint?: string; }

function evaluateBaselineDrift(context: JobContext, workspace: string): BaselineDrift {
  const currentBaseline = snapshotGitBaseline(workspace);
  const currentDirtyFingerprint = gitDirtyFingerprint(workspace);
  return {
    currentBaseline,
    currentDirtyFingerprint,
    commitDrift: Boolean(context.baseCommit && currentBaseline?.commit && context.baseCommit !== currentBaseline.commit),
    dirtyDrift: Boolean(context.dirtyFingerprint && currentDirtyFingerprint && context.dirtyFingerprint !== currentDirtyFingerprint),
  };
}

async function refreshBaseline(workspace: string, jobId: string, directory: string): Promise<JobState> {
  const baseline = snapshotGitBaseline(workspace);
  const dirtyFingerprint = gitDirtyFingerprint(workspace);
  const context = await loadJson<JobContext>(path.join(directory, "context.json"));
  Object.assign(context, { gitRoot: baseline?.root, baseCommit: baseline?.commit, baseBranch: baseline?.branch, baseDirty: baseline?.dirty, baseStatus: baseline?.status, dirtyFingerprint });
  await saveJson(path.join(directory, "context.json"), context);
  const refreshedState = await writeState(workspace, jobId, { baselineDrift: false, dirtyBaselineDrift: false, currentCommit: null, error: null });
  await writeResult(workspace, jobId, refreshedState);
  logJobEvent(workspace, jobId, "baseline_refreshed", { baseCommit: baseline?.commit, baseBranch: baseline?.branch, baseDirty: baseline?.dirty });
  return refreshedState;
}

async function performContextHandshake(
  workspace: string,
  directory: string,
  context: JobContext,
  workdir: string,
  extra: string,
  redact: (text: string) => string,
  finish: (updates: Json) => Promise<JobState>,
): Promise<JobState | undefined> {
  const beforeHandshake = await snapshotDiff(workdir);
  const executor = context.taskContract?.stages?.[0]?.executor ?? context.executor;
  const label = resolveExecutor(executor)?.label ?? "编码代理";
  const handshakeStage = context.taskContract?.stages?.[0] ?? { name: "context-handshake", executor, task: "确认任务理解" };
  const currentState = await loadState(workspace, context.jobId);
  const contextPack = await createExecutorContextPack({ directory, taskContract: context.taskContract, verifiedProgress: currentState.verifiedProgress, audit: currentState.audit, recentFailure: { phase: currentState.phase, error: currentState.error as string | undefined, retryReason: currentState.retryReason as string | undefined }, userInstructions: extra, artifactNames: contextArtifacts(directory, ["context-snapshot.md"]), redact, stage: handshakeStage, attempt: Number(currentState.attempt ?? 0) });
  const handshakePrompt = promptFor("context handshake", `只确认上下文包中的任务理解，不要修改代码。将 JSON 写入 ${path.join(directory, "understanding.json")}，字段为 interpretedGoal、plannedFiles、acceptanceCriteria、assumptions、blockingQuestions。没有阻塞问题时 blockingQuestions 必须是空数组；需要产品决策、公共契约选择或上下文冲突时写入问题并停止。`, label, contextPack.path);
  let handshake: ProcessResult;
  try { handshake = await invokeExecutor(executor, workspace, directory, workdir, handshakePrompt, context.permissionMode, context.maxTurns, context.timeoutMs); }
  catch (error) { return finish({ status: "needs_fix", phase: "context_handshake", contextIssue: true, error: String(error) }); }
  const afterHandshake = await snapshotDiff(workdir);
  if (JSON.stringify(beforeHandshake) !== JSON.stringify(afterHandshake)) return finish({ status: "needs_fix", phase: "context_handshake", contextIssue: true, error: "上下文握手阶段修改了工作区。" });
  if (handshake.code !== 0 || handshake.timedOut || !existsSync(path.join(directory, "understanding.json"))) return finish({ status: "needs_fix", phase: "context_handshake", contextIssue: true, error: "执行代理未能生成有效的 understanding.json。" });
  const understanding = await loadJson<Understanding>(path.join(directory, "understanding.json"));
  if (!Array.isArray(understanding.blockingQuestions)) return finish({ status: "needs_fix", phase: "context_handshake", contextIssue: true, error: "understanding.json 缺少 blockingQuestions 数组。" });
  if (understanding.blockingQuestions.length) {
    const questions = understanding.blockingQuestions.map(question => redact(String(question)).slice(0, 1_000));
    return finish({ status: "needs_fix", phase: "awaiting_clarification", contextIssue: true, blockingQuestions: questions, humanGate: createHumanGate("needs_input", { questions, detail: "任务存在阻塞性歧义，需要主 Agent 纠偏。" }), error: "任务存在阻塞性歧义，需要主 Agent 纠偏。" });
  }
  return undefined;
}

interface StageReport {
  name: string;
  executor: string;
  exitCode: number;
  testExitCode: number | null;
  reviewVerdict: string | null;
  attempts: number;
}

interface StageOutcome {
  terminal: boolean;
  state: JobState;
  report: StageReport;
  attempt: number;
  attemptExtra: string;
}

class ManagerWorktreeMutationError extends Error {}
class ManagerDecisionError extends Error {}
class ManagerInvocationError extends Error {}

async function requestAdaptiveAction(params: {
  workspace: string; directory: string; workdir: string; context: JobContext;
  round: number; state: JobState; userSupplement: string; redact: (text: string) => string;
}): Promise<NextAction> {
  const { workspace, directory, workdir, context, round, state, userSupplement, redact } = params;
  const candidate = path.join(directory, "manager-decision-candidate.json");
  if (existsSync(candidate)) await unlink(candidate);
  const before = await snapshotDiff(workdir);
  const adaptive = context.adaptive!;
  const contextPack = await createManagerContextPack({ directory, taskContract: context.taskContract, verifiedProgress: state.verifiedProgress, audit: state.audit, recentFailure: { phase: state.phase, error: state.error as string | undefined, retryReason: state.retryReason as string | undefined, count: (state.failureTracker as { count?: number } | undefined)?.count }, userInstructions: userSupplement, artifactNames: contextArtifacts(directory, ["context-snapshot.md", "complete.patch", "test.log", "review.md", "handback.md", "audit.json", "verified-progress.json"]), redact, round, maxRounds: adaptive.maxRounds });
  let result: ProcessResult | undefined;
  let invocationError: unknown;
  try { result = await invokeExecutor(adaptive.managerExecutor ?? context.executor, workspace, directory, workdir, managerPrompt(candidate, contextPack.path), context.permissionMode, context.maxTurns, context.timeoutMs); }
  catch (error) { invocationError = error; }
  const after = await snapshotDiff(workdir);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await collectDiff(directory, workdir);
    throw new ManagerWorktreeMutationError("Adaptive Manager 修改了工作区，任务已安全停止。");
  }
  if (invocationError) throw new ManagerInvocationError(invocationError instanceof Error ? invocationError.message : String(invocationError));
  if (!result) throw new ManagerInvocationError("Adaptive Manager 未返回执行结果。");
  if (result.code !== 0 || result.timedOut) throw new ManagerInvocationError(result.timedOut ? `Adaptive Manager 超时（${context.timeoutMs}ms）` : "Adaptive Manager 执行失败。");
  if (!existsSync(candidate)) throw new ManagerDecisionError("Adaptive Manager 未生成 manager-decision-candidate.json。");
  let raw: unknown;
  try { raw = await loadJson<unknown>(candidate); }
  catch (error) {
    await unlink(candidate);
    throw new ManagerDecisionError(error instanceof Error ? error.message : String(error));
  }
  await unlink(candidate);
  try { return parseNextAction(raw); }
  catch (error) { throw new ManagerDecisionError(error instanceof Error ? error.message : String(error)); }
}

async function runStage(params: {
  workspace: string; jobId: string; directory: string; workdir: string;
  context: JobContext; stage: TaskStage; stageIndex: number; stageLabel: string;
  stageExtra: string; attempt: number; attemptExtra: string; maxAttempts: number;
  cancelMarker: string; redact: (text: string) => string;
  finish: (updates: Json) => Promise<JobState>;
  finishCancelled: () => Promise<JobState>;
}): Promise<StageOutcome> {
  const { workspace, jobId, directory, workdir, context, stage, stageIndex, stageLabel, stageExtra, maxAttempts, cancelMarker, redact, finish, finishCancelled } = params;
  let attempt = params.attempt;
  let attemptExtra = params.attemptExtra;
  let lastError = "";
  let executorExitCode = 0;
  let testExitCode: number | null = null;
  let reviewVerdict: string | null = null;
  const executionRetries = context.executionRetries ?? maxAttempts;
  const fixRetries = context.fixRetries ?? maxAttempts;
  let executionUsed = 0;
  let fixUsed = 0;
  const DEP_FILES = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];
  const depBaseline: Record<string, string> = {};
  if (context.dependencyGuard) {
    for (const file of DEP_FILES) {
      const fullPath = path.join(workdir, file);
      if (existsSync(fullPath)) {
        depBaseline[file] = createHash("sha256").update(await readFile(fullPath)).digest("hex");
      }
    }
  }

  for (; ;) {
    if (existsSync(cancelMarker)) return { terminal: true, state: await finishCancelled(), report: { name: stage.name, executor: stage.executor, exitCode: -1, testExitCode: null, reviewVerdict: null, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    attempt += 1;
    await writeState(workspace, jobId, { status: "running", phase: "executing", stage: stage.name, stageIndex, attempt, workdir, error: lastError || null });
    const executorState = await loadState(workspace, jobId);
    const executorPack = await createExecutorContextPack({ directory, taskContract: context.taskContract, verifiedProgress: executorState.verifiedProgress, audit: executorState.audit, recentFailure: { phase: executorState.phase, error: lastError || undefined, retryReason: executorState.retryReason as string | undefined, count: (executorState.failureTracker as { count?: number } | undefined)?.count }, userInstructions: [stageExtra, attemptExtra].filter(Boolean).join("\n\n"), artifactNames: contextArtifacts(directory, ["context-snapshot.md", "complete.patch", "test.log", "review.md", "handback.md", "audit.json", "verified-progress.json"]), redact, stage, attempt });
    let agent: ProcessResult;
    try { agent = await invokeExecutor(stage.executor, workspace, directory, workdir, promptFor(`stage ${stageIndex}: ${stage.name}`, `按上下文包 current.stage 与 userInstructions 执行。完成后将修改摘要、测试结果和遗留问题写入 ${path.join(directory, "handback.md")}。`, stageLabel, executorPack.path), context.permissionMode, context.maxTurns, context.timeoutMs); }
    catch (error) {
      lastError = String(error);
      if (executionUsed < executionRetries) {
        executionUsed += 1;
        await writeState(workspace, jobId, { phase: "retrying", stage: stage.name, retryReason: lastError });
        continue;
      }
      const state = await finish({ status: "failed", phase: "executing", stage: stage.name, error: lastError });
      return { terminal: true, state, report: { name: stage.name, executor: stage.executor, exitCode: -1, testExitCode: null, reviewVerdict: null, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    }
    if (existsSync(cancelMarker)) return { terminal: true, state: await finishCancelled(), report: { name: stage.name, executor: stage.executor, exitCode: agent.code, testExitCode: null, reviewVerdict: null, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    await collectDiff(directory, workdir);
    if (context.dependencyGuard) {
      let depChanged = false;
      const changedDepFiles: string[] = [];
      for (const file of DEP_FILES) {
        const fullPath = path.join(workdir, file);
        if (existsSync(fullPath) && depBaseline[file]) {
          const currentHash = createHash("sha256").update(await readFile(fullPath)).digest("hex");
          if (currentHash !== depBaseline[file]) { depChanged = true; changedDepFiles.push(file); }
        }
      }
      if (depChanged) {
        lastError = `依赖守卫：未经授权修改了依赖文件：${changedDepFiles.join(", ")}。`;
        if (fixUsed < fixRetries) {
          fixUsed += 1;
          attemptExtra = `请恢复 ${changedDepFiles.join("、")} 至任务开始前的状态，或通过 --no-dependency-guard 禁用依赖守卫。`;
          await writeState(workspace, jobId, { phase: "retrying", stage: stage.name, retryReason: lastError });
          continue;
        }
        const state = await finish({ status: "needs_fix", phase: "dependency_guard", stage: stage.name, error: lastError });
        return { terminal: true, state, report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: null, reviewVerdict: null, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
      }
    }
    if (agent.code !== 0 || agent.timedOut) {
      lastError = agent.timedOut ? `${stageLabel} 超时（${context.timeoutMs}ms）` : `${stageLabel} 执行失败`;
      executorExitCode = agent.code;
      if (executionUsed < executionRetries) {
        executionUsed += 1;
        await writeState(workspace, jobId, { phase: "retrying", stage: stage.name, retryReason: lastError, executorExitCode: agent.code });
        continue;
      }
      const state = await finish({ status: "failed", phase: "executing", stage: stage.name, executorExitCode: agent.code, timedOut: agent.timedOut, error: lastError });
      return { terminal: true, state, report: { name: stage.name, executor: stage.executor, exitCode: agent.code, testExitCode: null, reviewVerdict: null, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    }
    executorExitCode = 0;
    await writeState(workspace, jobId, { phase: "testing", stage: stage.name, executorExitCode: 0 });
    const test = await runTest(directory, workdir, context.testCommand, context.timeoutMs);
    if (existsSync(cancelMarker)) return { terminal: true, state: await finishCancelled(), report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: test.code, reviewVerdict: null, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    const reviewedSnapshot = await collectDiff(directory, workdir);
    if (test.code !== 0 || test.timedOut) {
      lastError = test.timedOut ? `验收命令超时（${context.timeoutMs}ms）` : "验收命令失败";
      testExitCode = test.code;
      if (fixUsed < fixRetries) {
        fixUsed += 1;
        attemptExtra = `请读取 ${path.join(directory, "test.log")}，修复失败原因后重新执行。`;
        await writeState(workspace, jobId, { phase: "retrying", stage: stage.name, retryReason: lastError, testExitCode: test.code });
        continue;
      }
      const state = await finish({ status: "needs_fix", phase: "testing", stage: stage.name, testExitCode: test.code, timedOut: test.timedOut, error: lastError });
      return { terminal: true, state, report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: test.code, reviewVerdict: null, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    }
    testExitCode = 0;
    if (stage.skipReview || !context.reviewRequested) {
      reviewVerdict = stage.skipReview ? "skipped" : null;
      return { terminal: false, state: await loadState(workspace, jobId), report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: 0, reviewVerdict, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    }
    await writeState(workspace, jobId, { status: "running", phase: "reviewing", stage: stage.name, testExitCode: 0 });
    const definitions = criterionDefinitions(context.taskContract?.acceptanceCriteria ?? []);
    const structuredAuditExtra = structuredAuditRequested(context)
      ? `\n同时将严格 JSON 写入 ${path.join(directory, AUDIT_CANDIDATE)}：{"version":1,"completion":"complete|incomplete|blocked","cleanliness":"clean|suspect|violation","alignment":"aligned|unknown|needs_revision|invalid","criteria":[{"id":"criterion id","status":"verified|unverified|blocked","evidence":["complete.patch"]}]}。criteria 必须恰好覆盖上下文包 current.criteria 的全部 ID；verified 必须引用至少一个证据；evidence 只能引用上下文包 artifacts 中实际存在的文件名。`
      : "";
    const reviewExtra = `只审查上下文包 artifacts 中列出的证据，不要修改代码。将结果写入 ${path.join(directory, "review.md")}。第一行必须是 VERDICT: PASS 或 VERDICT: FAIL。若失败源于需求歧义、公共契约冲突或基线问题，第二行写 CLASSIFICATION: SEMANTIC；普通代码缺陷无需 classification。按严重程度列出问题、文件和行号。${structuredAuditExtra}`;
    let reviewAgent: ProcessResult;
    const reviewExecutor = stage.reviewExecutor ?? context.reviewExecutor ?? stage.executor;
    const reviewLabel = resolveExecutor(reviewExecutor)?.label ?? "审查代理";
    const auditCandidate = path.join(directory, AUDIT_CANDIDATE);
    if (existsSync(auditCandidate)) await unlink(auditCandidate);
    if (structuredAuditRequested(context) && existsSync(path.join(directory, "review.md"))) await unlink(path.join(directory, "review.md"));
    const auditorState = await loadState(workspace, jobId);
    const auditorPack = await createAuditorContextPack({ directory, taskContract: context.taskContract, verifiedProgress: auditorState.verifiedProgress, audit: auditorState.audit, recentFailure: { phase: auditorState.phase, error: auditorState.error as string | undefined, retryReason: auditorState.retryReason as string | undefined, count: (auditorState.failureTracker as { count?: number } | undefined)?.count }, userInstructions: "执行独立审查", artifactNames: contextArtifacts(directory, ["context-snapshot.md", "complete.patch", "test.log", "handback.md", "audit.json", "verified-progress.json"]), redact, stage, reviewRules: context.reviewRules ?? "关注正确性、回归风险、安全性、测试覆盖和改动范围。", criteria: definitions });
    try { reviewAgent = await invokeExecutor(reviewExecutor, workspace, directory, workdir, promptFor("independent review", reviewExtra, reviewLabel, auditorPack.path), context.permissionMode, context.maxTurns, context.timeoutMs); }
    catch (error) {
      lastError = String(error);
      if (fixUsed < fixRetries) {
        fixUsed += 1;
        await writeState(workspace, jobId, { phase: "retrying", stage: stage.name, retryReason: lastError });
        continue;
      }
      const state = await finish({ status: "review_failed", phase: "reviewing", stage: stage.name, error: lastError });
      return { terminal: true, state, report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: 0, reviewVerdict: null, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    }
    if (existsSync(cancelMarker)) return { terminal: true, state: await finishCancelled(), report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: 0, reviewVerdict: null, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    const afterReview = await snapshotDiff(workdir);
    if (JSON.stringify(afterReview) !== JSON.stringify(reviewedSnapshot)) {
      await collectDiff(directory, workdir);
      lastError = "审查代理修改了工作区；为避免交付未经测试的代码，任务已停止";
      const state = await finish({ status: "review_failed", phase: "reviewing", stage: stage.name, reviewExitCode: reviewAgent.code, reviewerModifiedWorktree: true, error: lastError });
      return { terminal: true, state, report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: 0, reviewVerdict: "FAIL", attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    }
    if (reviewAgent.code !== 0 || reviewAgent.timedOut) {
      lastError = reviewAgent.timedOut ? `审查超时（${context.timeoutMs}ms）` : "审查代理执行失败";
      if (fixUsed < fixRetries) {
        fixUsed += 1;
        await writeState(workspace, jobId, { phase: "retrying", stage: stage.name, retryReason: lastError });
        continue;
      }
      const state = await finish({ status: "review_failed", phase: "reviewing", stage: stage.name, reviewExitCode: reviewAgent.code, timedOut: reviewAgent.timedOut, error: lastError });
      return { terminal: true, state, report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: 0, reviewVerdict: null, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    }
    if (structuredAuditRequested(context)) {
      try {
        if (!existsSync(auditCandidate)) throw new Error("审查代理未生成 audit-candidate.json。");
        const hashes = await evidenceHashes(directory);
        const audit = parseStructuredAudit(await loadJson<unknown>(auditCandidate), definitions, hashes);
        const currentState = await loadState(workspace, jobId);
        const verifiedProgress = reconcileVerifiedProgress(definitions, currentState.verifiedProgress as VerifiedProgress | undefined, audit, hashes);
        await writeState(workspace, jobId, { audit, verifiedProgress, auditError: null });
      } catch (error) {
        lastError = `结构化审计无效：${error instanceof Error ? error.message : String(error)}`;
        if (fixUsed < fixRetries) {
          fixUsed += 1;
          await writeState(workspace, jobId, { phase: "retrying", stage: stage.name, retryReason: lastError, auditError: lastError });
          continue;
        }
        const state = await finish({ status: "review_failed", phase: "reviewing", stage: stage.name, reviewVerdict: "FAIL", reviewExitCode: reviewAgent.code, auditError: lastError, error: lastError });
        return { terminal: true, state, report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: 0, reviewVerdict: "FAIL", attempts: executionUsed + fixUsed }, attempt, attemptExtra };
      }
    }
    const review = existsSync(path.join(directory, "review.md")) ? await readFile(path.join(directory, "review.md"), "utf8") : "";
    const firstLine = review.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].trim();
    const pass = /^VERDICT\s*:\s*PASS$/i.test(firstLine);
    if (pass) {
      reviewVerdict = "PASS";
      return { terminal: false, state: await loadState(workspace, jobId), report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: 0, reviewVerdict, attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    }
    lastError = "审查发现问题";
    attemptExtra = `请读取 ${path.join(directory, "review.md")}，修复其中的问题后重新执行。`;
    if (semanticReviewFailure(review)) {
      const detail = "审查发现语义或契约问题，需要主 Agent 纠偏。";
      const state = await finish({ status: "needs_fix", phase: "awaiting_clarification", stage: stage.name, reviewVerdict: "FAIL", reviewExitCode: 0, contextIssue: true, humanGate: createHumanGate("semantic_conflict", { detail }), error: detail });
      return { terminal: true, state, report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: 0, reviewVerdict: "FAIL", attempts: executionUsed + fixUsed }, attempt, attemptExtra };
    }
    reviewVerdict = "FAIL";
    if (fixUsed < fixRetries) {
      fixUsed += 1;
      await writeState(workspace, jobId, { phase: "retrying", stage: stage.name, retryReason: lastError });
      continue;
    }
    const state = await finish({ status: "needs_fix", phase: "reviewing", stage: stage.name, reviewVerdict: "FAIL", reviewExitCode: 0, error: lastError });
    return { terminal: true, state, report: { name: stage.name, executor: stage.executor, exitCode: 0, testExitCode: 0, reviewVerdict: "FAIL", attempts: executionUsed + fixUsed }, attempt, attemptExtra };
  }
  const state = await finish({ status: "failed", phase: "executing", stage: stage.name, error: lastError || "任务未能完成" });
  return { terminal: true, state, report: { name: stage.name, executor: stage.executor, exitCode: executorExitCode, testExitCode, reviewVerdict, attempts: maxAttempts }, attempt, attemptExtra };
}

async function executeJobLocked(workspace: string, jobId: string, extra = "", queueEntryId?: string): Promise<JobState> {
  const directory = jobDir(workspace, jobId);
  const initial = await loadState(workspace, jobId);
  const context = await loadJson<JobContext>(path.join(directory, "context.json"));
  // intentional-simple: 旧 job 跨版本续跑时告警但不硬阻断——context schema 向后兼容。
  // 新功能字段（如 dependencyGuard）从 .cbx.json 同步到已持久化 context，避免旧任务遗漏。
  const runtimeConfig = await loadConfig(workspace);
  if (runtimeConfig.dependencyGuard && !context.dependencyGuard) {
    await updateJobContext(workspace, jobId, { dependencyGuard: true });
    context.dependencyGuard = true;
  }
  const jobMajor = String(context.appVersion ?? "").split(".")[0];
  if (jobMajor && jobMajor !== APP_VERSION.split(".")[0]) {
    const warning = `任务由 cbx v${context.appVersion} 创建，当前运行 v${APP_VERSION}；context schema 可能不兼容。`;
    logJobEvent(workspace, jobId, "version_mismatch", { jobVersion: context.appVersion, runtimeVersion: APP_VERSION, warning });
    console.error(`cbx: ${warning}`);
  }
  assertExecutionPolicy(context.trustMode ?? "trusted", context.isolated);
  const governance = (await loadConfig(workspace)).governance;
  const redact = contextRedactor(governance);
  if (initial.status === "awaiting_approval" && initial.phase === "before_complete") return initial;
  if (context.approvalBeforeRun && initial.approved !== true) {
    const existingGate = initial.humanGate ? parseHumanGate(initial.humanGate) : undefined;
    const humanGate = existingGate?.status === "waiting" && existingGate.reason === "before_run" ? existingGate : createHumanGate("before_run", { detail: "任务执行前需要人工批准。" });
    return writeState(workspace, jobId, { status: "awaiting_approval", phase: "before_run", approvalRequired: true, humanGate }, queueEntryId);
  }
  const drift = evaluateBaselineDrift(context, workspace);
  if (context.isolated && context.baseDirty) {
    const state = await writeState(workspace, jobId, { status: "needs_fix", phase: "dirty_baseline", dirtyBaselineDrift: false, error: "隔离任务无法携带创建时的未提交内容；请先提交或清理工作区后刷新基线。" }, queueEntryId);
    await writeResult(workspace, jobId, state);
    return state;
  }
  if (!context.isolated && drift.dirtyDrift) {
    const state = await writeState(workspace, jobId, { status: "needs_fix", phase: "dirty_baseline", dirtyBaselineDrift: true, error: "非隔离工作区未提交内容已偏离任务创建基线；请刷新上下文/基线后继续。" }, queueEntryId);
    await writeResult(workspace, jobId, state);
    return state;
  }
  if (drift.commitDrift) {
    logJobEvent(workspace, jobId, "baseline_drift", { baseCommit: context.baseCommit, currentCommit: drift.currentBaseline?.commit, isolated: context.isolated });
    if (!context.isolated) {
      const state = await writeState(workspace, jobId, { status: "needs_fix", phase: "baseline_drift", baselineDrift: true, currentCommit: drift.currentBaseline?.commit, error: "非隔离工作区 HEAD 已偏离任务创建基线；请刷新上下文/基线后继续。" }, queueEntryId);
      await writeResult(workspace, jobId, state);
      return state;
    }
    await writeState(workspace, jobId, { baselineDrift: true, currentCommit: drift.currentBaseline?.commit });
  }
  const worktreeFile = path.join(directory, "worktree.json");
  const recordedWorkdir = existsSync(worktreeFile) ? (await loadJson<{ path: string }>(worktreeFile)).path : "";
  const workdir = recordedWorkdir && existsSync(recordedWorkdir) ? recordedWorkdir : await prepareWorktree(workspace, directory, jobId, context.isolated, context.autoBranch, context.baseCommit ?? "HEAD");
  const maxAttempts = Math.max(1, context.maxRetries + 1);
  let attempt = Number(initial.attempt ?? 0);
  let attemptExtra = extra;
  const cancelMarker = path.join(directory, "cancel.requested");

  const finish = async (updates: Json): Promise<JobState> => {
    const currentState = await loadState(workspace, jobId);
    let finalUpdates = { ...updates };
    if (structuredAuditRequested(context)) {
      const definitions = criterionDefinitions(context.taskContract?.acceptanceCriteria ?? []);
      const hashes = await evidenceHashes(directory);
      const audit = (updates.audit ?? currentState.audit) as StructuredAudit | undefined;
      const verifiedProgress = reconcileVerifiedProgress(definitions, (updates.verifiedProgress ?? currentState.verifiedProgress) as VerifiedProgress | undefined, audit, hashes);
      finalUpdates = { ...finalUpdates, audit: audit ?? null, verifiedProgress };
      if (updates.status === "done") {
        const candidateState = { ...currentState, ...finalUpdates };
        const requiredEvidence = ["complete.patch", "test.log", "review.md"];
        const verified = candidateState.testExitCode === 0 && candidateState.reviewVerdict === "PASS" && auditAllowsCompletion(audit, verifiedProgress, requiredEvidence, hashes);
        if (!verified) finalUpdates = { ...finalUpdates, status: "needs_fix", phase: "verification_gate", error: "结构化完成门未通过：需要 complete + clean + aligned、全部验收标准已验证，且测试/审查证据齐全。" };
      }
    }
    const status = String(finalUpdates.status ?? currentState.status);
    const phase = String(finalUpdates.phase ?? currentState.phase);
    if (finalUpdates.status === "done" && context.approvalBeforeComplete) {
      const hashes = await evidenceHashes(directory);
      const candidateState = { ...currentState, ...finalUpdates };
      if (!completionEvidenceValid(context, candidateState, hashes)) {
        finalUpdates = { ...finalUpdates, status: "needs_fix", phase: "verification_gate", error: "完成审批前证据门未通过。" };
      } else {
        const pendingCompletion: PendingCompletion = { version: 1, evidenceHashes: hashes, worktreeSha256: worktreeSha256(await snapshotDiff(workdir)), createdAt: now() };
        finalUpdates = { ...finalUpdates, status: "awaiting_approval", phase: "before_complete", approvalRequired: true, pendingCompletion, humanGate: createHumanGate("completion", { detail: "证据门已通过，等待完成审批。" }) };
      }
    }
    // repeated_failure 检测放在结构化审计门与审批门之后，确保 verification_gate 失败也被计入。
    const finalStatus = String(finalUpdates.status ?? status);
    const finalPhase = String(finalUpdates.phase ?? phase);
    const error = typeof finalUpdates.error === "string" ? finalUpdates.error : undefined;
    const gateExcluded = ["awaiting_clarification", "adaptive_ask", "adaptive_blocked", "adaptive_max_rounds"].includes(finalPhase) || finalPhase.includes("safety");
    if (error && !finalUpdates.humanGate && !gateExcluded && ["failed", "needs_fix", "review_failed"].includes(finalStatus)) {
      const failureTracker = trackFailure(currentState.failureTracker, error);
      finalUpdates = { ...finalUpdates, failureTracker };
      if (failureTracker.count >= 3) finalUpdates = { ...finalUpdates, status: "needs_fix", phase: "repeated_failure", humanGate: createHumanGate("repeated_failure", { detail: redact(error).slice(0, 2_000) }) };
    }
if (finalUpdates.status === "done" && context.autoCommit) {
	      try {
	        const commitHash = commitWorktree(workdir, context.commitMessage);
	        if (commitHash) finalUpdates.gitCommit = commitHash;
	      } catch (error) {
	        finalUpdates = { ...finalUpdates, status: "failed", phase: "git_commit", error: String(error), gitCommit: null };
	      }
	    }
    const result = await writeState(workspace, jobId, finalUpdates, queueEntryId);
const waitingHumanGate = result.humanGate ? parseHumanGate(result.humanGate).status === "waiting" : false;
	    const recoverablePause = (context.adaptive?.enabled && result.status === "needs_fix") || waitingHumanGate || result.phase === "verification_gate";
	    if (!context.keepWorktree && !recoverablePause && ["done", "failed", "needs_fix", "review_failed"].includes(String(result.status))) {
      try { await cleanupWorktree(workspace, jobId); await writeState(workspace, jobId, { worktreeCleaned: true }); }
      catch (error) { await writeState(workspace, jobId, { cleanupError: String(error) }); }
    }
    const finalState = await loadState(workspace, jobId);
    await writeResult(workspace, jobId, finalState);
    return finalState;
  };
  const finishCancelled = async (): Promise<JobState> => {
    try { await cleanupWorktree(workspace, jobId); } catch (error) { await writeState(workspace, jobId, { cleanupError: String(error) }); }
    const finalState = await writeState(workspace, jobId, { status: "cancelled", phase: "cancelled", cancelledAt: now() }, queueEntryId);
    await writeResult(workspace, jobId, finalState);
    return finalState;
  };

  if (context.taskContract && !existsSync(path.join(directory, "understanding.json"))) {
    const handshakeOutcome = await performContextHandshake(workspace, directory, context, workdir, extra, redact, finish);
    if (handshakeOutcome) return handshakeOutcome;
  }

  if (context.adaptive?.enabled) {
    const persistedRound = Number(initial.adaptiveRound ?? 0);
    if (!Number.isInteger(persistedRound) || persistedRound < 0) return finish({ status: "needs_fix", phase: "adaptive_state", error: "adaptiveRound 持久状态无效。" });
    let round = persistedRound;
    let adaptiveRounds = Array.isArray(initial.adaptiveRounds) ? initial.adaptiveRounds as Json[] : [];
    const stageReports = Array.isArray(initial.stages) ? initial.stages as unknown as StageReport[] : [];
    const userSupplement = redact(extra);
    while (round < context.adaptive.maxRounds) {
      if (existsSync(cancelMarker)) return finishCancelled();
      round += 1;
      const priorManagerState = await loadState(workspace, jobId);
      await writeState(workspace, jobId, { status: "running", phase: "adaptive_manager", adaptiveRound: round, workdir });
      let decision: NextAction;
      try { decision = await requestAdaptiveAction({ workspace, directory, workdir, context, round, state: priorManagerState, userSupplement, redact }); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const phase = error instanceof ManagerWorktreeMutationError ? "adaptive_manager_safety" : error instanceof ManagerDecisionError ? "adaptive_manager_decision" : "adaptive_manager";
        const status = error instanceof ManagerDecisionError ? "needs_fix" : "failed";
        adaptiveRounds = [...adaptiveRounds, { round, action: "error", phase, error: message }];
        return finish({ status, phase, adaptiveRound: round, adaptiveRounds, error: message });
      }
      if (existsSync(cancelMarker)) return finishCancelled();
      logJobEvent(workspace, jobId, "adaptive_decision", { round, action: decision.action });
      if (decision.action === "ask") {
        const questions = decision.questions.map(question => redact(question).slice(0, 1_000));
        adaptiveRounds = [...adaptiveRounds, { round, action: decision.action, questions }];
        return finish({ status: "needs_fix", phase: "adaptive_ask", adaptiveRound: round, adaptiveRounds, blockingQuestions: questions, humanGate: createHumanGate("needs_input", { questions, detail: "Adaptive Manager 需要用户补充信息。" }), error: "Adaptive Manager 需要用户补充信息。" });
      }
      if (decision.action === "blocked") {
        const reason = redact(decision.reason).slice(0, 1_000);
        adaptiveRounds = [...adaptiveRounds, { round, action: decision.action, reason }];
        return finish({ status: "needs_fix", phase: "adaptive_blocked", adaptiveRound: round, adaptiveRounds, blockedReason: reason, humanGate: createHumanGate("needs_input", { questions: [reason], detail: reason }), error: reason });
      }
if (decision.action === "done") {
	        adaptiveRounds = [...adaptiveRounds, { round, action: decision.action }];
	        const lastReview = stageReports.at(-1)?.reviewVerdict ?? null;
	        const lastTest = stageReports.length ? (stageReports.at(-1)?.testExitCode ?? null) : 0;
	        return finish({ status: "done", phase: "done", adaptiveRound: round, adaptiveRounds, stages: stageReports, reviewVerdict: lastReview === "skipped" ? null : lastReview, reviewExitCode: 0, testExitCode: lastTest });
      }

      const stage = decision.stage as TaskStage;
      const stageIndex = stageReports.length;
      const stageLabel = resolveExecutor(stage.executor)?.label ?? "编码代理";
      logJobEvent(workspace, jobId, "stage_started", { stage: stage.name, executor: stage.executor, index: stageIndex, adaptiveRound: round });
      const outcome = await runStage({ workspace, jobId, directory, workdir, context, stage, stageIndex, stageLabel, stageExtra: [extra, stage.task].filter(Boolean).join("\n\n"), attempt, attemptExtra, maxAttempts, cancelMarker, redact, finish, finishCancelled });
      stageReports.push(outcome.report);
      adaptiveRounds = [...adaptiveRounds, { round, action: decision.action, stage, report: outcome.report }];
      if (outcome.terminal) {
        const finalState = await writeState(workspace, jobId, { adaptiveRound: round, adaptiveRounds, stages: stageReports });
        await writeResult(workspace, jobId, finalState);
        return finalState;
      }
      attempt = outcome.attempt;
      attemptExtra = outcome.attemptExtra;
      const handbackFile = path.join(directory, "handback.md");
      if (existsSync(handbackFile)) {
        const safeName = stage.name.replace(/[^A-Za-z0-9._-]+/g, "-");
        await writeFile(path.join(directory, `stage-${stageIndex}-${safeName}-handback.md`), await readFile(handbackFile, "utf8"), "utf8");
      }
      await writeState(workspace, jobId, { phase: "adaptive_manager_next", adaptiveRound: round, adaptiveRounds, stages: stageReports, reviewVerdict: outcome.report.reviewVerdict, testExitCode: outcome.report.testExitCode, error: null, retryReason: null });
      logJobEvent(workspace, jobId, "stage_finished", { stage: stage.name, executor: stage.executor, index: stageIndex, adaptiveRound: round, exitCode: outcome.report.exitCode, reviewVerdict: outcome.report.reviewVerdict ?? "skipped" });
    }
    const maxRoundsError = `Adaptive Manager 已达累计轮次上限 ${context.adaptive.maxRounds}。`;
    return finish({ status: "needs_fix", phase: "adaptive_max_rounds", adaptiveRound: round, adaptiveRounds, stages: stageReports, humanGate: createHumanGate("max_rounds", { detail: maxRoundsError }), error: maxRoundsError });
  }

  // Stage chain: stages from taskContract, or single synthetic stage for backward compat.
  const stages: TaskStage[] = context.taskContract?.stages
    ?? [{ name: "implementation", executor: context.executor, task: "实现 request.md 中的目标", reviewExecutor: context.reviewExecutor }];
  const stageReports: StageReport[] = [];

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex];
    const stageExecutor = stage.executor;
    const stageLabel = resolveExecutor(stageExecutor)?.label ?? "编码代理";
    // Feed the previous stage's handback forward as context injection.
    const prevHandback = stageIndex > 0 && existsSync(path.join(directory, "handback.md"))
      ? await readFile(path.join(directory, "handback.md"), "utf8") : "";
    const stageExtra = [extra, prevHandback ? `上一阶段交接：\n${prevHandback}` : "", stage.task].filter(Boolean).join("\n\n");
    logJobEvent(workspace, jobId, "stage_started", { stage: stage.name, executor: stageExecutor, index: stageIndex, total: stages.length });
    const outcome = await runStage({ workspace, jobId, directory, workdir, context, stage, stageIndex, stageLabel, stageExtra, attempt, attemptExtra, maxAttempts, cancelMarker, redact, finish, finishCancelled });
    if (outcome.terminal) {
      // 终态由 runStage 内的 finish 写入；补挂已累积的 stage 报告，否则中途失败时 result.json 丢失 stages。
      stageReports.push(outcome.report);
      const finalState = await writeState(workspace, jobId, { stages: stageReports });
      await writeResult(workspace, jobId, finalState);
      return finalState;
    }
    stageReports.push(outcome.report);
    attempt = outcome.attempt;
    attemptExtra = outcome.attemptExtra;
    // Preserve a per-stage copy of handback for the audit trail.
    const handbackFile = path.join(directory, "handback.md");
    if (existsSync(handbackFile)) {
      // stage.name 来自 task_contract，不可信：清洗后再拼文件名，防路径穿越。
      const safeName = stage.name.replace(/[^A-Za-z0-9._-]+/g, "-");
      const stageCopy = path.join(directory, `stage-${stageIndex}-${safeName}-handback.md`);
      await writeFile(stageCopy, await readFile(handbackFile, "utf8"), "utf8");
    }
    logJobEvent(workspace, jobId, "stage_finished", { stage: stage.name, executor: stageExecutor, index: stageIndex, exitCode: outcome.report.exitCode, reviewVerdict: outcome.report.reviewVerdict ?? "skipped" });
  }

  const lastReview = stageReports.at(-1)?.reviewVerdict ?? null;
  return finish({ status: "done", phase: "done", stages: stageReports, reviewVerdict: lastReview === "skipped" ? null : lastReview, reviewExitCode: 0, testExitCode: 0 });
}

async function prepareContinuationUnlocked(workspace: string, jobId: string, instructions: string, extraRounds = 0): Promise<{ instructions: string; blocked?: JobState }> {
  if (!Number.isInteger(extraRounds) || extraRounds < 0) throw new Error("extra_rounds 必须是非负整数。");
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
  if (gate.reason === "before_run" || gate.reason === "completion") return { instructions: safeInstructions, blocked: state };
  if (gate.reason === "max_rounds") {
    if (!extraRounds) return { instructions: safeInstructions, blocked: state };
    const directory = jobDir(workspace, jobId);
    const context = await loadJson<JobContext>(path.join(directory, "context.json"));
    if (!context.adaptive?.enabled) throw new Error("max_rounds gate 缺少 Adaptive 配置。");
    context.adaptive.maxRounds = extendRoundLimit(context.adaptive.maxRounds, extraRounds);
    await saveJson(path.join(directory, "context.json"), context);
  } else if (extraRounds) {
    throw new Error("extra_rounds 只能用于 max_rounds Human Gate。");
  }
  const humanGate = resolveHumanGate(gate, safeInstructions, redact);
  // 用户已针对 gate 给出纠偏：重置失败计数，避免旧 error 在续跑时被重复计入。
  await writeState(workspace, jobId, { humanGate, continuationInstructions: humanGate.instructions ?? null, blockingQuestions: null, blockedReason: null, failureTracker: null });
  return { instructions: safeInstructions };
}

async function prepareContinuation(workspace: string, jobId: string, instructions: string, extraRounds = 0): Promise<{ instructions: string; blocked?: JobState }> {
  return withFileLock(path.join(jobDir(workspace, jobId), "gate.lock"), () => prepareContinuationUnlocked(workspace, jobId, instructions, extraRounds), { retries: 0, busyMessage: `Human Gate 正在更新：${jobId}` });
}

export async function executeJob(workspaceInput: string, jobId: string, extra = "", queueEntryId?: string, extraRounds = 0): Promise<JobState> {
  const workspace = path.resolve(workspaceInput);
  const continuation = await prepareContinuation(workspace, jobId, extra, extraRounds);
  if (continuation.blocked) return continuation.blocked;
  const span = startSpan("cbx.job", { jobId });
  const lock = path.join(jobDir(workspace, jobId), "run.lock");
  return withFileLock(lock, async () => {
    try {
      // 排队中/前台被取消的任务不得启动：保留取消标记并返回终态。
      // 重新执行必须走 continue/retry（入队时清除取消标记）。
      const marker = path.join(jobDir(workspace, jobId), "cancel.requested");
      if (existsSync(marker)) {
        const current = await loadState(workspace, jobId);
        if (current.status === "cancelled") {
          if (queueEntryId) await finishQueueEntry(workspace, queueEntryId);
          await writeResult(workspace, jobId, current);
          return current;
        }
      }
      const result = await executeJobLocked(workspace, jobId, continuation.instructions, queueEntryId);
      if (queueEntryId) await dispatchQueue(workspace);
      return result;
    } finally {
      try {
        const finalState = await loadState(workspace, jobId);
        await finishSpan(workspace, span, finalState.status === "done" ? "ok" : "error", { status: finalState.status, attempt: finalState.attempt });
      } catch (error) { logJobEvent(workspace, jobId, "telemetry_failed", { error: error instanceof Error ? error.message : String(error) }); }
    }
  }, { retries: 0, busyMessage: `任务正在运行中：${jobId}` });
}

async function approveJobLocked(workspaceInput: string, jobId: string): Promise<JobState> {
  const workspace = path.resolve(workspaceInput);
  const state = await loadState(workspace, jobId);
  if (state.status !== "awaiting_approval") throw new Error(`任务当前不需要批准：${jobId}`);
  const gate = state.humanGate ? parseHumanGate(state.humanGate) : state.phase === "before_run" ? createHumanGate("before_run") : state.phase === "before_complete" ? createHumanGate("completion") : (() => { throw new Error("等待审批的任务缺少 Human Gate。"); })();
  if (gate.status !== "waiting") throw new Error("Human Gate 已解决，不能重复批准。");
  const config = await loadConfig(workspace);
  const redact = contextRedactor(config.governance);
  if (state.phase === "before_run" && gate.reason === "before_run") {
    return writeApprovalState(workspace, jobId, { status: "queued", phase: "queued", approved: true, approvalRequired: false, humanGate: resolveHumanGate(gate, "approved", redact) }, "done");
  }
  if (state.phase !== "before_complete" || gate.reason !== "completion") throw new Error("审批状态与 Human Gate 不一致。");
  const directory = jobDir(workspace, jobId);
  const context = await loadJson<JobContext>(path.join(directory, "context.json"));
  const pending = parsePendingCompletion(state.pendingCompletion);
  const worktreeFile = path.join(directory, "worktree.json");
  const recorded = existsSync(worktreeFile) ? await loadJson<{ path: string }>(worktreeFile) : undefined;
  const workdir = context.isolated ? recorded?.path : workspace;
  const hashes = await evidenceHashes(directory);
  const evidenceMatches = JSON.stringify(hashes) === JSON.stringify(pending.evidenceHashes);
  const snapshotMatches = Boolean(workdir && existsSync(workdir)) && worktreeSha256(await snapshotDiff(workdir!)) === pending.worktreeSha256;
  if (!evidenceMatches || !snapshotMatches || !completionEvidenceValid(context, state, hashes)) {
    const humanGate = resolveHumanGate(gate, "approval rejected because completion evidence changed", redact);
    const stale = await writeApprovalState(workspace, jobId, { status: "needs_fix", phase: "completion_evidence_stale", approvalRequired: false, pendingCompletion: null, humanGate, error: "完成审批证据或 worktree 已变化；拒绝完成，请重新执行验证。" }, "failed");
    await writeResult(workspace, jobId, stale);
    return stale;
  }
  const updates: Json = { status: "done", phase: "done", approvalRequired: false, completionApproved: true, approvedAt: now(), pendingCompletion: null, humanGate: resolveHumanGate(gate, "approved", redact), error: null };
  if (context.autoCommit) {
    try { updates.gitCommit = commitWorktree(workdir!, context.commitMessage) ?? null; }
    catch (error) {
      const failed = await writeApprovalState(workspace, jobId, { status: "failed", phase: "git_commit", approvalRequired: false, pendingCompletion: null, humanGate: resolveHumanGate(gate, "approval accepted; commit failed", redact), error: String(error), gitCommit: null }, "failed");
      await writeResult(workspace, jobId, failed);
      return failed;
    }
  }
  await writeApprovalState(workspace, jobId, updates, "done");
  if (!context.keepWorktree) {
    try { await cleanupWorktree(workspace, jobId); await writeState(workspace, jobId, { worktreeCleaned: true }); }
    catch (error) { await writeState(workspace, jobId, { cleanupError: String(error) }); }
  }
  const completed = await loadState(workspace, jobId);
  await writeResult(workspace, jobId, completed);
  return completed;
}

export async function approveJob(workspaceInput: string, jobId: string): Promise<JobState> {
  const workspace = path.resolve(workspaceInput);
  return withFileLock(path.join(jobDir(workspace, jobId), "run.lock"), () => approveJobLocked(workspace, jobId), { retries: 0, busyMessage: `任务正在运行中：${jobId}` });
}

const queueRuntime: QueueRuntime = { loadConfig, loadState, writeState, saveStateAndQueue, finishQueueEntryPersisted: savePersistedStateAndFinishQueue, jobDir };

export async function dispatchQueue(workspaceInput: string): Promise<QueueFile> {
  return queue.dispatchQueue(queueRuntime, workspaceInput);
}

export async function health(workspaceInput: string): Promise<{ status: "ok"; metrics: Awaited<ReturnType<typeof persistedMetrics>> }> {
  const workspace = path.resolve(workspaceInput);
  const config = await loadConfig(workspace);
  await prunePersistedData(workspace, config.governance?.retentionDays);
  return { status: "ok", metrics: await persistedMetrics(workspace) };
}

export async function serveQueue(workspaceInput: string, intervalMs = 30_000): Promise<queue.QueueService> {
  return queue.serveQueue(queueRuntime, workspaceInput, intervalMs);
}

export async function enqueueJob(workspaceInput: string, jobId: string, extra = "", priority = 0): Promise<QueueEntry> {
  return queue.enqueueJob(queueRuntime, workspaceInput, jobId, extra, priority);
}

export async function finishQueueEntry(workspaceInput: string, queueId: string): Promise<void> {
  return queue.finishQueueEntry(queueRuntime, workspaceInput, queueId);
}

export async function listQueue(workspaceInput: string): Promise<QueueFile> { return queue.listQueue(queueRuntime, workspaceInput); }

export async function pauseQueue(workspaceInput: string): Promise<QueueFile> {
  return queue.pauseQueue(queueRuntime, workspaceInput);
}

export async function resumeQueue(workspaceInput: string): Promise<QueueFile> {
  return queue.resumeQueue(queueRuntime, workspaceInput);
}

async function cancelQueueEntries(workspaceInput: string, jobId: string): Promise<QueueFile> {
  return queue.cancelQueueEntries(queueRuntime, workspaceInput, jobId);
}

export async function retryQueueJob(workspaceInput: string, jobId: string, priority = 0): Promise<QueueEntry> {
  return queue.retryQueueJob(queueRuntime, workspaceInput, jobId, priority);
}

export async function startBackground(workspaceInput: string, jobId: string, extra = "", priority = 0, contextSnapshot?: string, shouldRefreshBaseline = false, extraRounds = 0): Promise<void> {
  const workspace = path.resolve(workspaceInput);
  const directory = jobDir(workspace, jobId);
  const continuation = await prepareContinuation(workspace, jobId, extra, extraRounds);
  if (continuation.blocked) throw new Error(continuation.blocked.phase === "adaptive_max_rounds" ? "任务已达 max_rounds；请显式提供 extra_rounds。" : "任务等待 approve，不能通过 continue 恢复。");
  // 显式重新入队（continue/approve/start）：清除上次取消留下的标记。
  await unlink(path.join(directory, "cancel.requested")).catch(() => undefined);
  if (contextSnapshot !== undefined) {
    const governance = (await loadConfig(workspace)).governance;
    const snapshot = redactText(contextSnapshot, governance?.redactFields, governance?.redactPatterns);
    if (snapshot) await writeFile(path.join(directory, "context-snapshot.md"), snapshot, "utf8");
    else await unlink(path.join(directory, "context-snapshot.md")).catch(() => undefined);
  }
  await unlink(path.join(directory, "understanding.json")).catch(() => undefined);
  if (shouldRefreshBaseline) {
    await refreshBaseline(workspace, jobId, directory);
  }
  await enqueueJob(workspaceInput, jobId, continuation.instructions, priority);
}

export async function cancelJob(workspaceInput: string, jobId: string): Promise<JobState> {
  const workspace = path.resolve(workspaceInput);
  const directory = jobDir(workspace, jobId);
  const stateBeforeCancel = await loadState(workspace, jobId);
  const processIds = new Set<number>();
  if (stateBeforeCancel.status === "running") {
    const activePid = Number(await readFile(path.join(directory, "active.pid"), "utf8").catch(() => ""));
    if (Number.isSafeInteger(activePid) && activePid > 0) processIds.add(activePid);
  }
  try {
    const queueBeforeCancel = await listQueue(workspace);
    for (const entry of queueBeforeCancel.entries.filter(item => item.jobId === jobId && item.status === "running")) {
      if (Number.isSafeInteger(entry.pid) && Number(entry.pid) > 0) processIds.add(Number(entry.pid));
    }
  } catch (error) { logJobEvent(workspace, jobId, "queue_snapshot_failed", { error: error instanceof Error ? error.message : String(error) }); }
  await writeFile(path.join(directory, "cancel.requested"), now(), "utf8");
  try { await cancelQueueEntries(workspace, jobId); } catch (error) { logJobEvent(workspace, jobId, "queue_cancel_failed", { error: error instanceof Error ? error.message : String(error) }); }
  const survivors: number[] = [];
  for (const pid of processIds) {
    if (!await terminateTree(pid)) survivors.push(pid);
  }
  if (survivors.length > 0) {
    logJobEvent(workspace, jobId, "cancel_process_survived", { pids: survivors });
    return writeState(workspace, jobId, { status: "needs_fix", phase: "cancel_failed", error: `无法确认进程树已退出：${survivors.join(", ")}` });
  }
  try { await cleanupWorktree(workspace, jobId); } catch (error) { logJobEvent(workspace, jobId, "cleanup_failed", { phase: "cancel", error: error instanceof Error ? error.message : String(error) }); }
  return writeState(workspace, jobId, { status: "cancelled", phase: "cancelled", cancelledAt: now() });
}
