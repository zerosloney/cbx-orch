#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { approveJob, cancelJob, cleanupWorktree, dispatchQueue, createJob, executeJob, health, jobDir, listJobs, listQueue, loadConfig, loadState, mergeConfig, pauseQueue, readArtifact, resumeQueue, retryQueueJob, serveQueue, startBackground } from "./core.js";
import { runReviewGate } from "./review-gate.js";
import { runTui, startWebUi } from "./ui.js";

function option(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function has(args: string[], name: string): boolean { return args.includes(name); }
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
    const result = await executeJob(workspace, jobId!, option(args, "--message", ""), queueEntryId);
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
    await new Promise<void>(resolve => {
      const stop = () => { void service.stop().finally(resolve); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
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
  if (command === "ui") { await startWebUi(workspace, Number(option(args, "--port", "4173")), option(args, "--host", "127.0.0.1")); return; }
  if (command === "tui") { await runTui(workspace, Number(option(args, "--interval-ms", "1000"))); return; }
  if (command === "review") {
    try { console.log(await readFile(`${jobDir(workspace, args[0])}/review.md`, "utf8")); }
    catch { console.log("尚无 review.md"); }
    return;
  }
  if (command === "continue") {
    const message = option(args, "--message", "请根据 review.md 修复问题，完成后重新运行验收命令。")!;
    if (has(args, "--foreground")) {
      print(await executeJob(workspace, args[0], message));
      return;
    }
    await startBackground(workspace, args[0], message, Number(option(args, "--priority", "0")));
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
  console.log("用法：cbx run|start|mcp|status|list|queue [pause|resume]|dispatch|serve|health|metrics|logs|files|result|review|continue|approve|retry|cancel|clean|watch|ui|tui|review-gate ...");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
