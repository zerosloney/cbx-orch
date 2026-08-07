#!/usr/bin/env node
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { approveJob, cancelJob, cleanupWorktree, dispatchQueue, createJob, executeJob, health, jobDir, listJobs, listQueue, loadConfig, loadState, mergeConfig, pauseQueue, readArtifact, resumeQueue, retryQueueJob, serveQueue, startBackground } from "./core.js";
import { runReviewGate, stopReviewGateHook } from "./review-gate.js";
import { runTui, startWebUi } from "./ui.js";
import { parseCliArgs, type CliArgs } from "./cli-args.js";

/** 需要 jobId 的子命令统一从位置参数取，缺失时给出明确用法提示而非 undefined 透传。 */
function requireJobId(parsed: CliArgs, command: string): string {
  const jobId = parsed.positionals[0];
  if (!jobId) throw new Error(`请提供任务 ID。用法：cbx ${command} <jobId> [选项]`);
  return jobId;
}

/** 扫描根目录下含 .cbx/ 的直接子目录(1 层深度,不递归)。返回绝对路径列表。 */
async function discoverWorkspaces(root: string): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const resolvedRoot = path.resolve(root);
  let names: string[];
  try { names = await readdir(resolvedRoot); }
  catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const candidate = path.join(resolvedRoot, name);
    let dirStat, cbxStat;
    try { dirStat = await stat(candidate); } catch { continue; }
    if (!dirStat.isDirectory()) continue;
    try { cbxStat = await stat(path.join(candidate, ".cbx")); } catch { continue; }
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
function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const parsed = parseCliArgs(rest);
  const workspace = parsed.option("--workspace", ".")!;
  if (["run", "start"].includes(command)) {
    let task = parsed.option("--task");
    const taskFile = parsed.option("--task-file");
    if (taskFile) task = await readFile(taskFile, "utf8");
    const fileConfig = await loadConfig(workspace);
    const defaults = mergeConfig(fileConfig, {
      testCommand: parsed.option("--test"),
      review: parsed.has("--review") ? true : parsed.has("--no-review") ? false : undefined,
      approvalBeforeComplete: parsed.has("--approval-before-complete") ? true : parsed.has("--no-approval-before-complete") ? false : undefined,
      isolated: parsed.has("--isolated") ? true : parsed.has("--no-isolated") ? false : undefined,
      timeoutMs: parsed.option("--timeout-ms") ? Number(parsed.option("--timeout-ms")) : undefined,
      maxRetries: parsed.option("--max-retries") ? Number(parsed.option("--max-retries")) : undefined,
      maxTurns: parsed.option("--max-turns") ? Number(parsed.option("--max-turns")) : undefined,
      keepWorktree: parsed.has("--keep-worktree") ? true : parsed.has("--no-keep-worktree") ? false : undefined,
      permissionMode: parsed.has("--dangerously-skip-permissions") ? "dontAsk" : parsed.option("--permission-mode"),
      executor: parsed.option("--executor"),
      reviewExecutor: parsed.option("--review-executor"),
      autoBranch: parsed.has("--auto-branch") ? true : parsed.has("--no-auto-branch") ? false : undefined,
      autoCommit: parsed.has("--auto-commit") ? true : parsed.has("--no-auto-commit") ? false : undefined,
      commitMessage: parsed.option("--commit-message"),
      trustMode: parsed.option("--trust-mode") as "trusted" | "untrusted" | undefined,
      dependencyGuard: parsed.has("--dependency-guard") ? true : parsed.has("--no-dependency-guard") ? false : undefined,
      adaptive: {
        enabled: parsed.has("--adaptive") ? true : parsed.has("--no-adaptive") ? false : undefined,
        maxRounds: parsed.option("--adaptive-max-rounds") ? Number(parsed.option("--adaptive-max-rounds")) : undefined,
        managerExecutor: parsed.option("--manager-executor"),
      },
    });
    const existingJob = parsed.option("--job-id");
    let jobId = existingJob;
    if (!jobId) {
      if (!task) throw new Error("请提供 --task 或 --task-file。");
      const created = await createJob({
        workspace, task, testCommand: defaults.testCommand, review: defaults.review, isolated: defaults.isolated,
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
      await startBackground(workspace, jobId!, parsed.option("--message", ""), Number(parsed.option("--priority", "0")));
      print({ jobId, status: "queued" });
      return;
    }
    const queueEntryId = parsed.option("--queue-entry-id");
    const workerPidFile = queueEntryId ? path.join(jobDir(workspace, jobId!), "pid") : undefined;
    const heartbeatFile = queueEntryId ? path.join(jobDir(workspace, jobId!), "worker.heartbeat") : undefined;
    if (heartbeatFile) await writeFile(heartbeatFile, new Date().toISOString(), "utf8").catch(() => undefined);
    const heartbeat = heartbeatFile ? setInterval(() => { void writeFile(heartbeatFile, new Date().toISOString(), "utf8").catch(() => undefined); }, 10_000) : undefined;
    heartbeat?.unref();
    let result: Awaited<ReturnType<typeof executeJob>>;
    try { result = await executeJob(workspace, jobId!, parsed.option("--message", ""), queueEntryId); }
    finally {
      if (heartbeat) clearInterval(heartbeat);
      if (heartbeatFile) await unlink(heartbeatFile).catch(() => undefined);
      if (workerPidFile) {
        const recordedPid = await readFile(workerPidFile, "utf8").catch(() => "");
        if (Number(recordedPid) === process.pid) await unlink(workerPidFile).catch(() => undefined);
      }
    }
    print(result);
    if (parsed.has("--ci") && result.status !== "done") process.exitCode = 2;
    return;
  }
  if (command === "mcp") { const { runMcpServer } = await import("./mcp-server.js"); runMcpServer(); return; }
  if (command === "status") { print(await loadState(workspace, requireJobId(parsed, command))); return; }
  if (command === "list") { print(await listJobs(workspace)); return; }
  if (command === "queue") {
    const action = parsed.positionals[0];
    if (action === "pause") print(await pauseQueue(workspace));
    else if (action === "resume") print(await resumeQueue(workspace));
    else print(await listQueue(workspace));
    return;
  }
  if (command === "dispatch") { print(await dispatchQueue(workspace)); return; }
  if (command === "health" || command === "metrics") { print(await health(workspace)); return; }
  if (command === "serve") {
    const service = await serveQueue(workspace, Number(parsed.option("--interval-ms", "30000")));
    print({ workspace, status: "serving" });
    const signal = new Promise<void>(resolve => {
      process.once("SIGINT", () => resolve()); process.once("SIGTERM", () => resolve());
    });
    await Promise.race([signal, service.done]);
    await service.stop();
    return;
  }
  if (command === "logs") { console.log(await readArtifact(workspace, requireJobId(parsed, command), "events.ndjson")); return; }
  if (command === "files") {
    const jobId = requireJobId(parsed, command);
    try { print(JSON.parse(await readArtifact(workspace, jobId, "result.json"))); }
    catch { console.log("任务尚无 result.json"); }
    return;
  }
  if (command === "result") { console.log(await readArtifact(workspace, requireJobId(parsed, command), "result.json")); return; }
  if (command === "watch") {
    const jobId = requireJobId(parsed, command);
    const interval = Number(parsed.option("--interval-ms", "1000"));
    let last = "";
    while (true) {
      const state = await loadState(workspace, jobId);
      const snapshot = JSON.stringify(state);
      if (snapshot !== last) { print(state); last = snapshot; }
      if (["done", "failed", "needs_fix", "review_failed", "cancelled"].includes(state.status)) {
        if (parsed.has("--ci") && state.status !== "done") process.exitCode = 2;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }
  if (command === "ui") {
    // ui 支持多 workspace 模式:`--workspace` 可多次,或 `--workspaces-dir <dir>` 扫描根目录下所有含 .cbx/ 的子目录。
    // 显式列出的 workspace 优先,扫到的追加在后,去重保留首次出现顺序。
    const explicit = parsed.all("--workspace");
    const scanRoot = parsed.option("--workspaces-dir");
    const workspaces = dedupWorkspaces([...explicit, ...(scanRoot ? await discoverWorkspaces(scanRoot) : [])]);
    // token 优先级:CLI --ui-token > .cbx.json ui.token
    const cliToken = parsed.option("--ui-token");
    const configToken = (await loadConfig(workspace)).ui?.token;
    const uiToken = cliToken ?? configToken;
    if (workspaces.length === 0) {
      // 向后兼容:无显式参数时退化为 cwd 单 workspace,与旧版一致。
      await startWebUi(workspace, Number(parsed.option("--port", "4173")), parsed.option("--host", "127.0.0.1"), uiToken);
      return;
    }
    await startWebUi(workspaces, Number(parsed.option("--port", "4173")), parsed.option("--host", "127.0.0.1"), uiToken);
    return;
  }
  if (command === "tui") { await runTui(workspace, Number(parsed.option("--interval-ms", "1000"))); return; }
  if (command === "review") {
    try { console.log(await readFile(`${jobDir(workspace, requireJobId(parsed, command))}/review.md`, "utf8")); }
    catch { console.log("尚无 review.md"); }
    return;
  }
  if (command === "continue") {
    const jobId = requireJobId(parsed, command);
    const message = parsed.option("--message", "请根据 review.md 修复问题，完成后重新运行验收命令。")!;
    const extraRoundsOption = parsed.option("--extra-rounds");
    const extraRounds = extraRoundsOption === undefined ? 0 : Number(extraRoundsOption);
    if (extraRoundsOption !== undefined && (!Number.isInteger(extraRounds) || extraRounds < 1 || extraRounds > 100)) throw new Error("--extra-rounds 必须是 1 到 100 的整数。");
    if (parsed.has("--foreground")) {
      await unlink(path.join(jobDir(workspace, jobId), "cancel.requested")).catch(() => undefined);
      print(await executeJob(workspace, jobId, message, undefined, extraRounds));
      return;
    }
    await startBackground(workspace, jobId, message, Number(parsed.option("--priority", "0")), undefined, parsed.has("--refresh-baseline"), extraRounds);
    print({ jobId, status: "queued" });
    return;
  }
  if (command === "cancel") { print(await cancelJob(workspace, requireJobId(parsed, command))); return; }
  if (command === "approve") {
    const jobId = requireJobId(parsed, command);
    const state = await approveJob(workspace, jobId);
    if (state.status === "queued") await startBackground(workspace, jobId);
    print(state);
    return;
  }
  if (command === "retry") { print(await retryQueueJob(workspace, requireJobId(parsed, command), Number(parsed.option("--priority", "0")))); return; }
  if (command === "clean") { const jobId = requireJobId(parsed, command); print({ jobId, cleaned: await cleanupWorktree(workspace, jobId) }); return; }
  if (command === "review-gate") {
    const result = await runReviewGate(workspace, { executor: parsed.option("--executor"), timeoutMs: parsed.option("--timeout-ms") ? Number(parsed.option("--timeout-ms")) : undefined });
    print({ pass: result.pass, reason: result.reason, verdict: result.verdict });
    if (!result.pass) process.exitCode = 2;
    return;
  }
  if (command === "stop-review-gate") {
    // Stop hook 入口：复用 stopReviewGateHook，保持「检查 reviewGate.enabled / 读 stdin 的 cwd / 输出 decision / 永不非 0 退出（fail-open）」契约。
    // 与原 dist/src/hooks/stop-review-gate.js 行为一致，避免从 GitHub 安装插件时 dist/ 缺失导致 hook 失效。
    const raw = await new Promise<string>(resolve => {
      let data = "";
      if (process.stdin.isTTY) return resolve("");
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { data += chunk; });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", () => resolve(""));
    });
    let input: { cwd?: string } = {};
    if (raw.trim()) { try { input = JSON.parse(raw) as { cwd?: string }; } catch { /* 忽略非 JSON stdin */ } }
    const hookWorkspace = input.cwd ?? process.env.CBX_WORKSPACE ?? process.cwd();
    const decision = await stopReviewGateHook(hookWorkspace);
    if (decision) process.stdout.write(JSON.stringify(decision) + "\n");
    return;
  }
  console.log("用法：cbx run|start|mcp|status|list|queue [pause|resume]|dispatch|serve|health|metrics|logs|files|result|review|continue|approve|retry|cancel|clean|watch|ui|tui|review-gate|stop-review-gate ...");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
