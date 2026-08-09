import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  approveJob,
  cancelJob,
  createJob,
  executeJob,
  health,
  listJobs,
  listQueue,
  loadConfig,
  loadState,
  mergeConfig,
  pauseQueue,
  readArtifact,
  readEventsIncremental,
  resumeQueue,
  retryQueueJob,
  serveQueue,
  startBackground,
  type JobState,
} from "../src/core.js";
import { runReviewGate, stopReviewGateHook } from "../src/review-gate.js";
import {
  acquireServiceLease,
  loadPersistedQueue,
  loadPersistedState,
  savePersistedStateAndQueue,
} from "../src/storage.js";
import {
  BUILTIN_EXECUTORS,
  resolveExecutor,
} from "../src/executors/builtin.js";
import { parseNextAction } from "../src/adaptive-manager.js";
import {
  CONTEXT_PACK_MAX_CHARS,
  parseContextPack,
} from "../src/context-pack.js";
import {
  createHumanGate,
  extendRoundLimit,
  parseHumanGate,
  resolveHumanGate,
} from "../src/human-gate.js";

export const fakeAgent = `
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const prompt = args.find(value => value.includes("执行代理")) ?? args.at(-1) ?? "";
const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? 0);
if (sleepMs) await new Promise(resolve => setTimeout(resolve, sleepMs));
const jobDir = process.env.FAKE_JOB_DIR;
const promptFile = process.env.FAKE_PROMPT_FILE;
if (promptFile) await appendFile(promptFile, prompt + "\\n---\\n");
if (jobDir) {
  await mkdir(jobDir, { recursive: true });
  if (prompt.includes("adaptive manager")) {
    const candidate = prompt.match(/写入 (.+?manager-decision-candidate\\.json)/)?.[1];
    const actions = (process.env.FAKE_MANAGER_ACTIONS ?? "execute,done").split(",");
    const counterFile = process.env.FAKE_MANAGER_COUNTER_FILE ?? (jobDir + "/manager-counter.txt");
    let managerIndex = 0;
    try { managerIndex = Number(await (await import("node:fs/promises")).readFile(counterFile, "utf8")); } catch {}
    await writeFile(counterFile, String(managerIndex + 1));
    const action = actions[Math.min(managerIndex, actions.length - 1)];
    if (action === "mutate") await writeFile(process.cwd() + "/manager-change.txt", "unsafe manager change\\n");
    let requiredChangePresent = true;
    if (action === "done" && process.env.FAKE_REQUIRE_CHANGE_ON_DONE === "1") {
      try { await access(process.cwd() + "/fake-change.txt"); } catch { requiredChangePresent = false; }
    }
    const decision = action === "execute" || action === "mutate" ? { action: action === "mutate" ? "done" : "execute", ...(action === "execute" ? { stage: { name: "adaptive-implementation", executor: "codebuddy", task: "implement adaptive task" } } : {}) }
      : action === "ask" ? { action, questions: ["请补充需求？"] }
      : action === "blocked" ? { action, reason: "缺少外部权限" }
      : action === "invalid" ? { action: "done", extra: true }
      : requiredChangePresent ? { action: "done" } : { action: "done", missingChange: true };
    if (candidate) await writeFile(candidate, JSON.stringify(decision));
  } else if (prompt.includes("context handshake")) {
    const blockingQuestions = process.env.FAKE_BLOCKING_QUESTION ? [process.env.FAKE_BLOCKING_QUESTION] : [];
    await writeFile(jobDir + "/understanding.json", JSON.stringify({ interpretedGoal: "fake goal", plannedFiles: [], acceptanceCriteria: [], assumptions: [], blockingQuestions }));
  } else if (prompt.includes("independent review")) {
    const verdict = process.env.FAKE_REVIEW_VERDICT ?? "PASS";
    await writeFile(jobDir + "/review.md", process.env.FAKE_REVIEW_CONTENT ?? ("VERDICT: " + verdict + "\\n"));
    let definitions;
    try { definitions = JSON.parse(await (await import("node:fs/promises")).readFile(jobDir + "/auditor-context.json", "utf8")).current.criteria; } catch {}
    if (definitions) {
      const partial = process.env.FAKE_AUDIT_MODE === "partial";
      const inconsistent = process.env.FAKE_AUDIT_MODE === "inconsistent";
      const criteria = definitions.map((item, index) => {
        const status = inconsistent || (partial && index > 0) ? "unverified" : "verified";
        const evidence = status === "verified" ? ["complete.patch", "test.log", process.env.FAKE_AUDIT_UNSAFE === "1" ? "../secret" : "review.md"] : [];
        return { id: item.id, status, evidence };
      });
      await writeFile(jobDir + "/audit-candidate.json", JSON.stringify({ version: 1, completion: partial ? "incomplete" : "complete", cleanliness: "clean", alignment: "aligned", criteria }));
    }
    if (process.env.FAKE_REVIEW_MUTATE === "1") await writeFile(process.cwd() + "/reviewer-change.txt", "untested reviewer change\\n");
  } else {
    await writeFile(jobDir + "/handback.md", "fake handback\\n");
    if (process.env.FAKE_MUTATE_DEP === "1") await writeFile(process.cwd() + "/package.json", '{"name":"modified"}', "utf8");
    await writeFile(process.cwd() + "/fake-change.txt", "changed\\n");
    if (process.env.FAKE_STAGE_CHANGE === "1") (await import("node:child_process")).spawnSync("git", ["add", "fake-change.txt"], { cwd: process.cwd() });
  }
}
// review-gate：prompt 含 "stop-gate review"，从 prompt 解析 review.md 路径写 verdict
if (prompt.includes("stop-gate review")) {
  const match = prompt.match(/将结果写入 (.+?review\\.md)/);
  if (match) {
    const verdict = process.env.FAKE_REVIEW_VERDICT ?? "PASS";
    await writeFile(match[1], process.env.FAKE_REVIEW_CONTENT ?? ("VERDICT: " + verdict + "\\n"));
  }
}
const sequence = (process.env.FAKE_EXIT_SEQUENCE ?? "0").split(",");
const counterFile = process.env.FAKE_COUNTER_FILE;
let index = 0;
if (counterFile) {
  try { index = Number(await (await import("node:fs/promises")).readFile(counterFile, "utf8")); } catch {}
  await writeFile(counterFile, String(index + 1));
}
process.exit(Number(sequence[Math.min(index, sequence.length - 1)] ?? 0));
`;

export async function setupFake(): Promise<{
  workspace: string;
  script: string;
}> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-e2e-"));
  const binaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "cbx-fake-bin-"),
  );
  const script = path.join(binaryDirectory, "fake-codebuddy.mjs");
  await writeFile(script, fakeAgent, "utf8");
  process.env.CBX_CODEBUDDY = script;
  process.env.FAKE_JOB_DIR = "";
  process.env.FAKE_SLEEP_MS = "0";
  process.env.FAKE_EXIT_SEQUENCE = "0";
  process.env.FAKE_REVIEW_VERDICT = "PASS";
  delete process.env.FAKE_REVIEW_CONTENT;
  delete process.env.FAKE_REVIEW_MUTATE;
  delete process.env.FAKE_AUDIT_MODE;
  delete process.env.FAKE_AUDIT_UNSAFE;
  delete process.env.FAKE_MANAGER_ACTIONS;
  delete process.env.FAKE_MANAGER_COUNTER_FILE;
  delete process.env.FAKE_REQUIRE_CHANGE_ON_DONE;
  delete process.env.FAKE_STAGE_CHANGE;
  delete process.env.FAKE_COUNTER_FILE;
  delete process.env.FAKE_PROMPT_FILE;
  delete process.env.FAKE_BLOCKING_QUESTION;
  delete process.env.FAKE_MUTATE_DEP;
  return { workspace, script };
}

export async function createAdaptiveJob(
  workspace: string,
  jobId: string,
  maxRounds = 4,
) {
  return createJob({
    workspace,
    task: "adaptive task",
    taskContract: {
      goal: "adaptive goal",
      acceptanceCriteria: ["adaptive criterion"],
    },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    adaptive: { enabled: true, maxRounds },
    jobId,
  });
}

export async function initializeGitWorkspace(workspace: string): Promise<void> {
  spawnSync("git", ["init", "-b", "main"], {
    cwd: workspace,
    encoding: "utf8",
  });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], {
    cwd: workspace,
  });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], {
    cwd: workspace,
    encoding: "utf8",
  });
}

// 从 src 模块再导出，供拆分后的测试文件使用
export {
  approveJob,
  cancelJob,
  createJob,
  executeJob,
  health,
  listJobs,
  listQueue,
  loadConfig,
  loadState,
  mergeConfig,
  pauseQueue,
  readArtifact,
  readEventsIncremental,
  resumeQueue,
  retryQueueJob,
  serveQueue,
  startBackground,
} from "../src/core.js";
export type { JobState } from "../src/core.js";
export { runReviewGate, stopReviewGateHook } from "../src/review-gate.js";
export {
  acquireServiceLease,
  loadPersistedQueue,
  loadPersistedState,
  savePersistedStateAndQueue,
} from "../src/storage.js";
export {
  BUILTIN_EXECUTORS,
  resolveExecutor,
} from "../src/executors/builtin.js";
export { parseNextAction } from "../src/adaptive-manager.js";
export {
  CONTEXT_PACK_MAX_CHARS,
  parseContextPack,
} from "../src/context-pack.js";
export {
  createHumanGate,
  extendRoundLimit,
  parseHumanGate,
  resolveHumanGate,
} from "../src/human-gate.js";
