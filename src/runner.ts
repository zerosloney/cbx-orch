import { appendFileSync, existsSync } from "node:fs";
import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectExecutorPlugin, type ExecutorResult, type ExecutorRequest } from "./executor.js";
import { findExecutable, resolveExecutor, type BuiltinExecutor } from "./executors/builtin.js";
import { resolveRegisteredExecutor } from "./agent-registry.js";
import { runViaRunner, resolveRunnerPlugin, type RunnerPlugin } from "./runner-plugin.js";
import { MAX_CAPTURE_BYTES } from "./process-runner.js";
import { bumpInvocationCount, loadConfig } from "./state.js";
import { runProcess, runShell, type ProcessResult } from "./process-runner.js";
import { saveJson } from "./storage.js";
import { APP_VERSION } from "./version.js";

/** 截断字符串保留尾部（与 BoundedOutput 同一口径：保留最新内容）。 */
function truncateTail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(buffer.length - maxBytes).toString("utf8");
}

export type InvocationRole = "stage" | "review" | "manager" | "gate";

export interface InvocationMeta {
  role: InvocationRole;
  jobId: string;
  stageIndex?: number;
}

export function promptFor(phase: string, extra = "", _label: string, contextPack: string): string {
  return `你是任务执行代理。\n\n只读取当前角色上下文包：\n- ${contextPack}\n\n上下文包是编排器生成的最小化脱敏投影；只可额外读取其中 artifacts 明确列出的文件，不要读取任何未列材料或历史轨迹。\n当前阶段：${phase}\n\n${extra}`;
}

import { createLogEventFilter } from "./log-filter.js";
import { redactSensitive, redactText } from "./redaction.js";
import type { StreamLogEvent } from "./types.js";

/** governance.redactFields/redactPatterns 的最小化投影；未配置 governance 时为 undefined（零开销直写）。 */
interface EventRedaction {
  fields: string[];
  patterns: string[];
}

/**
 * 批量写缓冲：executor_stream_event 高频时把多条事件合并为一次 appendFileSync，
 * 显著减少 open/write/close 系统调用；进程正常退出经 exit 钩子 flush 兜底。
 * 耐久语义与改造前一致（写入即进 OS page cache，不额外 fsync）；进程被 SIGKILL/断电时
 * 最多丢失 buffer 内的尾部流事件——它们是诊断数据（executor_stream_event / 过程事件），
 * 审计关键事件（状态转换、lifecycle）走 publishEvent / logJobEvent，不经此路径。
 */
const EVENT_BUFFER_MAX_LINES = 128;
const EVENT_BUFFER_MAX_BYTES = 64 * 1024;
interface EventBuffer {
  lines: string[];
  bytes: number;
}
const eventBuffers = new Map<string, EventBuffer>();
let eventExitFlushInstalled = false;

/** 立即把指定 events 文件的缓冲写盘（幂等；写失败保留缓冲供 exit 钩子/下次阈值重试）。 */
export function flushEventBuffer(eventsFile: string): void {
  const buffer = eventBuffers.get(eventsFile);
  if (!buffer || buffer.lines.length === 0) return;
  try {
    appendFileSync(eventsFile, buffer.lines.join(""), "utf8");
    eventBuffers.delete(eventsFile);
  } catch {
    /* 写盘失败不阻断主流程；缓冲保留，exit 钩子或下一次阈值触发会重试 */
  }
}

/** 当前积压的未落盘事件行数（测试与诊断用）。 */
export function pendingEventBufferLines(eventsFile: string): number {
  return eventBuffers.get(eventsFile)?.lines.length ?? 0;
}

function installEventExitFlush(): void {
  if (eventExitFlushInstalled) return;
  eventExitFlushInstalled = true;
  // exit 钩子内只能跑同步代码；appendFileSync 满足要求。SIGKILL/断电不走此路径（文档见上）。
  process.on("exit", () => {
    for (const file of [...eventBuffers.keys()]) flushEventBuffer(file);
  });
}
installEventExitFlush();

/** 事件统一脱敏后再落盘：redactSensitive 按 key 匹配对象字段，
 *  redactText 再按行级 key 与全文正则兜底（覆盖句中内嵌密钥）。
 *  修复前 process_started 的完整 argv（含 prompt）与 executor_stream_event 的
 *  toolArgs 均绕过 governance.redactFields 直写 events.ndjson。 */
export function appendEvent(
  eventsFile: string,
  event: Record<string, unknown>,
  redaction?: EventRedaction,
): void {
  const payload = redaction
    ? redactText(
        JSON.stringify(redactSensitive(event, redaction.fields)),
        redaction.fields,
        redaction.patterns,
      )
    : JSON.stringify(event);
  let buffer = eventBuffers.get(eventsFile);
  if (!buffer) {
    buffer = { lines: [], bytes: 0 };
    eventBuffers.set(eventsFile, buffer);
  }
  buffer.lines.push(payload + "\n");
  buffer.bytes += payload.length + 1;
  if (
    buffer.lines.length >= EVENT_BUFFER_MAX_LINES ||
    buffer.bytes >= EVENT_BUFFER_MAX_BYTES
  )
    flushEventBuffer(eventsFile);
}

async function invokeBuiltin(
  spec: BuiltinExecutor,
  workspace: string,
  directory: string,
  workdir: string,
  prompt: string,
  permissionMode: string,
  maxTurns: number,
  timeoutMs: number,
  invocationMeta?: InvocationMeta,
  redaction?: EventRedaction,
  runner?: RunnerPlugin,
): Promise<ProcessResult> {
  const executable = findExecutable(spec);
  const args = [...executable.slice(1), ...spec.buildArgs({ prompt, permissionMode, maxTurns })];
  const command = executable[0];
  const eventsFile = path.join(directory, "events.ndjson");
  const outputLog = path.join(directory, "agent.log");
  appendEvent(eventsFile, { event: "executor_metadata", source: "builtin", name: spec.name, version: APP_VERSION, at: new Date().toISOString() }, redaction);
  appendEvent(eventsFile, { event: "process_started", command: [command, ...args], cwd: workdir, runner: runner ? runner.manifest.name : undefined, at: new Date().toISOString() }, redaction);
  // runner 模式：命令由插件执行（容器内），host 不 spawn 子进程，无流式事件与 active.pid。
  if (runner) {
    const result = await runViaRunner(runner, {
      workspace,
      directory,
      workdir,
      command: [command, ...args],
      shell: false,
      role: invocationMeta?.role ?? "stage",
      timeoutMs,
      env: { ...process.env },
      logFile: outputLog,
    });
    // 捕获输出写 agent.log（有界：保留尾部 MAX_CAPTURE_BYTES）
    const bounded = truncateTail(result.output, MAX_CAPTURE_BYTES);
    await appendFile(
      outputLog,
      bounded + (bounded.length < result.output.length ? "\n[输出已截断]\n" : "") + `\n退出码：${result.code}\n超时：${result.timedOut}\n`,
      "utf8",
    );
    return { code: result.code, timedOut: result.timedOut, output: result.output };
  }

  const filter = createLogEventFilter(spec.name);
  const filterContext = {
    jobId: invocationMeta?.jobId ?? "",
    executor: spec.name,
    stageName: invocationMeta?.stageIndex !== undefined ? `stage_${invocationMeta.stageIndex}` : undefined,
  };
  const streamOptions = {
    filter,
    filterContext,
    onLogEvent: (evt: StreamLogEvent) => {
      appendEvent(eventsFile, { event: "executor_stream_event", ...evt }, redaction);
    },
  };

  const result = await runProcess(command, args, workdir, timeoutMs, outputLog, path.join(directory, "active.pid"), streamOptions);
  appendEvent(eventsFile, { event: "process_finished", returncode: result.code, timedOut: result.timedOut, at: new Date().toISOString() }, redaction);
  return result;
}

export async function invokeExecutor(executor: string, workspace: string, directory: string, workdir: string, prompt: string, permissionMode: string, maxTurns: number, timeoutMs: number, invocationMeta?: InvocationMeta): Promise<ProcessResult> {
  const config = await loadConfig(workspace);
  // runner 插件：untrusted 任务的容器执行边界（executor/test/review 命令都经它）。
  // 解析失败（路径穿越 / manifest 无效）抛 RunnerPluginError，任务以明确错误失败。
  const runner = config.execution?.runner
    ? await resolveRunnerPlugin(config.execution.runner, workspace)
    : undefined;
  const redaction: EventRedaction | undefined = config.governance
    ? {
        fields: config.governance.redactFields ?? [],
        patterns: config.governance.redactPatterns ?? [],
      }
    : undefined;
  const eventsFile = path.join(directory, "events.ndjson");
  if (invocationMeta?.jobId) {
    try {
      await bumpInvocationCount(
        workspace,
        invocationMeta.jobId,
        invocationMeta.role,
        invocationMeta.stageIndex,
      );
    } catch (error) {
      // 计数失败不应阻塞执行器调用；落审计事件便于排障。
      appendEvent(eventsFile, {
        event: "invocation_count_failed",
        role: invocationMeta.role,
        stageIndex: invocationMeta.stageIndex,
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      }, redaction);
    }
  }
  // 先查内置注册表，再查 agent-registry 的文件 spec（.cbx/agents/*.json），都未命中才走 ESM 插件路径。
  const builtin =
    resolveExecutor(executor) ?? (await resolveRegisteredExecutor(executor, workspace));
  if (builtin)
    return invokeBuiltin(
      builtin,
      workspace,
      directory,
      workdir,
      prompt,
      permissionMode,
      maxTurns,
      timeoutMs,
      invocationMeta,
      redaction,
      runner,
    );
  const identity = await inspectExecutorPlugin(
    executor,
    workspace,
    config.plugins ?? { enforce: true },
  );
  if (config.plugins?.enforce === false) {
    // 显式禁用 enforce 时告警留痕：插件已加载，但未经路径/SHA 白名单校验。
    const warning = `executor 指向插件 ${identity.path}，但 plugins.enforce=false，插件未经路径/SHA 白名单校验即被加载；生产环境请配置 plugins.enforce=true 与 allowPaths/allowSha256。`;
    console.error(`cbx: ${warning}`);
    appendEvent(eventsFile, { event: "plugin_policy_warning", executor: identity.name, path: identity.path, sha256: identity.sha256, enforce: false, at: new Date().toISOString() }, redaction);
  }
  const request: ExecutorRequest = { directory, workdir, prompt, permissionMode, maxTurns, timeoutMs, executor, plugin: { policy: config.plugins, sha256: identity.sha256 } };
  appendEvent(eventsFile, { event: "executor_metadata", source: identity.source, name: identity.name, version: identity.version, apiVersion: identity.apiVersion, capabilities: identity.capabilities, sha256: identity.sha256, at: new Date().toISOString() }, redaction);
  appendEvent(eventsFile, { event: "plugin_started", executor: identity.name, at: new Date().toISOString() }, redaction);
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
  appendEvent(eventsFile, { event: "plugin_finished", executor, code: normalized.code, timedOut: normalized.timedOut, at: new Date().toISOString() }, redaction);
  return normalized;
}

export async function runTest(workspace: string, directory: string, workdir: string, command: string | undefined, timeoutMs: number): Promise<ProcessResult> {
  if (!command) { await writeFile(path.join(directory, "test.log"), "未指定测试命令。\n", "utf8"); return { code: 0, timedOut: false, output: "" }; }
  const logFile = path.join(directory, "test.log");
  await writeFile(logFile, `$ ${command}\n\n`, "utf8");
  const config = await loadConfig(workspace);
  const runner = config.execution?.runner
    ? await resolveRunnerPlugin(config.execution.runner, workspace)
    : undefined;
  if (runner) {
    // runner 模式：测试命令在容器内执行（shell 语义由插件决定），host 写捕获输出。
    const result = await runViaRunner(runner, {
      workspace,
      directory,
      workdir,
      command: [command],
      shell: true,
      role: "test",
      timeoutMs,
      env: { ...process.env },
      logFile,
    });
    const bounded = truncateTail(result.output, MAX_CAPTURE_BYTES);
    await appendFile(
      logFile,
      bounded + (bounded.length < result.output.length ? "\n[输出已截断]\n" : "") + `\n退出码：${result.code}\n超时：${result.timedOut}\n`,
      "utf8",
    );
    return { code: result.code, timedOut: result.timedOut, output: result.output };
  }
  const result = await runShell(command, workdir, timeoutMs, logFile, path.join(directory, "active.pid"));
  await appendFile(logFile, `\n退出码：${result.code}\n超时：${result.timedOut}\n内存输出已截断：${Boolean(result.outputTruncated)}\n`, "utf8");
  return result;
}
