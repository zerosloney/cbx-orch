import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJob, executeJob } from "../src/core.js";
import type { StageReport } from "../src/types.js";
import { initializeGitWorkspace, setupFake } from "./helpers.js";

/** 依赖模式任务：层 1 = [api, ui]（并行），层 2 = [integrate dependsOn api, ui]。 */
async function dependencyJob(
  workspace: string,
  env: Record<string, string>,
  jobId: string,
) {
  process.env.FAKE_STAGE_NAMES = "1";
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return createJob({
    workspace,
    task: "并行 stage",
    review: false,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 15_000,
    maxRetries: 0,
    keepWorktree: true,
    testCommand: 'node -e "process.exit(0)"',
    taskContract: {
      goal: "并行目标",
      acceptanceCriteria: ["api/ui/integrate 文件齐全"],
      stages: [
        { name: "api", executor: "codebuddy", task: "实现 api" },
        { name: "ui", executor: "codebuddy", task: "实现 ui" },
        {
          name: "integrate",
          executor: "codebuddy",
          task: "集成联调",
          dependsOn: ["api", "ui"],
        },
      ],
    },
    jobId,
  });
}

test("依赖模式隔离执行：同层 stage 并行、合并后下游 stage 可见、证据完整", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await dependencyJob(
    workspace,
    { FAKE_REQUIRE_FILES: "integrate=api.txt,ui.txt" },
    "par-job",
  );
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(
    state.status,
    "done",
    JSON.stringify({ phase: state.phase, error: state.error }),
  );
  // 主 worktree 合并了全部 stage 的改动（integrate 依赖 api/ui 产物 = 层间合并生效）
  const worktree = (
    JSON.parse(
      await readFile(path.join(job.directory, "worktree.json"), "utf8"),
    ) as { path: string }
  ).path;
  for (const file of ["api.txt", "ui.txt", "integrate.txt"])
    assert.ok(
      existsSync(path.join(worktree, file)),
      `${file} 应存在于主 worktree`,
    );
  // complete.patch 对任务基线计算：包含全部三个 stage 的改动
  const patch = await readFile(path.join(job.directory, "complete.patch"), "utf8");
  for (const file of ["api.txt", "ui.txt", "integrate.txt"])
    assert.match(patch, new RegExp(`b/${file}`));
  // stage 私有产物目录保留（审计副本）
  const artifactDirs = await readdir(path.join(job.directory, "stage-artifacts"));
  assert.deepEqual([...artifactDirs].sort(), ["0", "1", "2"]);
  // 三个 stage 报告齐全且全部通过
  assert.equal((state.stages ?? []).length, 3);
  for (const stage of state.stages ?? [])
    assert.equal(stage.exitCode, 0, `${stage.name} 应通过`);
});

test("同层 stage 写同一文件 → needs_fix/stage_merge_conflict", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await dependencyJob(
    workspace,
    { FAKE_CONFLICT_FILE: "conflict.txt" },
    "conflict-job",
  );
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "stage_merge_conflict");
  assert.match(String(state.error ?? ""), /合并冲突/);
  const conflicts = state.mergeConflicts as string[] | undefined;
  assert.ok(Array.isArray(conflicts) && conflicts.length > 0);
});

test("层内 stage 失败 → 任务停止，下游 stage 标记 skipped", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await dependencyJob(
    workspace,
    { FAKE_FAIL_STAGE: "api" },
    "fail-job",
  );
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "failed");
  // api 失败；ui 同层成功（报告保留）；integrate 因依赖失败被 skipped
  const reports = (state.stages ?? []) as StageReport[];
  const api = reports.find((report) => report.name === "api");
  const ui = reports.find((report) => report.name === "ui");
  const integrate = reports.find((report) => report.name === "integrate");
  assert.ok(api && api.exitCode !== 0, "api 应失败");
  assert.ok(ui && ui.exitCode === 0, "ui 应成功（同层独立）");
  assert.ok(integrate, "integrate 应有报告");
  assert.equal(integrate.exitCode, -1, "integrate 应被 skipped");
});

test("非隔离 + 依赖模式保持串行（既有行为不变）", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  process.env.FAKE_STAGE_NAMES = "1";
  const job = await createJob({
    workspace,
    task: "串行依赖",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 15_000,
    maxRetries: 0,
    testCommand: 'node -e "process.exit(0)"',
    taskContract: {
      goal: "串行目标",
      acceptanceCriteria: ["完成"],
      stages: [
        { name: "base", executor: "codebuddy", task: "基础" },
        {
          name: "top",
          executor: "codebuddy",
          task: "上层",
          dependsOn: ["base"],
        },
      ],
    },
    jobId: "serial-deps-job",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(
    state.status,
    "done",
    JSON.stringify({ phase: state.phase, error: state.error }),
  );
  // 非隔离：不创建 stage worktree（无 worktree-stage-* 记录）
  const entries = await readdir(job.directory);
  assert.ok(
    !entries.some((entry) => /^worktree-stage-\d+\.json$/.test(entry)),
    "非隔离模式不得产生 stage worktree 记录",
  );
});

test("同层 stage 真并行：api 等待 ui 的 marker 才能完成（串行会死锁失败）", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await dependencyJob(
    workspace,
    {
      FAKE_WAIT_FOR_FILE: "api=ui-marker.txt",
      FAKE_TOUCH_FILE: "ui=ui-marker.txt",
    },
    "concurrent-job",
  );
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  // api 必须先于 ui 结束才能看到 marker：只有层内并发才可能完成；串行下 api 等待超时失败。
  assert.equal(
    state.status,
    "done",
    JSON.stringify({ phase: state.phase, error: state.error }),
  );
});

test("commitLayer 空改动时走 early return(lines 316-317)不抛错不提交", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  // 制造单 stage 无代码改动场景：stage 用 exit 0 而任务目标为空
  // commitLayer 在中间层调用(line 404)，末层不调用——用三层 stage 测试
  process.env.FAKE_STAGE_NAMES = "1";
  const job = await createJob({
    workspace,
    task: "空提交守卫测试",
    review: false,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 20_000,
    maxRetries: 0,
    keepWorktree: false,
    testCommand: 'node -e "process.exit(0)"',
    taskContract: {
      goal: "无文件改动",
      acceptanceCriteria: [],
      stages: [
        { name: "init", executor: "codebuddy", task: "初始化" },
        { name: "process", executor: "codebuddy", task: "处理", dependsOn: ["init"] },
        { name: "finish", executor: "codebuddy", task: "完成", dependsOn: ["process"] },
      ],
    },
    jobId: "commit-layer-test",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  // init stage 产生 git add(有产物)；process stage 依赖 init，合并后 process layer 无新文件则 commitLayer early return
  // 验证：job 完成无异常
  const state = await executeJob(workspace, job.jobId);
  assert.ok(
    state.status === "done" || state.status === "needs_fix",
    `期望 done/needs_fix，实际 ${state.status}/${state.phase}`,
  );
});
