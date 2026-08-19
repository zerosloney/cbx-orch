/**
 * Stage 依赖并行执行（dependency mode）：
 * 每 stage 在独立 worktree 中运行（executor/test/review），层内并发、层间串行，
 * 每层完成后把各 stage 的 diff 按声明顺序合并进主 worktree，供下一层作为 worktree 基。
 *
 * 语义与串行依赖模式一致：下一层的 stage worktree 包含全部前置层合并结果；
 * 差异仅在——（a）同层 stage 物理并行；（b）中间层在主 worktree 产生内部合并提交
 * （diff 统一对任务基线计算，最终 complete.patch 与串行等价）；（c）stage 产出物
 * 写入各自私有目录（stage-artifacts/<index>/），最终聚合为 jobDir 证据。
 *
 * 适用条件：isolated=true 且 taskContract.stages 存在 dependsOn（依赖模式）。
 * 非隔离或线性（无 dependsOn）stage 链走 execution.ts 的既有串行路径，行为不变。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  prepareStageWorktree,
  cleanupStageWorktree,
  mergeStageIntoMain,
  commitLayer,
  worktreeHead,
  collectDiff,
} from "./git-ops.js";
import { loadState, logJobEvent } from "./state.js";
import { runStage } from "./stage-runner.js";
import { resolveAgentLabel } from "./agent-registry.js";
import type {
  JobContext,
  JobState,
  Json,
  TaskStage,
  StageReport,
} from "./types.js";

/** 按 stage 依赖分层：同一层内的 stage 无相互依赖（可并行），跨层有依赖。
 *  依赖校验（悬空/循环）已在 normalizeTaskContract 完成，此处不重复检测。 */
export function groupStagesByDependency(stages: TaskStage[]): TaskStage[][] {
  if (stages.length <= 1) return [stages];
  const hasDeps = stages.some(
    (stage) => stage.dependsOn && stage.dependsOn.length > 0,
  );
  if (!hasDeps) return [stages]; // 无任何依赖：单层，保持原线性顺序
  const completed = new Set<string>();
  const remaining = [...stages];
  const layers: TaskStage[][] = [];
  while (remaining.length > 0) {
    const ready = remaining.filter((stage) =>
      (stage.dependsOn ?? []).every((dep) => completed.has(dep)),
    );
    if (ready.length === 0) {
      // 不应发生（循环依赖已拒绝），兜底防死循环
      layers.push(remaining);
      break;
    }
    layers.push(ready);
    for (const stage of ready) completed.add(stage.name);
    for (const stage of ready) remaining.splice(remaining.indexOf(stage), 1);
  }
  return layers;
}

/** 收集一个 stage 的所有 dependsOn stage 的 handback 内容，按完成顺序拼接。 */
export async function collectDependencyHandbacks(
  directory: string,
  stages: TaskStage[],
  stage: TaskStage,
): Promise<string> {
  const deps = stage.dependsOn ?? [];
  if (deps.length === 0) return "";
  const parts: string[] = [];
  for (const dep of deps) {
    const depIndex = stages.findIndex((s) => s.name === dep);
    if (depIndex < 0) continue;
    const safeName = dep.replace(/[^A-Za-z0-9._-]+/g, "-");
    const handbackFile = path.join(
      directory,
      `stage-${depIndex}-${safeName}-handback.md`,
    );
    if (existsSync(handbackFile)) {
      const content = await readFile(handbackFile, "utf8");
      parts.push(`## 前置阶段 ${dep} 的交接\n\n${content}`);
    }
  }
  return parts.join("\n\n");
}

/** 已完成的 stage 产物目录（用于最终证据聚合与下游 handback）。 */
interface CompletedStage {
  idx: number;
  name: string;
}

function stageArtifactDir(directory: string, idx: number): string {
  return path.join(directory, "stage-artifacts", String(idx));
}

/** 把全部已完成 stage 的 test.log / review.md / handback.md 聚合成 jobDir 版本
 *  （证据门与 UI 读取单份文件；stage 私有副本保留在 stage-artifacts/）。 */
async function aggregateStageArtifacts(
  directory: string,
  completed: CompletedStage[],
): Promise<void> {
  const testParts: string[] = [];
  const reviewParts: string[] = [];
  const handbackParts: string[] = [];
  for (const { idx, name } of completed) {
    const dir = stageArtifactDir(directory, idx);
    const testLog = path.join(dir, "test.log");
    if (existsSync(testLog)) {
      testParts.push(`## stage ${idx}: ${name}\n\n${await readFile(testLog, "utf8")}`);
    }
    const reviewMd = path.join(dir, "review.md");
    if (existsSync(reviewMd)) {
      reviewParts.push(`## stage ${idx}: ${name}\n\n${await readFile(reviewMd, "utf8")}`);
    }
    const handback = path.join(dir, "handback.md");
    if (existsSync(handback)) {
      handbackParts.push(`## stage ${idx}: ${name}\n\n${await readFile(handback, "utf8")}`);
    }
  }
  await Promise.all([
    writeFile(path.join(directory, "test.log"), testParts.join("\n\n") + "\n", "utf8"),
    writeFile(path.join(directory, "review.md"), reviewParts.join("\n\n") + "\n", "utf8"),
    writeFile(path.join(directory, "handback.md"), handbackParts.join("\n\n") + "\n", "utf8"),
  ]);
}

/** 把"其 dependsOn 已失败"的剩余 stage 批量标记 skipped（result.stages 完整反映依赖链）。 */
function markDownstreamSkipped(
  remaining: TaskStage[],
  nameToIndex: Map<string, number>,
  failedStageNames: Set<string>,
  executedNames: Set<string>,
  reports: StageReport[],
): void {
  for (const stage of remaining) {
    if (executedNames.has(stage.name)) continue;
    const downDeps = (stage.dependsOn ?? []).filter((dep) =>
      failedStageNames.has(dep),
    );
    if (downDeps.length === 0) continue;
    reports.push({
      name: stage.name,
      executor: stage.executor,
      exitCode: -1,
      testExitCode: null,
      reviewVerdict: null,
      attempts: 0,
    });
    failedStageNames.add(stage.name);
    executedNames.add(stage.name);
  }
}

export async function runDependencyLayers(params: {
  workspace: string;
  jobId: string;
  directory: string;
  workdir: string;
  context: JobContext;
  stages: TaskStage[];
  extra: string;
  attempt: number;
  attemptExtra: string;
  maxAttempts: number;
  cancelMarker: string;
  redact: (text: string) => string;
  finish: (updates: Json) => Promise<JobState>;
  finishCancelled: () => Promise<JobState>;
  /** diff 计算基线：主 worktree 含中间层合并提交，diff 必须对任务基线而非 HEAD。 */
  diffBase?: string;
}): Promise<JobState> {
  const {
    workspace,
    jobId,
    directory,
    workdir,
    context,
    stages,
    extra,
    attempt: initialAttempt,
    attemptExtra: initialAttemptExtra,
    maxAttempts,
    cancelMarker,
    redact,
    finish,
    finishCancelled,
    diffBase,
  } = params;
  const layers = groupStagesByDependency(stages);
  const nameToIndex = new Map(
    stages.map((stage, index) => [stage.name, index]),
  );
  const stageReports: StageReport[] = [];
  const failedStageNames = new Set<string>();
  const executedNames = new Set<string>();
  const completed: CompletedStage[] = [];
  const allOrdered = layers.flat();
  // 主 worktree 当前 HEAD 作为层基；layer 1 用任务基线（主 worktree 由基线创建，HEAD 即基线）。
  let layerBase = context.baseCommit ?? worktreeHead(workdir);
  let attempt = initialAttempt;
  let attemptExtra = initialAttemptExtra;

  for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
    const layer = layers[layerIndex];
    if (existsSync(cancelMarker)) return await finishCancelled();
    // 失败传播：层内 stage 的前置已失败 → 直接标记 skipped，不创建 worktree。
    const runnable = layer.filter((stage) =>
      (stage.dependsOn ?? []).every((dep) => !failedStageNames.has(dep)),
    );
    for (const stage of layer) {
      if (runnable.includes(stage)) continue;
      executedNames.add(stage.name);
      stageReports.push({
        name: stage.name,
        executor: stage.executor,
        exitCode: -1,
        testExitCode: null,
        reviewVerdict: null,
        attempts: 0,
      });
      failedStageNames.add(stage.name);
    }
    if (runnable.length === 0) continue;

    // 1. 创建层内 stage worktrees（层基 = 主 worktree HEAD）
    const stageWorkdirs = new Map<string, string>();
    for (const stage of runnable) {
      const idx = nameToIndex.get(stage.name) ?? 0;
      stageWorkdirs.set(
        stage.name,
        await prepareStageWorktree(
          workspace,
          directory,
          jobId,
          idx,
          layerBase,
        ),
      );
    }

    // 2. 层内并发执行（每 stage 独立 worktree + 私有产物目录 + 延迟 finish）
    interface StageRun {
      stage: TaskStage;
      idx: number;
      terminal: boolean;
      cancelled: boolean;
      updates: Json | null;
      report: StageReport;
      attempt: number;
      attemptExtra: string;
    }
    const runs = await Promise.all(
      runnable.map(async (stage): Promise<StageRun> => {
        const idx = nameToIndex.get(stage.name) ?? 0;
        const stageDir = stageArtifactDir(directory, idx);
        await mkdir(stageDir, { recursive: true });
        let updates: Json | null = null;
        let cancelled = false;
        // 延迟终态：并行 stage 不直接写 job 终态（last-writer-wins 会吞掉其他 stage），
        // 层循环收集全部 outcome 后统一裁决（第一个终态胜出 + 失败传播）。
        const deferredFinish = async (terminalUpdates: Json): Promise<JobState> => {
          updates = terminalUpdates;
          return loadState(workspace, jobId);
        };
        const deferredCancel = async (): Promise<JobState> => {
          cancelled = true;
          return loadState(workspace, jobId);
        };
        const depHandback = await collectDependencyHandbacks(
          directory,
          stages,
          stage,
        );
        const stageLabel =
          await resolveAgentLabel(stage.executor, workspace);
        const stageExtra = [extra, depHandback, stage.task]
          .filter(Boolean)
          .join("\n\n");
        const outcome = await runStage({
          workspace,
          jobId,
          directory,
          workdir: stageWorkdirs.get(stage.name)!,
          context,
          stage,
          stageIndex: idx,
          stageLabel,
          stageExtra,
          attempt,
          attemptExtra,
          maxAttempts,
          cancelMarker,
          redact,
          finish: deferredFinish,
          finishCancelled: deferredCancel,
          writeDir: stageDir,
        });
        return {
          stage,
          idx,
          terminal: outcome.terminal,
          cancelled,
          updates,
          report: outcome.report,
          attempt: outcome.attempt,
          attemptExtra: outcome.attemptExtra,
        };
      }),
    );

    // 3. 层裁决：任一终态（失败/取消）→ 停止任务；成功 stage 的 diff 合并进主 worktree。
    // intentional-simple: 并行 stage 的非终态 state 写入（phase/attempt/stageRetries/
    // executorInvocations）存在良性竞态——整态 load-merge-save 下并发写可能丢字段，
    // 均为展示性字段；终态裁决与依赖传播由本循环串行完成，不受影响。
    const terminalRun = runs.find((run) => run.terminal) ?? null;
    if (terminalRun) {
      for (const run of runs) executedNames.add(run.stage.name);
      for (const run of runs)
        if (run.terminal) failedStageNames.add(run.stage.name);
      // 全部已完成 stage 的报告并入 result（含终态 stage 自身；与串行路径一致）。
      for (const run of runs) {
        stageReports.push(run.report);
        if (!run.terminal) completed.push({ idx: run.idx, name: run.stage.name });
      }
      markDownstreamSkipped(
        allOrdered.filter((s) => !executedNames.has(s.name)),
        nameToIndex,
        failedStageNames,
        executedNames,
        stageReports,
      );
      if (terminalRun.cancelled) return await finishCancelled();
      return await finish({
        ...(terminalRun.updates ?? {}),
        stages: stageReports,
      });
    }
    for (const run of runs) executedNames.add(run.stage.name);

    // 4. 成功 stage：按声明顺序合并 diff → 主 worktree；冲突即停。
    for (const run of runs) {
      logJobEvent(workspace, jobId, "stage_started", {
        stage: run.stage.name,
        executor: run.stage.executor,
        index: run.idx,
        total: stages.length,
        dependsOn: run.stage.dependsOn ?? [],
      });
      const merge = await mergeStageIntoMain(
        workdir,
        stageWorkdirs.get(run.stage.name)!,
      );
      if (!merge.merged) {
        const error = `stage 合并冲突：${run.stage.name}（${merge.conflicts.join("；")}）`;
        logJobEvent(workspace, jobId, "stage_merge_conflict", {
          stage: run.stage.name,
          conflicts: merge.conflicts,
        });
        return await finish({
          status: "needs_fix",
          phase: "stage_merge_conflict",
          stage: run.stage.name,
          error,
          mergeConflicts: merge.conflicts,
          stages: stageReports,
        });
      }
      await cleanupStageWorktree(workspace, directory, run.idx);
      // 保留 per-stage handback 副本（collectDependencyHandbacks 依赖它）
      const handbackFile = path.join(
        stageArtifactDir(directory, run.idx),
        "handback.md",
      );
      if (existsSync(handbackFile)) {
        const safeName = run.stage.name.replace(/[^A-Za-z0-9._-]+/g, "-");
        await writeFile(
          path.join(directory, `stage-${run.idx}-${safeName}-handback.md`),
          await readFile(handbackFile, "utf8"),
          "utf8",
        );
      }
      stageReports.push(run.report);
      completed.push({ idx: run.idx, name: run.stage.name });
      attempt = Math.max(attempt, run.attempt);
      attemptExtra = run.attemptExtra;
      logJobEvent(workspace, jobId, "stage_finished", {
        stage: run.stage.name,
        executor: run.stage.executor,
        index: run.idx,
        exitCode: run.report.exitCode,
        reviewVerdict: run.report.reviewVerdict ?? "skipped",
      });
    }

    // 5. 层聚合：jobDir 证据反映合并进展（下一层 context pack 与最终证据门读取）。
    await collectDiff(directory, workdir, diffBase);
    await aggregateStageArtifacts(directory, completed);

    // 6. 中间层提交：下一层 stage worktree 的基（isolated worktree 内的内部提交）。
    if (layerIndex < layers.length - 1)
      layerBase = commitLayer(workdir, layerIndex + 1);
  }

  const lastReview = stageReports.at(-1)?.reviewVerdict ?? null;
  return await finish({
    status: "done",
    phase: "done",
    stages: stageReports,
    reviewVerdict: lastReview === "skipped" ? null : lastReview,
    reviewExitCode: 0,
    testExitCode: 0,
  });
}
