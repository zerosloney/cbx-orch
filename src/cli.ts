#!/usr/bin/env node
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { approveJob, cancelJob, cleanupWorktree, dispatchQueue, createJob, executeJob, health, jobDir, listJobs, listQueue, loadConfig, loadState, mergeConfig, pauseQueue, readArtifact, resumeQueue, retryQueueJob, serveQueue, startBackground } from "./core.js";
import { runReviewGate, stopReviewGateHook } from "./review-gate.js";
import { runTui, startWebUi } from "./ui.js";

function option(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function has(args: string[], name: string): boolean { return args.includes(name); }

/** 收集同一 flag 多次出现的值,用于 `cbx ui --workspace A --workspace B`。 */
function collectAll(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === name && i + 1 < args.length) values.push(args[i + 1]);
  return values;
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
  const [command, ...args] = process.argv.slice(2);
  const workspace = option(args, "--workspace", ".")!;
  if (["run", "start"].includes(command)) {
    let task = option(args, "--task");
    const taskFile = option(args, "--task-file");
    if (taskFile) task = await readFile(taskFile, "utf8");
    const fileConfig = await loadConfig(workspace);
    const defaults = mergeConfig(fileConfig, {
      testCommand: option(args, "--test"),
      review: has(args, "--review") ? true : has(args, "--no-review") ? false : undefined,
      isolated: has(args, "--isolated") ? true : has(args, "--no-isolated") ? false : undefined,
      timeoutMs: option(args, "--timeout-ms") ? Number(option(args, "--timeout-ms")) : undefined,
      maxRetries: option(args, "--max-retries") ? Number(option(args, "--max-retries")) : undefined,
      maxTurns: option(args, "--max-turns") ? Number(option(args, "--max-turns")) : undefined,
      keepWorktree: has(args, "--keep-worktree") ? true : has(args, "--no-keep-worktree") ? false : undefined,
      permissionMode: has(args, "--dangerously-skip-permissions") ? "dontAsk" : option(args, "--permission-mode"),
      executor: option(args, "--executor"),
      reviewExecutor: option(args, "--review-executor"),
      autoBranch: has(args, "--auto-branch") ? true : has(args, "--no-auto-branch") ? false : undefined,
      autoCommit: has(args, "--auto-commit") ? true : has(args, "--no-auto-commit") ? false : undefined,
      commitMessage: option(args, "--commit-message"),
      trustMode: option(args, "--trust-mode") as "trusted" | "untrusted" | undefined,
    });
    const existingJob = option(args, "--job-id");
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
        autoBranch: defaults.autoBranch,
        autoCommit: defaults.autoCommit,
        commitMessage: defaults.commitMessage,
        executor: defaults.executor,
        reviewExecutor: defaults.reviewExecutor,
        trustMode: defaults.trustMode,
        allowUnsafePermissions: has(args, "--dangerously-skip-permissions"),
      });
      jobId = created.jobId;
    }
    if (command === "start") {
      await startBackground(workspace, jobId!, option(args, "--message", ""), Number(option(args, "--priority", "0")));
      print({ jobId, status: "queued" });
      return;
    }
    const queueEntryId = option(args, "--queue-entry-id");
    const workerPidFile = queueEntryId ? path.join(jobDir(workspace, jobId!), "pid") : undefined;
    const heartbeatFile = queueEntryId ? path.join(jobDir(workspace, jobId!), "worker.heartbeat") : undefined;
    if (heartbeatFile) await writeFile(heartbeatFile, new Date().toISOString(), "utf8").catch(() => undefined);
    const heartbeat = heartbeatFile ? setInterval(() => { void writeFile(heartbeatFile, new Date().toISOString(), "utf8").catch(() => undefined); }, 10_000) : undefined;
    heartbeat?.unref();
    let result: Awaited<ReturnType<typeof executeJob>>;
    try { result = await executeJob(workspace, jobId!, option(args, "--message", ""), queueEntryId); }
    finally {
      if (heartbeat) clearInterval(heartbeat);
      if (heartbeatFile) await unlink(heartbeatFile).catch(() => undefined);
      if (workerPidFile) {
        const recordedPid = await readFile(workerPidFile, "utf8").catch(() => "");
        if (Number(recordedPid) === process.pid) await unlink(workerPidFile).catch(() => undefined);
      }
    }
    print(result);
    if (has(args, "--ci") && result.status !== "done") process.exitCode = 2;
    return;
  }
  if (command === "mcp") { const { runMcpServer } = await import("./mcp-server.js"); runMcpServer(); return; }
  if (command === "status") { print(await loadState(workspace, args[0])); return; }
  if (command === "list") { print(await listJobs(workspace)); return; }
  if (command === "queue") {
    const action = args.find(value => !value.startsWith("--") && value !== workspace);
    if (action === "pause") print(await pauseQueue(workspace));
    else if (action === "resume") print(await resumeQueue(workspace));
    else print(await listQueue(workspace));
    return;
  }
  if (command === "dispatch") { print(await dispatchQueue(workspace)); return; }
  if (command === "health" || command === "metrics") { print(await health(workspace)); return; }
  if (command === "serve") {
    const service = await serveQueue(workspace, Number(option(args, "--interval-ms", "30000")));
    print({ workspace, status: "serving" });
    const signal = new Promise<void>(resolve => {
      process.once("SIGINT", () => resolve()); process.once("SIGTERM", () => resolve());
    });
    await Promise.race([signal, service.done]);
    await service.stop();
    return;
  }
  if (command === "logs") { console.log(await readArtifact(workspace, args[0], "events.ndjson")); return; }
  if (command === "files") {
    try { print(JSON.parse(await readArtifact(workspace, args[0], "result.json"))); }
    catch { console.log("任务尚无 result.json"); }
    return;
  }
  if (command === "result") { console.log(await readArtifact(workspace, args[0], "result.json")); return; }
  if (command === "watch") {
    const interval = Number(option(args, "--interval-ms", "1000"));
    let last = "";
    while (true) {
      const state = await loadState(workspace, args[0]);
      const snapshot = JSON.stringify(state);
      if (snapshot !== last) { print(state); last = snapshot; }
      if (["done", "failed", "needs_fix", "review_failed", "cancelled"].includes(state.status)) {
        if (has(args, "--ci") && state.status !== "done") process.exitCode = 2;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }
  if (command === "ui") {
    // ui 支持多 workspace 模式:`--workspace` 可多次,或 `--workspaces-dir <dir>` 扫描根目录下所有含 .cbx/ 的子目录。
    // 显式列出的 workspace 优先,扫到的追加在后,去重保留首次出现顺序。
    const explicit = collectAll(args, "--workspace");
    const scanRoot = option(args, "--workspaces-dir");
    const workspaces = dedupWorkspaces([...explicit, ...(scanRoot ? await discoverWorkspaces(scanRoot) : [])]);
    if (workspaces.length === 0) {
      // 向后兼容:无显式参数时退化为 cwd 单 workspace,与旧版一致。
      await startWebUi(workspace, Number(option(args, "--port", "4173")), option(args, "--host", "127.0.0.1"));
      return;
    }
    await startWebUi(workspaces, Number(option(args, "--port", "4173")), option(args, "--host", "127.0.0.1"));
    return;
  }
  if (command === "tui") { await runTui(workspace, Number(option(args, "--interval-ms", "1000"))); return; }
  if (command === "review") {
    try { console.log(await readFile(`${jobDir(workspace, args[0])}/review.md`, "utf8")); }
    catch { console.log("尚无 review.md"); }
    return;
  }
  if (command === "continue") {
    const message = option(args, "--message", "请根据 review.md 修复问题，完成后重新运行验收命令。")!;
    if (has(args, "--foreground")) {
      await unlink(path.join(jobDir(workspace, args[0]), "cancel.requested")).catch(() => undefined);
      print(await executeJob(workspace, args[0], message));
      return;
    }
    await startBackground(workspace, args[0], message, Number(option(args, "--priority", "0")), undefined, has(args, "--refresh-baseline"));
    print({ jobId: args[0], status: "queued" });
    return;
  }
  if (command === "cancel") { print(await cancelJob(workspace, args[0])); return; }
  if (command === "approve") {
    const state = await approveJob(workspace, args[0]);
    await startBackground(workspace, args[0]);
    print(state);
    return;
  }
  if (command === "retry") { print(await retryQueueJob(workspace, args[0], Number(option(args, "--priority", "0")))); return; }
  if (command === "clean") { print({ jobId: args[0], cleaned: await cleanupWorktree(workspace, args[0]) }); return; }
  if (command === "review-gate") {
    const result = await runReviewGate(workspace, { executor: option(args, "--executor"), timeoutMs: option(args, "--timeout-ms") ? Number(option(args, "--timeout-ms")) : undefined });
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
