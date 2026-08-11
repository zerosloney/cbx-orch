#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  approveJob,
  cancelJob,
  cleanupWorktree,
  dispatchQueue,
  createJob,
  executeJob,
  health,
  jobDir,
  listJobs,
  listQueue,
  loadConfig,
  loadState,
  mergeConfig,
  pauseQueue,
  readArtifact,
  resumeQueue,
  retryQueueJob,
  serveQueue,
  startBackground,
} from "./core.js";
import { runReviewGate, stopReviewGateHook } from "./review-gate.js";
import { runTui, startWebUi } from "./ui.js";
import { parseCliArgs, type CliArgs } from "./cli-args.js";
import { runBatch } from "./batch.js";
import {
  isInteractive,
  renderExport,
  renderHealth,
  renderJobDetail,
  renderJobsTable,
  renderQueueTable,
} from "./formatting.js";

/** 需要 jobId 的子命令统一从位置参数取，缺失时给出明确用法提示而非 undefined 透传。 */
function requireJobId(parsed: CliArgs, command: string): string {
  const jobId = parsed.positionals[0];
  if (!jobId)
    throw new Error(`请提供任务 ID。用法：cbx ${command} <jobId> [选项]`);
  return jobId;
}

/** 扫描根目录下含 .cbx/ 的直接子目录(1 层深度,不递归)。返回绝对路径列表。 */
async function discoverWorkspaces(root: string): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const resolvedRoot = path.resolve(root);
  let names: string[];
  try {
    names = await readdir(resolvedRoot);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const candidate = path.join(resolvedRoot, name);
    let dirStat, cbxStat;
    try {
      dirStat = await stat(candidate);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    try {
      cbxStat = await stat(path.join(candidate, ".cbx"));
    } catch {
      continue;
    }
    if (cbxStat.isDirectory()) out.push(candidate);
  }
  return out;
}

/** 按 path.resolve 后的字符串去重,保留首次出现顺序。 */
function dedupWorkspaces(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}
function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const parsed = parseCliArgs(rest);
  const workspace = parsed.option("--workspace", ".")!;
  if (["run", "start"].includes(command)) {
    const fileConfig = await loadConfig(workspace);
    // 任务模板：--template <name> 从 .cbx.json templates 展开。
    // 优先级：命令行显式参数 > 模板值 > 配置文件默认值。
    const templateName = parsed.option("--template");
    const template = templateName
      ? fileConfig.templates?.[templateName]
      : undefined;
    if (templateName && !template) {
      const names = Object.keys(fileConfig.templates ?? {});
      throw new Error(
        `模板不存在：${templateName}${names.length ? `。可用：${names.join(", ")}` : "（未配置任何模板）"}`,
      );
    }
    let task = parsed.option("--task") ?? template?.task;
    const taskFile = parsed.option("--task-file");
    if (taskFile) task = await readFile(taskFile, "utf8");
    const defaults = mergeConfig(fileConfig, {
      testCommand: parsed.option("--test") ?? template?.test,
      review: parsed.has("--review")
        ? true
        : parsed.has("--no-review")
          ? false
          : template?.review,
      approvalBeforeComplete: parsed.has("--approval-before-complete")
        ? true
        : parsed.has("--no-approval-before-complete")
          ? false
          : undefined,
      isolated: parsed.has("--isolated")
        ? true
        : parsed.has("--no-isolated")
          ? false
          : template?.isolated,
      timeoutMs: parsed.intOption("--timeout-ms", undefined, { min: 100 }),
      maxRetries: parsed.intOption("--max-retries", undefined, { min: 0 }),
      maxTurns: parsed.intOption("--max-turns", undefined, { min: 1 }),
      keepWorktree: parsed.has("--keep-worktree")
        ? true
        : parsed.has("--no-keep-worktree")
          ? false
          : undefined,
      permissionMode: parsed.has("--dangerously-skip-permissions")
        ? "dontAsk"
        : parsed.option("--permission-mode"),
      executor: parsed.option("--executor") ?? template?.executor,
      reviewExecutor: parsed.option("--review-executor"),
      autoBranch: parsed.has("--auto-branch")
        ? true
        : parsed.has("--no-auto-branch")
          ? false
          : undefined,
      autoCommit: parsed.has("--auto-commit")
        ? true
        : parsed.has("--no-auto-commit")
          ? false
          : undefined,
      commitMessage: parsed.option("--commit-message"),
      trustMode: parsed.option("--trust-mode") as
        "trusted" | "untrusted" | undefined,
      dependencyGuard: parsed.has("--dependency-guard")
        ? true
        : parsed.has("--no-dependency-guard")
          ? false
          : undefined,
      adaptive: {
        enabled: parsed.has("--adaptive")
          ? true
          : parsed.has("--no-adaptive")
            ? false
            : undefined,
        maxRounds: parsed.intOption("--adaptive-max-rounds", undefined, {
          min: 1,
        }),
        managerExecutor: parsed.option("--manager-executor"),
      },
    });
    const existingJob = parsed.option("--job-id");
    let jobId = existingJob;
    if (!jobId) {
      if (!task) throw new Error("请提供 --task 或 --task-file。");
      const created = await createJob({
        workspace,
        task,
        testCommand: defaults.testCommand,
        review: defaults.review,
        isolated: defaults.isolated,
        permissionMode: defaults.permissionMode,
        maxTurns: defaults.maxTurns,
        timeoutMs: defaults.timeoutMs,
        maxRetries: defaults.maxRetries,
        keepWorktree: defaults.keepWorktree,
        reviewRules: fileConfig.reviewRules,
        approvalBeforeRun: defaults.approvalBeforeRun,
        approvalBeforeComplete: defaults.approvalBeforeComplete,
        autoBranch: defaults.autoBranch,
        autoCommit: defaults.autoCommit,
        commitMessage: defaults.commitMessage,
        executor: defaults.executor,
        reviewExecutor: defaults.reviewExecutor,
        adaptive: defaults.adaptive,
        trustMode: defaults.trustMode,
        allowUnsafePermissions: parsed.has("--dangerously-skip-permissions"),
      });
      jobId = created.jobId;
    }
    if (command === "start") {
      await startBackground(
        workspace,
        jobId!,
        parsed.option("--message", ""),
        parsed.intOption("--priority", 0),
      );
      print({ jobId, status: "queued" });
      return;
    }
    const queueEntryId = parsed.option("--queue-entry-id");
    const workerPidFile = queueEntryId
      ? path.join(jobDir(workspace, jobId!), "pid")
      : undefined;
    const heartbeatFile = queueEntryId
      ? path.join(jobDir(workspace, jobId!), "worker.heartbeat")
      : undefined;
    if (heartbeatFile)
      await writeFile(heartbeatFile, new Date().toISOString(), "utf8").catch(
        () => undefined,
      );
    const heartbeat = heartbeatFile
      ? setInterval(() => {
          void writeFile(heartbeatFile, new Date().toISOString(), "utf8").catch(
            () => undefined,
          );
        }, 10_000)
      : undefined;
    heartbeat?.unref();
    let result: Awaited<ReturnType<typeof executeJob>>;
    try {
      result = await executeJob(
        workspace,
        jobId!,
        parsed.option("--message", ""),
        queueEntryId,
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (heartbeatFile) await unlink(heartbeatFile).catch(() => undefined);
      if (workerPidFile) {
        const recordedPid = await readFile(workerPidFile, "utf8").catch(
          () => "",
        );
        if (Number(recordedPid) === process.pid)
          await unlink(workerPidFile).catch(() => undefined);
      }
    }
    print(result);
    if (parsed.has("--ci") && result.status !== "done") process.exit(2);
    return;
  }
  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp-server.js");
    runMcpServer();
    return;
  }
  if (command === "status") {
    const state = await loadState(workspace, requireJobId(parsed, command));
    if (isInteractive() && !parsed.has("--json"))
      console.log(renderJobDetail(state));
    else print(state);
    return;
  }
  if (command === "list") {
    const jobs = await listJobs(workspace);
    if (isInteractive() && !parsed.has("--json"))
      console.log(renderJobsTable(jobs));
    else print(jobs);
    return;
  }
  if (command === "queue") {
    const action = parsed.positionals[0];
    if (action === "pause") print(await pauseQueue(workspace));
    else if (action === "resume") print(await resumeQueue(workspace));
    else {
      const q = await listQueue(workspace);
      if (isInteractive() && !parsed.has("--json"))
        console.log(renderQueueTable(q));
      else print(q);
    }
    return;
  }
  if (command === "dispatch") {
    print(await dispatchQueue(workspace));
    return;
  }
  if (command === "health" || command === "metrics") {
    const h = await health(workspace);
    if (isInteractive() && !parsed.has("--json")) console.log(renderHealth(h));
    else print(h);
    return;
  }
  if (command === "serve") {
    const service = await serveQueue(
      workspace,
      parsed.intOption("--interval-ms", 30000, { min: 50 })!,
    );
    print({ workspace, status: "serving" });
    const signal = new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await Promise.race([signal, service.done]);
    await service.stop();
    return;
  }
  if (command === "logs") {
    console.log(
      await readArtifact(
        workspace,
        requireJobId(parsed, command),
        "events.ndjson",
      ),
    );
    return;
  }
  if (command === "files") {
    const jobId = requireJobId(parsed, command);
    try {
      print(JSON.parse(await readArtifact(workspace, jobId, "result.json")));
    } catch {
      console.log("任务尚无 result.json");
    }
    return;
  }
  if (command === "result") {
    console.log(
      await readArtifact(
        workspace,
        requireJobId(parsed, command),
        "result.json",
      ),
    );
    return;
  }
  if (command === "watch") {
    const jobId = requireJobId(parsed, command);
    const interval = parsed.intOption("--interval-ms", 1000, { min: 1 })!;
    let last = "";
    const useTable = isInteractive() && !parsed.has("--json");
    while (true) {
      const state = await loadState(workspace, jobId);
      const snapshot = JSON.stringify(state);
      if (snapshot !== last) {
        if (useTable) {
          process.stdout.write("\x1b[2J\x1b[H");
          console.log(renderJobDetail(state));
        } else {
          print(state);
        }
        last = snapshot;
      }
      if (
        ["done", "failed", "needs_fix", "review_failed", "cancelled"].includes(
          state.status,
        )
      ) {
        if (parsed.has("--ci") && state.status !== "done") process.exit(2);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  if (command === "ui") {
    // ui 支持多 workspace 模式:`--workspace` 可多次,或 `--workspaces-dir <dir>` 扫描根目录下所有含 .cbx/ 的子目录。
    // 显式列出的 workspace 优先,扫到的追加在后,去重保留首次出现顺序。
    const explicit = parsed.all("--workspace");
    const scanRoot = parsed.option("--workspaces-dir");
    const workspaces = dedupWorkspaces([
      ...explicit,
      ...(scanRoot ? await discoverWorkspaces(scanRoot) : []),
    ]);
    // token 优先级:CLI --ui-token > .cbx.json ui.token
    const cliToken = parsed.option("--ui-token");
    const configToken = (await loadConfig(workspace)).ui?.token;
    const uiToken = cliToken ?? configToken;
    if (workspaces.length === 0) {
      // 向后兼容:无显式参数时退化为 cwd 单 workspace,与旧版一致。
      await startWebUi(
        workspace,
        parsed.intOption("--port", 4173, { min: 1, max: 65535 })!,
        parsed.option("--host", "127.0.0.1"),
        uiToken,
      );
      return;
    }
    await startWebUi(
      workspaces,
      parsed.intOption("--port", 4173, { min: 1, max: 65535 })!,
      parsed.option("--host", "127.0.0.1"),
      uiToken,
    );
    return;
  }
  if (command === "tui") {
    await runTui(
      workspace,
      parsed.intOption("--interval-ms", 1000, { min: 1 })!,
    );
    return;
  }
  if (command === "review") {
    try {
      console.log(
        await readFile(
          `${jobDir(workspace, requireJobId(parsed, command))}/review.md`,
          "utf8",
        ),
      );
    } catch {
      console.log("尚无 review.md");
    }
    return;
  }
  if (command === "continue") {
    const jobId = requireJobId(parsed, command);
    const message = parsed.option(
      "--message",
      "请根据 review.md 修复问题，完成后重新运行验收命令。",
    )!;
    const extraRounds = parsed.intOption("--extra-rounds", 0, {
      min: 0,
      max: 100,
    });
    if (parsed.has("--foreground")) {
      await unlink(
        path.join(jobDir(workspace, jobId), "cancel.requested"),
      ).catch(() => undefined);
      print(
        await executeJob(workspace, jobId, message, undefined, extraRounds),
      );
      return;
    }
    await startBackground(
      workspace,
      jobId,
      message,
      parsed.intOption("--priority", 0),
      undefined,
      parsed.has("--refresh-baseline"),
      extraRounds,
    );
    print({ jobId, status: "queued" });
    return;
  }
  if (command === "cancel") {
    print(await cancelJob(workspace, requireJobId(parsed, command)));
    return;
  }
  if (command === "approve") {
    const jobId = requireJobId(parsed, command);
    const state = await approveJob(workspace, jobId);
    if (state.status === "queued") await startBackground(workspace, jobId);
    print(state);
    return;
  }
  if (command === "retry") {
    print(
      await retryQueueJob(
        workspace,
        requireJobId(parsed, command),
        parsed.intOption("--priority", 0),
      ),
    );
    return;
  }
  if (command === "clean") {
    const jobId = requireJobId(parsed, command);
    print({ jobId, cleaned: await cleanupWorktree(workspace, jobId) });
    return;
  }
  if (command === "export") {
    const jobId = requireJobId(parsed, command);
    const format = (parsed.option("--format") ?? "text") as "text" | "markdown";
    if (!["text", "markdown"].includes(format))
      throw new Error("--format 必须是 text 或 markdown。");
    const state = await loadState(workspace, jobId);
    let result: Record<string, unknown> | null = null;
    try {
      result = JSON.parse(await readArtifact(workspace, jobId, "result.json"));
    } catch {
      /* 无 result.json：输出基本状态 */
    }
    console.log(renderExport(state, result, format as "text" | "markdown"));
    return;
  }
  if (command === "batch") {
    if (parsed.option("--job-id"))
      throw new Error("batch 不支持 --job-id（每个任务独立生成 jobId）。");
    const tasks = parsed.all("--task");
    for (const file of parsed.all("--task-file"))
      tasks.push(await readFile(file, "utf8"));
    if (tasks.length === 0)
      throw new Error(
        "请至少提供一个任务：--task <描述> 或 --task-file <文件>。",
      );
    const fileConfig = await loadConfig(workspace);
    const defaults = mergeConfig(fileConfig, {
      testCommand: parsed.option("--test"),
      review: parsed.has("--review")
        ? true
        : parsed.has("--no-review")
          ? false
          : undefined,
      isolated: parsed.has("--isolated")
        ? true
        : parsed.has("--no-isolated")
          ? false
          : undefined,
      timeoutMs: parsed.intOption("--timeout-ms", undefined, { min: 100 }),
      maxRetries: parsed.intOption("--max-retries", undefined, { min: 0 }),
      maxTurns: parsed.intOption("--max-turns", undefined, { min: 1 }),
      keepWorktree: parsed.has("--keep-worktree")
        ? true
        : parsed.has("--no-keep-worktree")
          ? false
          : undefined,
      permissionMode: parsed.has("--dangerously-skip-permissions")
        ? "dontAsk"
        : parsed.option("--permission-mode"),
      executor: parsed.option("--executor"),
      reviewExecutor: parsed.option("--review-executor"),
      autoBranch: parsed.has("--auto-branch")
        ? true
        : parsed.has("--no-auto-branch")
          ? false
          : undefined,
      autoCommit: parsed.has("--auto-commit")
        ? true
        : parsed.has("--no-auto-commit")
          ? false
          : undefined,
      commitMessage: parsed.option("--commit-message"),
      trustMode: parsed.option("--trust-mode") as
        "trusted" | "untrusted" | undefined,
      dependencyGuard: parsed.has("--dependency-guard")
        ? true
        : parsed.has("--no-dependency-guard")
          ? false
          : undefined,
    });
    const maxBatch = parsed.intOption("--max-batch", 0, { min: 0 }) ?? 0;
    const wait = parsed.has("--wait");
    const waitTimeoutMs =
      parsed.intOption("--wait-timeout-ms", 30 * 60_000, { min: 1_000 }) ??
      30 * 60_000;
    const summary = await runBatch({
      workspace,
      tasks,
      maxBatch,
      wait,
      waitTimeoutMs,
      jobOptions: {
        testCommand: defaults.testCommand,
        review: defaults.review,
        isolated: defaults.isolated,
        permissionMode: defaults.permissionMode,
        maxTurns: defaults.maxTurns,
        timeoutMs: defaults.timeoutMs,
        maxRetries: defaults.maxRetries,
        keepWorktree: defaults.keepWorktree,
        approvalBeforeRun: defaults.approvalBeforeRun,
        approvalBeforeComplete: defaults.approvalBeforeComplete,
        autoBranch: defaults.autoBranch,
        autoCommit: defaults.autoCommit,
        commitMessage: defaults.commitMessage,
        executor: defaults.executor,
        reviewExecutor: defaults.reviewExecutor,
        trustMode: defaults.trustMode,
        dependencyGuard: defaults.dependencyGuard,
        allowUnsafePermissions: parsed.has("--dangerously-skip-permissions"),
      },
    });
    print(summary);
    // --wait 且存在未完成或失败 → 非零退出（CI 友好）。
    if (
      wait &&
      ((summary.unfinished?.length ?? 0) > 0 || (summary.failed ?? 0) > 0)
    )
      process.exit(2);
    return;
  }
  if (command === "review-gate") {
    const result = await runReviewGate(workspace, {
      executor: parsed.option("--executor"),
      timeoutMs: parsed.intOption("--timeout-ms", undefined, { min: 100 }),
    });
    print({
      pass: result.pass,
      reason: result.reason,
      verdict: result.verdict,
    });
    if (!result.pass) process.exit(2);
    return;
  }
  if (command === "stop-review-gate") {
    // Stop hook 入口：复用 stopReviewGateHook，保持「检查 reviewGate.enabled / 读 stdin 的 cwd / 输出 decision / 永不非 0 退出（fail-open）」契约。
    // 与原 dist/src/hooks/stop-review-gate.js 行为一致，避免从 GitHub 安装插件时 dist/ 缺失导致 hook 失效。
    const raw = await new Promise<string>((resolve) => {
      let data = "";
      if (process.stdin.isTTY) return resolve("");
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", () => resolve(""));
    });
    let input: { cwd?: string } = {};
    if (raw.trim()) {
      try {
        input = JSON.parse(raw) as { cwd?: string };
      } catch {
        /* 忽略非 JSON stdin */
      }
    }
    const hookWorkspace =
      input.cwd ?? process.env.CBX_WORKSPACE ?? process.cwd();
    const decision = await stopReviewGateHook(hookWorkspace);
    if (decision) process.stdout.write(JSON.stringify(decision) + "\n");
    return;
  }
  console.log(
    "用法：cbx run|start|batch|mcp|status|list|queue [pause|resume]|dispatch|serve|health|metrics|logs|files|result|export|review|continue|approve|retry|cancel|clean|watch|ui|tui|review-gate|stop-review-gate ...",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
