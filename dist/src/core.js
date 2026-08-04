import { spawnSync } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finishSpan, publishEvent, startSpan } from "./observability.js";
import { inspectExecutorPlugin } from "./executor.js";
import { findExecutable, resolveExecutor } from "./executors/builtin.js";
import { listPersistedStates, loadJson, loadPersistedState, loadRuntimeConfig, now, persistedMetrics, prunePersistedData, redactText, saveJson, savePersistedState, savePersistedStateAndFinishQueue, savePersistedStateAndQueue, withFileLock } from "./storage.js";
import { runProcess, runShell } from "./process-runner.js";
import { cleanupRecordedWorktree, collectDiff, commitWorktree, gitRoot, prepareWorktree, snapshotDiff } from "./git-ops.js";
import * as queue from "./queue.js";
const APP_VERSION = "0.8.0";
/** 把降级路径的失败原因落到 job 事件流，避免裸吞导致排障无据。 */
function logJobEvent(workspace, jobId, event, detail = {}) {
    try {
        appendFileSync(path.join(jobDir(workspace, jobId), "events.ndjson"), JSON.stringify({ event, jobId, ...detail, at: now() }) + "\n", "utf8");
    }
    catch { /* events file itself unreachable — nothing more we can do */ }
}
function assertJobId(jobId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId) || jobId === "." || jobId === "..")
        throw new Error(`无效的任务 ID：${jobId}`);
}
export function jobDir(workspace, jobId) {
    assertJobId(jobId);
    return path.join(workspace, ".cbx", "jobs", jobId);
}
export async function loadState(workspace, jobId) {
    jobDir(workspace, jobId);
    const value = await loadPersistedState(workspace, jobId);
    if (!value || typeof value !== "object")
        throw new Error(`任务不存在或状态文件损坏：${jobId}`);
    return value;
}
export async function loadConfig(workspaceInput) {
    return loadRuntimeConfig(workspaceInput);
}
export function mergeConfig(config, overrides) {
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
        maxConcurrent: overrides.maxConcurrent ?? config.maxConcurrent ?? 2,
        autoBranch: overrides.autoBranch ?? config.git?.autoBranch ?? false,
        autoCommit: overrides.autoCommit ?? config.git?.autoCommit ?? false,
        commitMessage: overrides.commitMessage ?? config.git?.commitMessage ?? "chore(cbx): apply task",
        executor: overrides.executor ?? config.executor ?? "codebuddy",
        trustMode: overrides.trustMode ?? config.execution?.trustMode ?? "trusted",
    };
}
function assertExecutionPolicy(trustMode, isolated) {
    if (trustMode !== "trusted" && trustMode !== "untrusted")
        throw new Error(`不支持的 trustMode：${trustMode}`);
    if (trustMode === "untrusted") {
        if (!isolated)
            throw new Error("untrusted 任务必须设置 isolated=true；Git worktree 不是安全沙箱。");
        throw new Error("当前 cbx 未提供 OS 容器沙箱，拒绝启用 untrusted 模式；请使用受控的外部容器 runner。");
    }
}
export async function writeState(workspace, jobId, updates, queueEntryId) {
    const state = await loadState(workspace, jobId);
    const previousStatus = state.status;
    Object.assign(state, updates, { updatedAt: now() });
    if (queueEntryId)
        await savePersistedStateAndFinishQueue(workspace, jobId, state, queueEntryId);
    else
        await savePersistedState(workspace, jobId, state);
    await saveJson(path.join(jobDir(workspace, jobId), "state.json"), state);
    await prunePersistedData(workspace, (await loadConfig(workspace)).governance?.retentionDays);
    try {
        await publishEvent(workspace, "job.state_changed", { jobId, previousStatus, status: state.status, phase: state.phase, attempt: state.attempt });
    }
    catch { /* event delivery must not mask the durable state change */ }
    return state;
}
function normalizeJobId(value) {
    const cleaned = value?.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return cleaned || `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`;
}
function validateWorkspace(workspace) {
    const resolved = path.resolve(workspace);
    if (path.dirname(resolved) === resolved)
        throw new Error("不允许把文件系统根目录作为工作区。");
    if (!existsSync(resolved))
        throw new Error(`工作区不存在：${resolved}`);
}
function validateTestCommand(command) {
    if (!command)
        return;
    if (/[;&|<>]/.test(command) || /(?:rm\s+-rf|Remove-Item|del\s+\/s|format\s+)/i.test(command)) {
        throw new Error("测试命令包含不允许的 shell 操作符或破坏性命令。");
    }
}
function validatePermissionMode(mode, allowUnsafe = false) {
    const allowed = new Set(["default", "acceptEdits", "auto", "dontAsk", "plan"]);
    if (!allowed.has(mode))
        throw new Error(`不支持的 permission mode：${mode}`);
    if (mode === "dontAsk" && !allowUnsafe)
        throw new Error("dontAsk 需要显式使用 --dangerously-skip-permissions；请在编排器外部确认后再启用。");
}
export async function createJob(options) {
    const workspace = path.resolve(options.workspace);
    validateWorkspace(workspace);
    validateTestCommand(options.testCommand);
    validatePermissionMode(options.permissionMode, options.allowUnsafePermissions);
    assertExecutionPolicy(options.trustMode ?? "trusted", options.isolated);
    if (!Number.isFinite(options.maxTurns) || options.maxTurns < 1)
        throw new Error("maxTurns 必须是正整数。");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100))
        throw new Error("timeoutMs 必须不小于 100ms。");
    if (options.maxRetries !== undefined && (!Number.isInteger(options.maxRetries) || options.maxRetries < 0))
        throw new Error("maxRetries 必须是非负整数。");
    if (options.autoCommit && !options.isolated)
        throw new Error("autoCommit 要求 isolated=true，避免提交主工作区中的无关修改。");
    // 测试命令黑名单是软防线（正则可被变体绕过）。非隔离时强警告：cbx 不保证命令安全，应运行在受控环境。
    if (options.testCommand && !options.isolated) {
        console.error(`cbx 警告：测试命令将在主工作区执行（isolated=false），cbx 不保证其安全性：${options.testCommand}`);
    }
    const jobId = normalizeJobId(options.jobId);
    const directory = jobDir(workspace, jobId);
    if (existsSync(directory))
        throw new Error(`任务已存在：${jobId}`);
    await mkdir(directory, { recursive: true });
    const request = `# 任务\n\n## 目标\n\n${options.task.trim()}\n\n## 验收命令\n\n${options.testCommand ?? "未指定；请根据项目现有脚本选择最相关的检查。"}\n\n## 执行规则\n\n- 只修改完成目标所需的文件。\n- 先检查项目结构和现有测试，再修改。\n- 完成后运行验收命令。\n- 将修改摘要、测试命令、测试结果和遗留问题写入 handback.md。\n`;
    await writeFile(path.join(directory, "request.md"), request, "utf8");
    const governance = (await loadConfig(workspace)).governance;
    const snapshot = redactText(options.contextSnapshot ?? "", governance?.redactFields, governance?.redactPatterns);
    if (snapshot)
        await writeFile(path.join(directory, "context-snapshot.md"), snapshot, "utf8");
    const context = {
        appVersion: APP_VERSION, jobId, workspace, createdAt: now(), testCommand: options.testCommand,
        reviewRequested: options.review, isolated: options.isolated, permissionMode: options.permissionMode,
        maxTurns: options.maxTurns, timeoutMs: options.timeoutMs ?? 30 * 60_000,
        maxRetries: options.maxRetries ?? 1, keepWorktree: options.keepWorktree ?? false,
        reviewRules: options.reviewRules, approvalBeforeRun: options.approvalBeforeRun ?? false,
        autoBranch: options.autoBranch ?? false, autoCommit: options.autoCommit ?? false,
        commitMessage: options.commitMessage ?? "chore(cbx): apply task",
        executor: options.executor ?? "codebuddy",
        trustMode: options.trustMode ?? "trusted",
        gitRoot: gitRoot(workspace),
    };
    await saveJson(path.join(directory, "context.json"), context);
    const state = {
        jobId, status: "queued", phase: "queued", workspace, jobDir: directory,
        createdAt: now(), updatedAt: now(), attempt: 0,
    };
    await savePersistedState(workspace, jobId, state);
    await saveJson(path.join(directory, "state.json"), state);
    return { jobId, directory };
}
export async function cleanupWorktree(workspaceInput, jobId) {
    const workspace = path.resolve(workspaceInput);
    const directory = jobDir(workspace, jobId);
    return cleanupRecordedWorktree(workspace, directory);
}
function promptFor(directory, phase, extra = "", label = "编码代理", hasSnapshot = false) {
    const snapshotLine = hasSnapshot ? `- ${path.join(directory, "context-snapshot.md")}\n` : "";
    return `你是 ${label} 执行代理。\n\n必须先读取：\n- ${path.join(directory, "request.md")}\n${snapshotLine}- ${path.join(directory, "context.json")}\n\n当前阶段：${phase}\n\n持久化要求：\n- 完成后将交接报告写入 ${path.join(directory, "handback.md")}。\n- 报告必须包含：修改文件、关键设计、运行过的命令、结果、未解决问题。\n- 不要把关键信息只放在聊天输出中。\n\n${extra}`;
}
async function invokeBuiltin(spec, directory, workdir, prompt, permissionMode, maxTurns, timeoutMs) {
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
async function invokeExecutor(executor, workspace, directory, workdir, prompt, permissionMode, maxTurns, timeoutMs) {
    const builtin = resolveExecutor(executor);
    if (builtin)
        return invokeBuiltin(builtin, directory, workdir, prompt, permissionMode, maxTurns, timeoutMs);
    const config = await loadConfig(workspace);
    const identity = await inspectExecutorPlugin(executor, workspace, config.plugins);
    const request = { directory, workdir, prompt, permissionMode, maxTurns, timeoutMs, executor, plugin: { policy: config.plugins, sha256: identity.sha256 } };
    appendFileSync(path.join(directory, "events.ndjson"), JSON.stringify({ event: "executor_metadata", source: identity.source, name: identity.name, version: identity.version, apiVersion: identity.apiVersion, capabilities: identity.capabilities, sha256: identity.sha256, at: now() }) + "\n", "utf8");
    appendFileSync(path.join(directory, "events.ndjson"), JSON.stringify({ event: "plugin_started", executor: identity.name, at: now() }) + "\n", "utf8");
    const requestFile = path.join(directory, "plugin-request.json");
    await saveJson(requestFile, request);
    const host = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-host.js");
    const processResult = await runProcess(process.execPath, [host, executor, workspace, requestFile], workdir, timeoutMs, path.join(directory, "agent.log"), path.join(directory, "active.pid"));
    let pluginResult = { code: processResult.code, timedOut: processResult.timedOut, output: processResult.output };
    const marker = /CBX_PLUGIN_RESULT=([A-Za-z0-9+/=]+)/g;
    const matches = [...processResult.output.matchAll(marker)];
    if (!processResult.timedOut && matches.length) {
        try {
            pluginResult = JSON.parse(Buffer.from(matches.at(-1)[1], "base64").toString("utf8"));
        }
        catch {
            pluginResult = { code: -1, output: "executor plugin returned an invalid result" };
        }
    }
    const normalized = { code: Number(pluginResult.code ?? processResult.code), timedOut: processResult.timedOut || Boolean(pluginResult.timedOut), output: String(pluginResult.output ?? processResult.output) };
    appendFileSync(path.join(directory, "events.ndjson"), JSON.stringify({ event: "plugin_finished", executor, code: normalized.code, timedOut: normalized.timedOut, at: now() }) + "\n", "utf8");
    return normalized;
}
async function runTest(directory, workdir, command, timeoutMs) {
    if (!command) {
        await writeFile(path.join(directory, "test.log"), "未指定测试命令。\n", "utf8");
        return { code: 0, timedOut: false, output: "" };
    }
    const result = await runShell(command, workdir, timeoutMs);
    await writeFile(path.join(directory, "test.log"), `$ ${command}\n\n${result.output}\n退出码：${result.code}\n超时：${result.timedOut}\n`, "utf8");
    return result;
}
const ARTIFACTS = new Set(["request.md", "context-snapshot.md", "context.json", "state.json", "events.ndjson", "agent.log", "handback.md", "review.md", "test.log", "git-status.txt", "diff.patch", "complete.patch", "untracked-files.txt", "result.json"]);
export async function listJobs(workspaceInput) {
    const workspace = path.resolve(workspaceInput);
    return listPersistedStates(workspace);
}
async function saveStateAndQueue(workspace, jobId, state, queueFile) {
    const previousStatus = (await loadState(workspace, jobId)).status;
    await savePersistedStateAndQueue(workspace, jobId, state, queueFile);
    await saveJson(path.join(jobDir(workspace, jobId), "state.json"), state);
    await prunePersistedData(workspace, (await loadConfig(workspace)).governance?.retentionDays);
    try {
        await publishEvent(workspace, "job.state_changed", { jobId, previousStatus, status: state.status, phase: state.phase, attempt: state.attempt });
    }
    catch { /* durable state and queue transaction must not depend on delivery */ }
}
export async function readArtifact(workspaceInput, jobId, artifact) {
    if (!ARTIFACTS.has(artifact))
        throw new Error(`不允许读取任务文件：${artifact}`);
    return readFile(path.join(jobDir(path.resolve(workspaceInput), jobId), artifact), "utf8");
}
async function writeResult(workspace, jobId, state) {
    const directory = jobDir(workspace, jobId);
    const files = [];
    for (const file of ARTIFACTS)
        if (existsSync(path.join(directory, file)))
            files.push(file);
    await saveJson(path.join(directory, "result.json"), {
        jobId, status: state.status, phase: state.phase, attempt: state.attempt,
        error: state.error ?? null, executorExitCode: state.executorExitCode ?? state.codebuddyExitCode ?? null,
        testExitCode: state.testExitCode ?? null, reviewVerdict: state.reviewVerdict ?? null,
        files, updatedAt: now(),
    });
}
async function executeJobLocked(workspace, jobId, extra = "", queueEntryId) {
    const directory = jobDir(workspace, jobId);
    const initial = await loadState(workspace, jobId);
    const context = await loadJson(path.join(directory, "context.json"));
    // intentional-simple: 只比对主版本。旧 job 跨版本续跑时告警但不硬阻断——context schema 向后兼容。
    const jobMajor = String(context.appVersion ?? "").split(".")[0];
    if (jobMajor && jobMajor !== APP_VERSION.split(".")[0]) {
        const warning = `任务由 cbx v${context.appVersion} 创建，当前运行 v${APP_VERSION}；context schema 可能不兼容。`;
        logJobEvent(workspace, jobId, "version_mismatch", { jobVersion: context.appVersion, runtimeVersion: APP_VERSION, warning });
        console.error(`cbx: ${warning}`);
    }
    const label = resolveExecutor(context.executor)?.label ?? "编码代理";
    assertExecutionPolicy(context.trustMode ?? "trusted", context.isolated);
    if (context.approvalBeforeRun && initial.approved !== true) {
        return writeState(workspace, jobId, { status: "awaiting_approval", phase: "before_run", approvalRequired: true });
    }
    const worktreeFile = path.join(directory, "worktree.json");
    const recordedWorkdir = existsSync(worktreeFile) ? (await loadJson(worktreeFile)).path : "";
    const workdir = recordedWorkdir && existsSync(recordedWorkdir) ? recordedWorkdir : await prepareWorktree(workspace, directory, jobId, context.isolated, context.autoBranch);
    const maxAttempts = Math.max(1, context.maxRetries + 1);
    let attempt = Number(initial.attempt ?? 0);
    let attemptExtra = extra;
    let lastError = "";
    const cancelMarker = path.join(directory, "cancel.requested");
    const finish = async (updates) => {
        let finalUpdates = { ...updates };
        if (updates.status === "done" && context.autoCommit) {
            try {
                const commitHash = commitWorktree(workdir, context.commitMessage);
                if (commitHash)
                    finalUpdates.gitCommit = commitHash;
            }
            catch (error) {
                finalUpdates = { status: "failed", phase: "git_commit", error: String(error), gitCommit: null };
            }
        }
        const result = await writeState(workspace, jobId, finalUpdates, queueEntryId);
        if (!context.keepWorktree && ["done", "failed", "needs_fix", "review_failed"].includes(String(result.status))) {
            try {
                await cleanupWorktree(workspace, jobId);
                await writeState(workspace, jobId, { worktreeCleaned: true });
            }
            catch (error) {
                await writeState(workspace, jobId, { cleanupError: String(error) });
            }
        }
        const finalState = await loadState(workspace, jobId);
        await writeResult(workspace, jobId, finalState);
        return finalState;
    };
    const finishCancelled = async () => {
        try {
            await cleanupWorktree(workspace, jobId);
        }
        catch (error) {
            await writeState(workspace, jobId, { cleanupError: String(error) });
        }
        const finalState = await writeState(workspace, jobId, { status: "cancelled", phase: "cancelled", cancelledAt: now() }, queueEntryId);
        await writeResult(workspace, jobId, finalState);
        return finalState;
    };
    for (let tryNumber = 1; tryNumber <= maxAttempts; tryNumber += 1) {
        if (existsSync(cancelMarker))
            return finishCancelled();
        attempt += 1;
        await writeState(workspace, jobId, { status: "running", phase: "executing", attempt, workdir, error: lastError || null });
        let agent;
        try {
            agent = await invokeExecutor(context.executor, workspace, directory, workdir, promptFor(directory, "implementation", attemptExtra, label, existsSync(path.join(directory, "context-snapshot.md"))), context.permissionMode, context.maxTurns, context.timeoutMs);
        }
        catch (error) {
            lastError = String(error);
            if (tryNumber < maxAttempts) {
                await writeState(workspace, jobId, { phase: "retrying", retryReason: lastError });
                continue;
            }
            return finish({ status: "failed", phase: "executing", error: lastError });
        }
        if (existsSync(cancelMarker))
            return finishCancelled();
        await collectDiff(directory, workdir);
        if (agent.code !== 0 || agent.timedOut) {
            lastError = agent.timedOut ? `${label} 超时（${context.timeoutMs}ms）` : `${label} 执行失败`;
            if (tryNumber < maxAttempts) {
                await writeState(workspace, jobId, { phase: "retrying", retryReason: lastError, executorExitCode: agent.code });
                continue;
            }
            return finish({ status: "failed", phase: "executing", executorExitCode: agent.code, timedOut: agent.timedOut, error: lastError });
        }
        await writeState(workspace, jobId, { phase: "testing", executorExitCode: 0 });
        const test = await runTest(directory, workdir, context.testCommand, context.timeoutMs);
        if (existsSync(cancelMarker))
            return finishCancelled();
        const reviewedSnapshot = await collectDiff(directory, workdir);
        if (test.code !== 0 || test.timedOut) {
            lastError = test.timedOut ? `验收命令超时（${context.timeoutMs}ms）` : "验收命令失败";
            attemptExtra = `请读取 ${path.join(directory, "test.log")}，修复失败原因后重新执行。`;
            if (tryNumber < maxAttempts) {
                await writeState(workspace, jobId, { phase: "retrying", retryReason: lastError, testExitCode: test.code });
                continue;
            }
            return finish({ status: "needs_fix", phase: "testing", testExitCode: test.code, timedOut: test.timedOut, error: lastError });
        }
        if (!context.reviewRequested)
            return finish({ status: "done", phase: "done", testExitCode: 0 });
        await writeState(workspace, jobId, { status: "running", phase: "reviewing", testExitCode: 0 });
        const reviewExtra = `审查以下材料：\n- ${path.join(directory, "complete.patch")}\n- ${path.join(directory, "git-status.txt")}\n- ${path.join(directory, "untracked-files.txt")}\n- ${path.join(directory, "test.log")}\n- ${path.join(directory, "handback.md")}（如果存在）\n\n不要修改代码。将结果写入 ${path.join(directory, "review.md")}。第一行必须是 VERDICT: PASS 或 VERDICT: FAIL。按严重程度列出问题、文件和行号。\n\n审查规则：\n${context.reviewRules ?? "关注正确性、回归风险、安全性、测试覆盖和改动范围。"}`;
        let reviewAgent;
        try {
            reviewAgent = await invokeExecutor(context.executor, workspace, directory, workdir, promptFor(directory, "independent review", reviewExtra, label, existsSync(path.join(directory, "context-snapshot.md"))), context.permissionMode, context.maxTurns, context.timeoutMs);
        }
        catch (error) {
            lastError = String(error);
            if (tryNumber < maxAttempts) {
                await writeState(workspace, jobId, { phase: "retrying", retryReason: lastError });
                continue;
            }
            return finish({ status: "review_failed", phase: "reviewing", error: lastError });
        }
        if (existsSync(cancelMarker))
            return finishCancelled();
        const afterReview = await snapshotDiff(workdir);
        if (JSON.stringify(afterReview) !== JSON.stringify(reviewedSnapshot)) {
            await collectDiff(directory, workdir);
            lastError = "审查代理修改了工作区；为避免交付未经测试的代码，任务已停止";
            return finish({ status: "review_failed", phase: "reviewing", reviewExitCode: reviewAgent.code, reviewerModifiedWorktree: true, error: lastError });
        }
        if (reviewAgent.code !== 0 || reviewAgent.timedOut) {
            lastError = reviewAgent.timedOut ? `审查超时（${context.timeoutMs}ms）` : "审查代理执行失败";
            if (tryNumber < maxAttempts) {
                await writeState(workspace, jobId, { phase: "retrying", retryReason: lastError });
                continue;
            }
            return finish({ status: "review_failed", phase: "reviewing", reviewExitCode: reviewAgent.code, timedOut: reviewAgent.timedOut, error: lastError });
        }
        const review = existsSync(path.join(directory, "review.md")) ? await readFile(path.join(directory, "review.md"), "utf8") : "";
        const firstLine = review.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].trim();
        const pass = /^VERDICT\s*:\s*PASS$/i.test(firstLine);
        if (pass)
            return finish({ status: "done", phase: "done", reviewVerdict: "PASS", reviewExitCode: 0 });
        lastError = "审查发现问题";
        attemptExtra = `请读取 ${path.join(directory, "review.md")}，修复其中的问题后重新执行。`;
        if (tryNumber < maxAttempts) {
            await writeState(workspace, jobId, { phase: "retrying", retryReason: lastError });
            continue;
        }
        return finish({ status: "needs_fix", phase: "reviewing", reviewVerdict: "FAIL", reviewExitCode: 0, error: lastError });
    }
    return finish({ status: "failed", phase: "executing", error: "任务未能完成" });
}
export async function executeJob(workspaceInput, jobId, extra = "", queueEntryId) {
    const workspace = path.resolve(workspaceInput);
    const span = startSpan("cbx.job", { jobId });
    const lock = path.join(jobDir(workspace, jobId), "run.lock");
    return withFileLock(lock, async () => {
        try {
            try {
                await unlink(path.join(jobDir(workspace, jobId), "cancel.requested"));
            }
            catch { /* new run clears an old cancellation */ }
            const result = await executeJobLocked(workspace, jobId, extra, queueEntryId);
            if (queueEntryId)
                await dispatchQueue(workspace);
            return result;
        }
        finally {
            try {
                const finalState = await loadState(workspace, jobId);
                await finishSpan(workspace, span, finalState.status === "done" ? "ok" : "error", { status: finalState.status, attempt: finalState.attempt });
            }
            catch (error) {
                logJobEvent(workspace, jobId, "telemetry_failed", { error: error instanceof Error ? error.message : String(error) });
            }
        }
    }, { retries: 0, busyMessage: `任务正在运行中：${jobId}` });
}
export async function approveJob(workspaceInput, jobId) {
    const workspace = path.resolve(workspaceInput);
    const state = await loadState(workspace, jobId);
    if (state.status !== "awaiting_approval")
        throw new Error(`任务当前不需要批准：${jobId}`);
    return writeState(workspace, jobId, { status: "queued", phase: "queued", approved: true, approvalRequired: false });
}
const queueRuntime = { loadConfig, loadState, writeState, saveStateAndQueue, jobDir };
export async function dispatchQueue(workspaceInput) {
    return queue.dispatchQueue(queueRuntime, workspaceInput);
}
export async function health(workspaceInput) {
    const workspace = path.resolve(workspaceInput);
    const config = await loadConfig(workspace);
    await prunePersistedData(workspace, config.governance?.retentionDays);
    return { status: "ok", metrics: await persistedMetrics(workspace) };
}
export async function serveQueue(workspaceInput, intervalMs = 30_000) {
    return queue.serveQueue(queueRuntime, workspaceInput, intervalMs);
}
export async function enqueueJob(workspaceInput, jobId, extra = "", priority = 0) {
    return queue.enqueueJob(queueRuntime, workspaceInput, jobId, extra, priority);
}
export async function finishQueueEntry(workspaceInput, queueId) {
    return queue.finishQueueEntry(queueRuntime, workspaceInput, queueId);
}
export async function listQueue(workspaceInput) { return queue.listQueue(queueRuntime, workspaceInput); }
export async function pauseQueue(workspaceInput) {
    return queue.pauseQueue(queueRuntime, workspaceInput);
}
export async function resumeQueue(workspaceInput) {
    return queue.resumeQueue(queueRuntime, workspaceInput);
}
export async function retryQueueJob(workspaceInput, jobId, priority = 0) {
    return queue.retryQueueJob(queueRuntime, workspaceInput, jobId, priority);
}
export async function startBackground(workspaceInput, jobId, extra = "", priority = 0, contextSnapshot) {
    if (contextSnapshot !== undefined) {
        const workspace = path.resolve(workspaceInput);
        const directory = jobDir(workspace, jobId);
        const governance = (await loadConfig(workspace)).governance;
        const snapshot = redactText(contextSnapshot, governance?.redactFields, governance?.redactPatterns);
        if (snapshot)
            await writeFile(path.join(directory, "context-snapshot.md"), snapshot, "utf8");
        else
            await unlink(path.join(directory, "context-snapshot.md")).catch(() => undefined);
    }
    await enqueueJob(workspaceInput, jobId, extra, priority);
}
export async function cancelJob(workspaceInput, jobId) {
    const workspace = path.resolve(workspaceInput);
    const directory = jobDir(workspace, jobId);
    await writeFile(path.join(directory, "cancel.requested"), now(), "utf8");
    for (const file of [path.join(directory, "active.pid"), path.join(directory, "pid")]) {
        if (!existsSync(file))
            continue;
        const pid = Number(await readFile(file, "utf8"));
        if (process.platform === "win32")
            spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        else {
            try {
                process.kill(-pid, "SIGTERM");
            }
            catch {
                try {
                    process.kill(pid, "SIGTERM");
                }
                catch { /* already exited */ }
            }
        }
    }
    try {
        await cleanupWorktree(workspace, jobId);
    }
    catch (error) {
        logJobEvent(workspace, jobId, "cleanup_failed", { phase: "cancel", error: error instanceof Error ? error.message : String(error) });
    }
    return writeState(workspace, jobId, { status: "cancelled", phase: "cancelled", cancelledAt: now() });
}
