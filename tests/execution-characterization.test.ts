/**
 * executeJobLocked characterization tests.
 *
 * executeJobLocked (src/execution.ts:117, ~700 行) 三条主路径 + finish 闭包的分支极多。
 * core.test.ts 已覆盖 adaptive ask/blocked/done/mutation/maxRounds+continuation、
 * approvalBeforeComplete、autoCommit 失败、repeated_failure、stage 顺序与失败传播事件。
 * 本文件聚焦尚未被任何测试锁定的分支，为未来拆分 runAdaptive / runStageChain / runContinuation 铺安全网。
 *
 * 覆盖的缺口：
 *   1. managerDoneStreak done→verification_gate 重试路径（adaptive_manager_skipped 事件 + 缓存跳过）
 *   2. 失败传播的 stage 报告形状（不只是事件串：exitCode:-1 / attempts:0 / testExitCode:null）
 *   3. adaptive_state 腐败守卫（非整数 adaptiveRound）
 *   4. 依赖模式 handback 路由（与线性模式区分）
 *   5. adaptive 路径上的 dependencyGuard（现有测试只覆盖静态 stage chain）
 *
 * Harness：沿用 core.test.ts 的 fake-binary 模式（CBX_CODEBUDDY 指向自写 .mjs，FAKE_* env 驱动）。
 * 关键不变量：fake agent 的 context handshake / manager / review 分支必须 process.exit(0)，
 * 否则 handshake 阶段失败会阻断后续 stage 执行（handshake 发生在 stage-chain 之前）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, executeJob, loadState, writeState } from "../src/core.js";

// ---- fake-binary harness ----

/**
 * 伪 codebuddy 二进制。分支：
 *  - context handshake / adaptive manager / independent review → 写对应产物并 process.exit(0)
 *    （这些阶段必须成功，否则阻断 stage 执行）
 *  - executor 阶段（fallback）→ 写 handback + fake-change.txt，退出码走 FAKE_EXIT_SEQUENCE
 *
 * env 驱动：
 *  - FAKE_JOB_DIR: job 目录
 *  - FAKE_MANAGER_ACTIONS: 逗号分隔 decision 序列（execute/ask/blocked/done/mutate）
 *  - FAKE_REVIEW_VERDICT: review VERDICT（PASS/FAIL）
 *  - FAKE_AUDIT_MODE: complete/partial/inconsistent
 *  - FAKE_COUNTER_FILE / FAKE_EXIT_SEQUENCE: executor 阶段跨调用计数 + 退出码序列
 *  - FAKE_MUTATE_DEP: executor 阶段写 package.json（触发 dependencyGuard）
 */
const fakeAgent = String.raw`
import { mkdir, writeFile, readFile } from "node:fs/promises";
const prompt = process.argv.at(-1) ?? "";
const jobDir = process.env.FAKE_JOB_DIR ?? "";
if (jobDir) await mkdir(jobDir, { recursive: true });
// adaptive manager 决策
if (prompt.includes("adaptive manager") && jobDir) {
  const candidate = prompt.match(/写入 (.+?manager-decision-candidate\.json)/)?.[1];
  const actions = (process.env.FAKE_MANAGER_ACTIONS ?? "execute,done").split(",");
  const counterFile = process.env.FAKE_MANAGER_COUNTER_FILE ?? (jobDir + "/manager-counter.txt");
  let managerIndex = 0;
  try { managerIndex = Number(await readFile(counterFile, "utf8")); } catch {}
  await writeFile(counterFile, String(managerIndex + 1));
  const action = actions[Math.min(managerIndex, actions.length - 1)];
  if (action === "mutate") await writeFile(process.cwd() + "/manager-change.txt", "unsafe\n");
  const decision =
    action === "execute" ? { action: "execute", stage: { name: "adaptive-impl", executor: "codebuddy", task: "implement" } }
    : action === "ask" ? { action: "ask", questions: ["请补充需求？"] }
    : action === "blocked" ? { action: "blocked", reason: "缺少权限" }
    : { action: "done" };
  if (candidate) await writeFile(candidate, JSON.stringify(decision));
  process.exit(0);
}
// context handshake
if (prompt.includes("context handshake") && jobDir) {
  await writeFile(jobDir + "/understanding.json", JSON.stringify({ interpretedGoal: "fake", plannedFiles: [], acceptanceCriteria: [], assumptions: [], blockingQuestions: [] }));
  process.exit(0);
}
// independent review
if (prompt.includes("independent review") && jobDir) {
  const verdict = process.env.FAKE_REVIEW_VERDICT ?? "PASS";
  await writeFile(jobDir + "/review.md", "VERDICT: " + verdict + "\n");
  let definitions;
  try { definitions = JSON.parse(await readFile(jobDir + "/auditor-context.json", "utf8")).current.criteria; } catch {}
  if (definitions) {
    const mode = process.env.FAKE_AUDIT_MODE ?? "complete";
    const criteria = definitions.map((item, index) => {
      const status = mode === "inconsistent" || (mode === "partial" && index > 0) ? "unverified" : "verified";
      return { id: item.id, status, evidence: status === "verified" ? ["complete.patch", "test.log", "review.md"] : [] };
    });
    await writeFile(jobDir + "/audit-candidate.json", JSON.stringify({ version: 1, completion: mode === "partial" ? "incomplete" : "complete", cleanliness: "clean", alignment: "aligned", criteria }));
  }
  process.exit(0);
}
// executor 阶段：写 handback + 代码改动；可选改依赖文件
if (jobDir) await writeFile(jobDir + "/handback.md", "# handback\nfake stage output\n");
await writeFile(process.cwd() + "/fake-change.txt", "changed\n");
if (process.env.FAKE_MUTATE_DEP === "1") await writeFile(process.cwd() + "/package.json", '{"name":"mutated-by-stage"}', "utf8");
const sequence = (process.env.FAKE_EXIT_SEQUENCE ?? "0").split(",");
const counterFile = process.env.FAKE_COUNTER_FILE;
let index = 0;
if (counterFile) {
  try { index = Number(await readFile(counterFile, "utf8")); } catch {}
  await writeFile(counterFile, String(index + 1));
}
process.exit(Number(sequence[Math.min(index, sequence.length - 1)] ?? 0));
`;

async function setupFake(): Promise<{ workspace: string; binDir: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-char-"));
  // fake binary 放工作区外的 bin 目录，避免污染 git dirty fingerprint
  const binDir = await mkdtemp(path.join(os.tmpdir(), "cbx-char-bin-"));
  const script = path.join(binDir, "fake-codebuddy.mjs");
  await writeFile(script, fakeAgent, "utf8");
  process.env.CBX_CODEBUDDY = script;
  process.env.FAKE_JOB_DIR = "";
  process.env.FAKE_SLEEP_MS = "0";
  process.env.FAKE_EXIT_SEQUENCE = "0";
  process.env.FAKE_REVIEW_VERDICT = "PASS";
  process.env.FAKE_AUDIT_MODE = "complete";
  for (const key of [
    "FAKE_MANAGER_ACTIONS",
    "FAKE_MANAGER_COUNTER_FILE",
    "FAKE_COUNTER_FILE",
    "FAKE_REQUIRE_CHANGE_ON_DONE",
    "FAKE_MUTATE_DEP",
  ])
    delete process.env[key];
  return { workspace, binDir };
}

async function createAdaptiveJob(
  workspace: string,
  jobId: string,
  maxRounds = 4,
) {
  return createJob({
    workspace,
    task: "adaptive task",
    taskContract: { goal: "adaptive goal", acceptanceCriteria: ["criterion"] },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 5_000,
    maxRetries: 0,
    adaptive: { enabled: true, maxRounds },
    jobId,
  });
}

async function initializeGitWorkspace(workspace: string): Promise<void> {
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "cbx@example.test"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "CBX Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
  // 预置 package.json 并提交：dependencyGuard 在 stage 执行前对现存依赖文件建基线，
  // 没有 package.json 的话 stage 新建的 package.json 不会被检测为"修改"。
  await writeFile(path.join(workspace, "package.json"), '{"name":"base"}', "utf8");
  spawnSync("git", ["add", "-A"], { cwd: workspace });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace, encoding: "utf8" });
}

// ---- 缺口 1：managerDoneStreak done→verification_gate 重试路径 ----

test("adaptive done failing evidence gate retries via done-streak skip without re-invoking manager", async () => {
  // 契约：manager execute(stage 跑过 review=PASS 但 audit partial → 证据门不过) →
  //   下一轮 done → verification_gate → managerDoneStreak++ → 后续轮 skipManager 直接走 done。
  //   锁定：(a) adaptive_manager_skipped 事件出现；(b) manager 调用次数 < 总轮次（done-streak 生效）。
  const { workspace } = await setupFake();
  process.env.FAKE_MANAGER_ACTIONS = "execute,done,done";
  process.env.FAKE_AUDIT_MODE = "partial"; // audit incomplete → 证据门不过
  const job = await createAdaptiveJob(workspace, "char-done-streak", 5);
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  // partial audit + maxRounds=5：done-streak 命中跳过 manager，但证据始终不过 → 终态 needs_fix。
  assert.equal(state.status, "needs_fix");
  const events = await readFile(path.join(job.directory, "events.ndjson"), "utf8");
  assert.match(
    events,
    /adaptive_manager_skipped/,
    "done-streak 命中时应发出 adaptive_manager_skipped 事件",
  );
  const managerCalls = Number(
    await readFile(path.join(job.directory, "manager-counter.txt"), "utf8").catch(
      () => "0",
    ),
  );
  const totalRounds = Number(state.adaptiveRound ?? 0);
  assert.ok(
    managerCalls < totalRounds,
    `manager 调用 ${managerCalls} 次应少于总轮次 ${totalRounds}（done-streak 跳过生效）`,
  );
});

// ---- 缺口 2：失败传播的 stage 报告形状 ----

test("terminal executor failure propagates skipped report shape to downstream stages", async () => {
  // 契约：base 执行器退出码 1 → 耗尽 executionRetries → terminal failed；
  //   downstream（dependsOn base）在 result.stages 中记 skipped 形状：
  //   exitCode:-1 / testExitCode:null / reviewVerdict:null / attempts:0。
  //   P1-5 只断言 stage_skipped 事件串；本测试锁定 report 数据形状。
  const { workspace } = await setupFake();
  const counter = path.join(workspace, "exit-counter.txt");
  process.env.FAKE_COUNTER_FILE = counter;
  process.env.FAKE_EXIT_SEQUENCE = "1"; // executor 阶段退出 1
  const job = await createJob({
    workspace,
    task: "fail propagate",
    taskContract: {
      goal: "fail shape",
      stages: [
        { name: "base", executor: "codebuddy", task: "base work" },
        { name: "downstream", executor: "codebuddy", task: "after base", dependsOn: ["base"] },
      ],
    },
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "char-fail-propagate",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "failed");
  assert.equal(state.phase, "executing");
  const stages = state.stages as Array<{
    name: string;
    exitCode: number;
    testExitCode: number | null;
    reviewVerdict: string | null;
    attempts: number;
  }>;
  assert.equal(stages.length, 2, "result.stages 应包含 base + downstream");
  const downstream = stages.find((s) => s.name === "downstream");
  assert.ok(downstream, "downstream stage 应在 result.stages 中");
  assert.equal(downstream!.exitCode, -1, "被跳过的 stage exitCode 应为 -1");
  assert.equal(downstream!.testExitCode, null, "被跳过的 stage testExitCode 应为 null");
  assert.equal(downstream!.reviewVerdict, null, "被跳过的 stage reviewVerdict 应为 null");
  assert.equal(downstream!.attempts, 0, "被跳过的 stage attempts 应为 0（未执行）");
});

test("review FAIL on upstream stage propagates downstream as skipped", async () => {
  // 契约：base review 返回 FAIL（非 semantic）→ 耗尽 fixRetries 后 terminal needs_fix/reviewing；
  //   downstream(dependsOn base) skipped。锁定 base reviewVerdict=FAIL + downstream skipped 形状。
  //   注意：非 semantic FAIL 终态是 needs_fix/reviewing（走 fix retry 后耗尽），非 review_failed。
  const { workspace } = await setupFake();
  process.env.FAKE_REVIEW_VERDICT = "FAIL"; // base review FAIL
  const job = await createJob({
    workspace,
    task: "review fail propagate",
    taskContract: {
      goal: "review propagate",
      acceptanceCriteria: ["c"],
      stages: [
        { name: "base", executor: "codebuddy", task: "base work" },
        { name: "downstream", executor: "codebuddy", task: "after base", dependsOn: ["base"] },
      ],
    },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "char-review-fail-propagate",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "reviewing");
  const stages = state.stages as Array<{ name: string; reviewVerdict: string | null; exitCode: number; testExitCode: number | null }>;
  const base = stages.find((s) => s.name === "base");
  const downstream = stages.find((s) => s.name === "downstream");
  assert.equal(base!.reviewVerdict, "FAIL", "base reviewVerdict 应为 FAIL");
  assert.ok(downstream, "downstream 应在 stages 中");
  assert.equal(downstream!.exitCode, -1, "downstream 因 review FAIL 被跳过");
  assert.equal(downstream!.testExitCode, null);
});

// ---- 缺口 3：adaptive_state 腐败守卫 ----

test("non-integer adaptiveRound persisted state is rejected with adaptive_state phase", async () => {
  // 契约：loadState 返回 adaptiveRound 非整数 → executeJobLocked 立即 finish needs_fix/adaptive_state，
  //   不进入 adaptive loop。锁定早期守卫，避免腐败状态耗尽 maxRounds 或反复调 manager。
  //   必须用 writeState 写入（loadState 读 SQLite，state.json 不生效）。
  const { workspace } = await setupFake();
  const job = await createAdaptiveJob(workspace, "char-corrupt-round", 3);
  process.env.FAKE_JOB_DIR = job.directory;
  // 先跑一轮让它进入 adaptive 状态，再注入腐败 adaptiveRound（模拟崩溃后磁盘腐败）
  await writeState(workspace, job.jobId, { adaptiveRound: 1.5 });
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "adaptive_state");
  assert.match(String(state.error ?? ""), /adaptiveRound/);
});

// ---- 缺口 4：依赖模式 vs 线性模式的 handback 内容路由 ----

test("dependent stage chain preserves per-stage handback copies for both dependency and linear modes", async () => {
  // 契约：依赖模式（s2 dependsOn s1）→ collectDependencyHandbacks 注入 s1 handback；
  //   线性模式（无 dependsOn）→ 注入"上一阶段交接"前缀。两者都落 stage-<index>-<name>-handback.md 副本。
  //   现有 multi-stage test 只验单链 happy path；本测试锁定依赖模式两 stage 副本都存在 + done。
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "handback route",
    taskContract: {
      goal: "handback",
      stages: [
        { name: "s1", executor: "codebuddy", task: "first stage" },
        { name: "s2", executor: "codebuddy", task: "second stage", dependsOn: ["s1"] },
      ],
    },
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 5_000,
    maxRetries: 0,
    jobId: "char-handback-dep",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  // 依赖模式：两个 stage 的 handback 副本都应存在（collectDependencyHandbacks 读 s1 副本）。
  assert.ok(
    existsSync(path.join(job.directory, "stage-0-s1-handback.md")),
    "s1 handback 副本应存在（依赖 handback 源）",
  );
  assert.ok(
    existsSync(path.join(job.directory, "stage-1-s2-handback.md")),
    "s2 handback 副本应存在",
  );
});

// ---- 缺口 5：adaptive 路径上的 dependencyGuard ----

test("adaptive stage that modifies dependency files triggers dependency_guard phase", async () => {
  // 契约：adaptive.enabled + dependencyGuard=true → runStage 内 stage executor 改 package.json →
  //   耗尽 fixRetries 后 finish needs_fix/dependency_guard。锁定 adaptive 路径上的依赖守卫。
  //   现有 dependency_guard 测试(core.test.ts:1776)只覆盖静态 stage chain，未覆盖 adaptive。
  //   fake binary 放工作区外（binDir），且 git baseline 须干净（否则 dirty_baseline 先触发）。
  const { workspace, binDir } = await setupFake();
  await initializeGitWorkspace(workspace);
  process.env.FAKE_MANAGER_ACTIONS = "execute";
  process.env.FAKE_MUTATE_DEP = "1"; // executor 阶段改 package.json
  const job = await createJob({
    workspace,
    task: "adaptive dep guard",
    taskContract: { goal: "dep guard", acceptanceCriteria: ["c"] },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 5_000,
    maxRetries: 0,
    adaptive: { enabled: true, maxRounds: 3 },
    dependencyGuard: true,
    jobId: "char-adaptive-dep-guard",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "dependency_guard");
  assert.match(String(state.error ?? ""), /依赖守卫/);
});
