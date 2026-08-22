#!/usr/bin/env node
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  approveJobAndStart,
  cancelJob,
  cleanupWorktree,
  removeOrphanWorktrees,
  scanOrphanWorktrees,
  dispatchQueue,
  createJob,
  executeJob,
  forgetJobKeepWorktree,
  health,
  jobDir,
  listArtifacts,
  listJobs,
  listQueue,
  loadConfig,
  loadState,
  mergeConfig,
  pauseQueue,
  purgeJob,
  readArtifact,
  resumeQueue,
  retryQueueJob,
  serveQueue,
  startBackground,
  discoverWorkspaces,
  dedupWorkspaces,
} from "./core.js";
import { runReviewGate, stopReviewGateHook } from "./review-gate.js";
import { runTui, startWebUi, summarizeWorkspace } from "./ui.js";
import { parseCliArgs, type CliArgs } from "./cli-args.js";
import { runBatch } from "./batch.js";
import { discoverAgents } from "./agent-registry.js";
import { collectExecutorStats } from "./executors/stats.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { APP_VERSION } from "./version.js";
import {
  parseExecutionProfile,
  type ExecutionProfile,
} from "./profile.js";
import type { RoutingStrategy } from "./executors/route.js";
import {
  isInteractive,
  renderAgentsTable,
  renderExport,
  renderHealth,
  renderJobDetail,
  renderJobsTable,
  renderQueueTable,
  renderWorkspacesTable,
} from "./formatting.js";

/** 需要 jobId 的子命令统一从位置参数取，缺失时给出明确用法提示而非 undefined 透传。 */
function requireJobId(parsed: CliArgs, command: string): string {
  const jobId = parsed.positionals[0];
  if (!jobId)
    throw new Error(`请提供任务 ID。用法：cbx ${command} <jobId> [选项]`);
  return jobId;
}


/** 解析跨 workspace 查询的 workspace 集合：显式 --workspace（可重复）> --workspaces-dir 扫描 > 默认 "."。 */
async function resolveWorkspaces(parsed: CliArgs): Promise<string[]> {
  const explicit = parsed.all("--workspace");
  const scanRoot = parsed.option("--workspaces-dir");
  const scanned = scanRoot ? await discoverWorkspaces(scanRoot) : [];
  const all = explicit.length ? explicit : scanned.length ? scanned : ["."];
  return dedupWorkspaces(all);
}
function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** --profile 在 CLI 参数解析器纳入该值选项前，保持 `--profile value` 与 `--profile=value` 一致。 */
function parseProfileOption(argv: string[]): ExecutionProfile | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") break;
    if (arg === "--profile") {
      const value = argv[index + 1];
      if (value === undefined || value === "--")
        throw new Error("选项 --profile 缺少值。");
      return parseExecutionProfile(value);
    }
    if (arg.startsWith("--profile="))
      return parseExecutionProfile(arg.slice("--profile=".length));
  }
  return undefined;
}

const USAGE = `用法：cbx run|start|batch|doctor|templates|ws|mcp|status|list|queue [pause|resume]|dispatch|serve|health|metrics|logs|files|result|export|review|continue|approve|retry|cancel|clean|forget|purge|watch|ui|tui|review-gate|stop-review-gate ...
选项：--help 显示本帮助；--version / -v 显示版本；--profile fast|verified|governed|untrusted 设置执行档位；--routing-strategy best|cheapest|fastest 设置 auto 路由策略；--model <name> 选择 harness 内模型（spec 需声明 modelArg）。`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(APP_VERSION);
    return;
  }
  const parsed = parseCliArgs(rest);
  const workspace = parsed.option("--workspace", ".")!;
  if (command === "doctor") {
    const report = await runDoctor(workspace);
    if (parsed.has("--json")) print(report);
    else console.log(renderDoctor(report));
    if (report.status === "fail") process.exit(1);
    return;
  }
  if (command === "templates") {
    const fileConfig = await loadConfig(workspace);
    const templates = Object.entries(fileConfig.templates ?? {}).map(
      ([name, template]) => ({ name, ...template }),
    );
    if (parsed.has("--json")) {
      print({ templates });
      return;
    }
    if (templates.length === 0) {
      console.log("暂无任务模板");
      return;
    }
    for (const template of templates) {
      const summary = template.task.replace(/\s+/g, " ").trim();
      const task = summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
      console.log(
        `${template.name}  profile=${template.profile ?? "—"}  strategy=${template.routingStrategy ?? "best"}`,
      );
      console.log(`  task: ${task}`);
    }
    return;
  }
  if (["run", "start"].includes(command)) {
    const cliProfile = parseProfileOption(rest);
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
      profile: cliProfile ?? template?.profile,
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
      routingStrategy:
        (parsed.option("--routing-strategy") as RoutingStrategy | undefined) ??
        template?.routingStrategy,
      model: parsed.option("--model"),
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
      if (typeof task !== "string" || !task.trim())
        throw new Error("请提供非空的 --task 或 --task-file。");
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
        routingStrategy: defaults.routingStrategy,
        model: defaults.model,
        adaptive: defaults.adaptive,
        trustMode: defaults.trustMode,
        profile: defaults.profile,
        dependencyGuard: defaults.dependencyGuard,
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
    if (parsed.has("--http")) {
      // streamable HTTP 模式（协议 2025-06-18）：`cbx mcp --http [--port] [--host] [--token]`。
      const { runMcpHttpServer } = await import("./mcp-server.js");
      // token 优先级：CLI --token > .cbx.json ui.token（与 ui 命令同源）。
      const cliToken = parsed.option("--token");
      const configToken = (await loadConfig(workspace)).ui?.token;
      await runMcpHttpServer({
        port: parsed.intOption("--port", 8931, { min: 1, max: 65535 })!,
        host: parsed.option("--host", "127.0.0.1")!,
        token: cliToken ?? configToken,
      });
    } else {
      const { runMcpServer } = await import("./mcp-server.js");
      runMcpServer();
    }
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
    // --limit N：只列最近 N 条（updated_at 倒序），控制大 workspace 下的输出规模。
    const limit = parsed.intOption("--limit", undefined, {
      min: 1,
      max: 10000,
    });
    const listOpts = limit === undefined ? undefined : { limit };
    if (parsed.has("--all")) {
      // 跨 workspace 列出任务，每行带 workspace 前缀。
      const workspaces = await resolveWorkspaces(parsed);
      const all = await Promise.all(
        workspaces.map(async (ws) => ({
          ws,
          jobs: await listJobs(ws, listOpts).catch(() => []),
        })),
      );
      const combined = all.flatMap(({ ws, jobs }) =>
        jobs.map((j) => ({
          ...j,
          jobId: `[${path.basename(ws) || ws}] ${j.jobId}`,
        })),
      );
      if (isInteractive() && !parsed.has("--json"))
        console.log(renderJobsTable(combined));
      else print(combined);
      return;
    }
    const jobs = await listJobs(workspace, listOpts);
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
  if (command === "agents") {
    const { probes, errors } = await discoverAgents(workspace);
    const stats = await collectExecutorStats(workspace);
    if (isInteractive() && !parsed.has("--json"))
      console.log(renderAgentsTable(probes, errors, stats));
    else
      print({
        agents: probes.map((p) => ({ ...p, stats: stats.get(p.name) ?? null })),
        errors,
      });
    return;
  }
  if (command === "dispatch") {
    print(await dispatchQueue(workspace));
    return;
  }
  if (command === "health" || command === "metrics") {
    if (parsed.has("--all")) {
      const workspaces = await resolveWorkspaces(parsed);
      const results = await Promise.all(
        workspaces.map(async (ws) => ({
          workspace: ws,
          ...(await health(ws).catch((error) => ({
            status: "error",
            metrics: {},
            error: error instanceof Error ? error.message : String(error),
          }))),
        })),
      );
      print({ workspaces: results });
      return;
    }
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
    // 列出任务的可用 artifact（含动态发现的 stage-*-handback.md 副本），
    // 与 Web UI `/api/jobs/:id/artifacts` 同一实现；读内容请用 `cbx result`/`cbx review`/`cbx logs`。
    print(await listArtifacts(workspace, requireJobId(parsed, command)));
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        console.log("尚无 review.md");
        return;
      }
      throw error;
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
    const state = await approveJobAndStart(workspace, jobId);
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
    if (parsed.has("--orphans")) {
      // 巡检并清理孤儿 worktree（job 已被清理而 worktree 遗留）；只删无 jobDir 的条目。
      const orphans = await scanOrphanWorktrees(workspace);
      if (orphans.length === 0) {
        print({ orphans: 0, removed: [], failed: [] });
        return;
      }
      const { removed, failed } = await removeOrphanWorktrees(workspace, orphans);
      print({ orphans: orphans.length, removed, failed });
      return;
    }
    const jobId = requireJobId(parsed, command);
    print({ jobId, cleaned: await cleanupWorktree(workspace, jobId) });
    return;
  }
  if (command === "forget" || command === "purge") {
    const jobId = requireJobId(parsed, command);
    const reason = parsed.option("--reason");
    if (command === "purge") {
      // purge 是不可逆操作（连 worktree 一起删）：默认要求 --yes 显式确认。
      // 脚本/CI 可走 CBX_YES=1 环境变量绕过；与现有 dangerous 操作保持一致。
      if (!parsed.has("--yes") && !process.env.CBX_YES)
        throw new Error(
          `purge 会删除 worktree + state + 全部工件，不可恢复。请用 \`cbx purge ${jobId} --yes\` 确认，或设置 CBX_YES=1。`,
        );
      print(
        await purgeJob(
          workspace,
          jobId,
          reason ?? "cli:cbx purge",
        ),
      );
      return;
    }
    // forget 默认也要确认：state.json + events.ndjson + 全部工件都没了，重建无门。
    if (!parsed.has("--yes") && !process.env.CBX_YES)
      throw new Error(
        `forget 会删除 state.json / events.ndjson / 全部工件（保留 worktree）。请用 \`cbx forget ${jobId} --yes\` 确认，或设置 CBX_YES=1。`,
      );
    print(
      await forgetJobKeepWorktree(
        workspace,
        jobId,
        reason ?? "cli:cbx forget",
      ),
    );
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
    // 关键工件（test.log / review.md / complete.patch）— 任意缺失均不影响整体输出，
    // 渲染端按字段存在与否决定是否绘制对应段落。
    const tryRead = async (name: string): Promise<string | undefined> => {
      try {
        return await readArtifact(workspace, jobId, name);
      } catch {
        return undefined;
      }
    };
    const [testLog, review, completePatch] = await Promise.all([
      tryRead("test.log"),
      tryRead("review.md"),
      tryRead("complete.patch"),
    ]);
    if (result) {
      if (testLog) result.testLog = testLog;
      if (review) result.review = review;
      if (completePatch) result.completePatch = completePatch;
    } else if (testLog || review || completePatch) {
      // 无 result.json 但工件存在：构造最小 result 保留 handback-like 字段
      result = { testLog, review, completePatch } as Record<string, unknown>;
    }
    console.log(renderExport(state, result, format as "text" | "markdown"));
    return;
  }
  if (command === "ws") {
    const workspaces = await resolveWorkspaces(parsed);
    const summaries = await Promise.all(
      workspaces.map((ws) =>
        summarizeWorkspace(ws).catch((error) => ({
          path: ws,
          name: path.basename(ws) || ws,
          jobsByStatus: {},
          queueDepth: 0,
          paused: false,
          activeExecutors: 0,
          lastActivityAt: null,
          gitBranch: null,
          gitDirty: null,
          error: error instanceof Error ? error.message : String(error),
        })),
      ),
    );
    const payload = { workspaces: summaries, default: workspaces[0] ?? "." };
    if (!isInteractive() || parsed.has("--json")) return print(payload);
    console.log(renderWorkspacesTable(summaries));
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
    const profile = parseProfileOption(rest);
    const fileConfig = await loadConfig(workspace);
    const defaults = mergeConfig(fileConfig, {
      profile,
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
        profile: defaults.profile,
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
  console.log(USAGE);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
