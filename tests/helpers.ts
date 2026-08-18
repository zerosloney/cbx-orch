
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  createJob,
} from "../src/core.js";

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
    // 结构化 verdict：FAKE_REVIEW_JSON=1 时写 review.json；FAKE_REVIEW_JSON_VERDICT 可覆盖（与 md 判定不同，用于验证优先级）。
    if (process.env.FAKE_REVIEW_JSON === "1") {
      const jsonVerdict = process.env.FAKE_REVIEW_JSON_VERDICT ?? verdict;
      await writeFile(jobDir + "/review.json", JSON.stringify({ version: 1, verdict: jsonVerdict }));
    }
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
    console.log("fake executor output");
    await writeFile(jobDir + "/handback.md", "fake handback\\n");
    // 并行 stage 模式：按 prompt 中的 "stage <idx>: <name>" 写独立文件 / 指定冲突文件 / 按名失败。
    const stageMatch = prompt.match(/stage (\\d+): ([A-Za-z0-9_-]+)/);
    if (process.env.FAKE_STAGE_NAMES) {
      if (process.env.FAKE_FAIL_STAGE && stageMatch && stageMatch[2] === process.env.FAKE_FAIL_STAGE) process.exit(7);
      if (stageMatch) {
        const stageName = stageMatch[2];
        // 并发证明：api 轮询等待 ui 的 marker（确定性同步，非定时猜测）；串行执行下 api 先跑会超时退出。
        // marker 写共享 jobDir（各 stage worktree 互相不可见），等待/触碰都指向同一绝对路径。
        if (process.env.FAKE_WAIT_FOR_FILE) {
          const sep = process.env.FAKE_WAIT_FOR_FILE.indexOf("=");
          const targetStage = sep >= 0 ? process.env.FAKE_WAIT_FOR_FILE.slice(0, sep) : "";
          const file = sep >= 0 ? process.env.FAKE_WAIT_FOR_FILE.slice(sep + 1) : "";
          if (stageName === targetStage) {
            const barrier = jobDir + "/" + file;
            const deadline = Date.now() + 10_000;
            let found = false;
            while (Date.now() < deadline) {
              try { await access(barrier); found = true; break; } catch {
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
            }
            if (!found) process.exit(4);
          }
        }
        if (process.env.FAKE_CONFLICT_FILE) {
          await writeFile(process.cwd() + "/" + process.env.FAKE_CONFLICT_FILE, stageName + "\\n");
        } else {
          await writeFile(process.cwd() + "/" + stageName + ".txt", stageName + "\\n");
        }
        if (process.env.FAKE_TOUCH_FILE) {
          const sep = process.env.FAKE_TOUCH_FILE.indexOf("=");
          const targetStage = sep >= 0 ? process.env.FAKE_TOUCH_FILE.slice(0, sep) : "";
          const file = sep >= 0 ? process.env.FAKE_TOUCH_FILE.slice(sep + 1) : "";
          if (stageName === targetStage) await writeFile(jobDir + "/" + file, "1\\n");
        }
      }
      if (process.env.FAKE_REQUIRE_FILES) {
        // 格式 "<stageName>=<file1>,<file2>"：只对指定 stage 校验前置产物存在（并行首层不能互等）。
        const sep = process.env.FAKE_REQUIRE_FILES.indexOf("=");
        const targetStage = sep >= 0 ? process.env.FAKE_REQUIRE_FILES.slice(0, sep) : "";
        const fileList = sep >= 0 ? process.env.FAKE_REQUIRE_FILES.slice(sep + 1) : "";
        if (stageMatch && stageMatch[2] === targetStage) {
          for (const file of fileList.split(",")) {
            try { await access(process.cwd() + "/" + file); } catch { process.exit(3); }
          }
        }
      }
    } else {
      if (process.env.FAKE_MUTATE_DEP === "1") await writeFile(process.cwd() + "/package.json", '{"name":"modified"}', "utf8");
      await writeFile(process.cwd() + "/fake-change.txt", "changed\\n");
      if (process.env.FAKE_STAGE_CHANGE === "1") (await import("node:child_process")).spawnSync("git", ["add", "fake-change.txt"], { cwd: process.cwd() });
    }
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
  delete process.env.FAKE_REVIEW_JSON;
  delete process.env.FAKE_REVIEW_JSON_VERDICT;
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
  delete process.env.FAKE_STAGE_NAMES;
  delete process.env.FAKE_FAIL_STAGE;
  delete process.env.FAKE_CONFLICT_FILE;
  delete process.env.FAKE_REQUIRE_FILES;
  delete process.env.FAKE_WAIT_FOR_FILE;
  delete process.env.FAKE_TOUCH_FILE;
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
  findExecutable,
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
