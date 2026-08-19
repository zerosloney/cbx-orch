import { existsSync } from "node:fs";
import { readFile, unlink, } from "node:fs/promises";
import path from "node:path";
import { loadJson } from "./storage.js";
import { collectDepBaseline, detectChangedDeps } from "./dependency-guard.js";
import { RetryBudget } from "./retry-budget.js";
import { snapshotDiff, collectDiff } from "./git-ops.js";
import { loadState, writeState, logJobEvent } from "./state.js";
import { invokeExecutor, promptFor, runTest } from "./runner.js";
import {
  createExecutorContextPack,
  createAuditorContextPack,
} from "./context-pack.js";
import {
  criterionDefinitions,
  parseStructuredAudit,
  reconcileVerifiedProgress,
  type VerifiedProgress,
} from "./progress.js";
import { evidenceHashes, structuredAuditRequested } from "./evidence.js";
import { parseReviewVerdict } from "./verdict.js";
import { createHumanGate } from "./human-gate.js";
import { resolveAgentLabel } from "./agent-registry.js";
import { contextArtifacts, AUDIT_CANDIDATE } from "./artifacts.js";
import { ROUTE_AUTO, routeReviewExecutor } from "./executors/route.js";
import type {
  JobContext,
  JobState,
  Json,
  TaskStage,
  StageOutcome,
} from "./types.js";
import type { ProcessResult } from "./process-runner.js";

export async function runStage(params: {
  workspace: string;
  jobId: string;
  directory: string;
  workdir: string;
  context: JobContext;
  stage: TaskStage;
  stageIndex: number;
  stageLabel: string;
  stageExtra: string;
  attempt: number;
  attemptExtra: string;
  maxAttempts: number;
  cancelMarker: string;
  redact: (text: string) => string;
  finish: (updates: Json) => Promise<JobState>;
  finishCancelled: () => Promise<JobState>;
  /** 本 stage 产出物（handback、test.log、review 相关、audit-candidate、complete.patch）的写入目录。
   *  缺省 = directory（串行路径：写回 jobDir）。并行路径传入 stage 私有目录，避免并发 stage 互相覆盖。 */
  writeDir?: string;
}): Promise<StageOutcome> {
  const {
    workspace,
    jobId,
    directory,
    workdir,
    context,
    stage,
    stageIndex,
    stageLabel,
    stageExtra,
    maxAttempts,
    cancelMarker,
    redact,
    finish,
    finishCancelled,
    writeDir = directory,
  } = params;
  let attempt = params.attempt;
  let attemptExtra = params.attemptExtra;
  let lastError = "";
  let executorExitCode = 0;
  let testExitCode: number | null = null;
  let reviewVerdict: string | null = null;
  const executionRetries = context.executionRetries ?? maxAttempts;
  const fixRetries = context.fixRetries ?? maxAttempts;
  const persistedUsage = await loadState(workspace, jobId);
  const budget = new RetryBudget(
    workspace,
    jobId,
    stageIndex,
    persistedUsage,
    executionRetries,
    fixRetries,
  );
  const depBaseline = context.dependencyGuard
    ? await collectDepBaseline(workdir)
    : {};

  // intentional-simple: 闭包内构造辅助。report.name/executor/attempts 与 attempt/attemptExtra 在所有 16 个返回点取值相同，
  // 仅 terminal/state/exitCode/testExitCode/reviewVerdict 因分支而异；budget.totalUsed 在 useXxxRetry 后自动累加。
  const outcome = (
    terminal: boolean,
    state: JobState,
    exitCode: number,
    testExitCode: number | null,
    reviewVerdict: string | null,
  ): StageOutcome => ({
    terminal,
    state,
    report: {
      name: stage.name,
      executor: stage.executor,
      exitCode,
      testExitCode,
      reviewVerdict,
      attempts: budget.totalUsed,
      // P0-2: 把 context.maxTurns 透传到 StageReport；当前 TaskStage 未支持 per-stage 覆盖，
      // 所以 per-stage 预算恒等于 context.maxTurns。预留字段，未来 stage 加 maxTurns 时只改这里。
      configuredMaxTurns: context.maxTurns,
    },
    attempt,
    attemptExtra,
  });
  const cancelOutcome = async (
    exitCode: number,
    testExitCode: number | null,
  ): Promise<StageOutcome> =>
    outcome(true, await finishCancelled(), exitCode, testExitCode, null);

  for (;;) {
    if (existsSync(cancelMarker)) return await cancelOutcome(-1, null);
    attempt += 1;
    await writeState(workspace, jobId, {
      status: "running",
      phase: "executing",
      stage: stage.name,
      stageIndex,
      attempt,
      workdir,
      error: lastError || null,
    });
    const executorState = await loadState(workspace, jobId);
    const executorPack = await createExecutorContextPack({
      directory,
      taskContract: context.taskContract,
      verifiedProgress: executorState.verifiedProgress,
      audit: executorState.audit,
      recentFailure: {
        phase: executorState.phase,
        error: lastError || undefined,
        retryReason: executorState.retryReason as string | undefined,
        count: (executorState.failureTracker as { count?: number } | undefined)
          ?.count,
      },
      userInstructions: [stageExtra, attemptExtra].filter(Boolean).join("\n\n"),
      artifactNames: contextArtifacts(directory, [
        "context-snapshot.md",
        "complete.patch",
        "test.log",
        "review.md",
        "handback.md",
        "audit.json",
        "verified-progress.json",
      ]),
      redact,
      budget: context.contextBudget,
      stage,
      attempt,
    });
    let agent: ProcessResult;
    try {
      agent = await invokeExecutor(
        stage.executor,
        workspace,
        directory,
        workdir,
        promptFor(
          `stage ${stageIndex}: ${stage.name}`,
          `按上下文包 current.stage 与 userInstructions 执行。完成后将修改摘要、测试结果和遗留问题写入 ${path.join(writeDir, "handback.md")}。`,
          stageLabel,
          executorPack.path,
        ),
        context.permissionMode,
        context.maxTurns,
        context.timeoutMs,
        { role: "stage", jobId, stageIndex },
      );
    } catch (error) {
      lastError = String(error);
      if (budget.canRetryExecution()) {
        await budget.useExecutionRetry();
        await writeState(workspace, jobId, {
          phase: "retrying",
          stage: stage.name,
          retryReason: lastError,
        });
        continue;
      }
      const state = await finish({
        status: "failed",
        phase: "executing",
        stage: stage.name,
        error: lastError,
      });
      return outcome(true, state, -1, null, null);
    }
    if (existsSync(cancelMarker))
      return await cancelOutcome(agent.code, null);
    await collectDiff(writeDir, workdir);
    if (context.dependencyGuard) {
      const changedDepFiles = await detectChangedDeps(workdir, depBaseline);
      if (changedDepFiles.length > 0) {
        lastError = `依赖守卫：未经授权修改了依赖文件：${changedDepFiles.join(", ")}。`;
        if (budget.canRetryFix()) {
          await budget.useFixRetry();
          attemptExtra = `请恢复 ${changedDepFiles.join("、")} 至任务开始前的状态，或通过 --no-dependency-guard 禁用依赖守卫。`;
          await writeState(workspace, jobId, {
            phase: "retrying",
            stage: stage.name,
            retryReason: lastError,
          });
          continue;
        }
        const state = await finish({
          status: "needs_fix",
          phase: "dependency_guard",
          stage: stage.name,
          error: lastError,
        });
        return outcome(true, state, 0, null, null);
      }
    }
    if (agent.code !== 0 || agent.timedOut) {
      lastError = agent.timedOut
        ? `${stageLabel} 超时（${context.timeoutMs}ms）`
        : `${stageLabel} 执行失败`;
      executorExitCode = agent.code;
      if (budget.canRetryExecution()) {
        await budget.useExecutionRetry();
        await writeState(workspace, jobId, {
          phase: "retrying",
          stage: stage.name,
          retryReason: lastError,
          executorExitCode: agent.code,
        });
        continue;
      }
      const state = await finish({
        status: "failed",
        phase: "executing",
        stage: stage.name,
        executorExitCode: agent.code,
        timedOut: agent.timedOut,
        error: lastError,
      });
      return outcome(true, state, agent.code, null, null);
    }
    executorExitCode = 0;
    await writeState(workspace, jobId, {
      phase: "testing",
      stage: stage.name,
      executorExitCode: 0,
    });
    const test = await runTest(
      context.workspace,
      writeDir,
      workdir,
      context.testCommand,
      context.timeoutMs,
    );
    if (existsSync(cancelMarker))
      return await cancelOutcome(0, test.code);
    const reviewedSnapshot = await collectDiff(writeDir, workdir);
    if (test.code !== 0 || test.timedOut) {
      lastError = test.timedOut
        ? `验收命令超时（${context.timeoutMs}ms）`
        : "验收命令失败";
      testExitCode = test.code;
      if (budget.canRetryFix()) {
        await budget.useFixRetry();
        attemptExtra = `请读取 ${path.join(writeDir, "test.log")}，修复失败原因后重新执行。`;
        await writeState(workspace, jobId, {
          phase: "retrying",
          stage: stage.name,
          retryReason: lastError,
          testExitCode: test.code,
        });
        continue;
      }
      const state = await finish({
        status: "needs_fix",
        phase: "testing",
        stage: stage.name,
        testExitCode: test.code,
        timedOut: test.timedOut,
        error: lastError,
      });
      return outcome(true, state, 0, test.code, null);
    }
    testExitCode = 0;
    if (stage.skipReview || !context.reviewRequested) {
      reviewVerdict = stage.skipReview ? "skipped" : null;
      return outcome(
        false,
        await loadState(workspace, jobId),
        executorExitCode,
        testExitCode,
        reviewVerdict,
      );
    }
    await writeState(workspace, jobId, {
      status: "running",
      phase: "reviewing",
      stage: stage.name,
      testExitCode: 0,
    });
    const definitions = criterionDefinitions(
      context.taskContract?.acceptanceCriteria ?? [],
    );
    const structuredAuditExtra = structuredAuditRequested(context)
      ? `\n同时将严格 JSON 写入 ${path.join(writeDir, AUDIT_CANDIDATE)}：{"version":1,"completion":"complete|incomplete|blocked","cleanliness":"clean|suspect|violation","alignment":"aligned|unknown|needs_revision|invalid","criteria":[{"id":"criterion id","status":"verified|unverified|blocked","evidence":["complete.patch"]}]}。criteria 必须恰好覆盖上下文包 current.criteria 的全部 ID；verified 必须引用至少一个证据；evidence 只能引用上下文包 artifacts 中实际存在的文件名。`
      : "";
    const reviewExtra = `只审查上下文包 artifacts 中列出的证据，不要修改代码。将结果写入 ${path.join(writeDir, "review.md")}。第一行必须是 VERDICT: PASS 或 VERDICT: FAIL（供人工阅读）。同时把机器可读判定写入 ${path.join(writeDir, "review.json")}，严格 JSON：{"version":1,"verdict":"PASS"或"FAIL"}（推荐；未写则 cbx 回退解析 review.md 首行）。若失败源于需求歧义、公共契约冲突或基线问题，第二行写 CLASSIFICATION: SEMANTIC；普通代码缺陷无需 classification。按严重程度列出问题、文件和行号。${structuredAuditExtra}`;
    let reviewAgent: ProcessResult;
    let reviewExecutor = stage.reviewExecutor ?? context.reviewExecutor ?? stage.executor;
    // reviewExecutor="auto"：路由一个避开主执行 agent 的交叉验证者（独立审查，避免「自己审自己」）；
    // 找不到可路由的其它 agent 时回退主执行 agent 自审（reviewLabel 仍为该 agent）。
    if (reviewExecutor === ROUTE_AUTO) {
      const reviewDecision = await routeReviewExecutor({
        task: context.taskText ?? stage.task ?? "",
        workspace,
        primary: stage.executor,
      });
      if (reviewDecision) reviewExecutor = reviewDecision.executor;
    }
    const reviewLabel = await resolveAgentLabel(reviewExecutor, workspace, "审查代理");
    const auditCandidate = path.join(writeDir, AUDIT_CANDIDATE);
    const reviewJsonCandidate = path.join(writeDir, "review.json");
    if (existsSync(auditCandidate)) await unlink(auditCandidate);
    if (existsSync(reviewJsonCandidate)) await unlink(reviewJsonCandidate);
    if (
      structuredAuditRequested(context) &&
      existsSync(path.join(writeDir, "review.md"))
    )
      await unlink(path.join(writeDir, "review.md"));
    const auditorState = await loadState(workspace, jobId);
    const auditorPack = await createAuditorContextPack({
      directory,
      taskContract: context.taskContract,
      verifiedProgress: auditorState.verifiedProgress,
      audit: auditorState.audit,
      recentFailure: {
        phase: auditorState.phase,
        error: auditorState.error as string | undefined,
        retryReason: auditorState.retryReason as string | undefined,
        count: (auditorState.failureTracker as { count?: number } | undefined)
          ?.count,
      },
      userInstructions: "执行独立审查",
      artifactNames: contextArtifacts(directory, [
        "context-snapshot.md",
        "complete.patch",
        "test.log",
        "handback.md",
        "audit.json",
        "verified-progress.json",
      ]),
      redact,
      budget: context.contextBudget,
      stage,
      reviewRules:
        context.reviewRules ??
        "关注正确性、回归风险、安全性、测试覆盖和改动范围。",
      criteria: definitions,
    });
    try {
      reviewAgent = await invokeExecutor(
        reviewExecutor,
        workspace,
        directory,
        workdir,
        promptFor(
          "independent review",
          reviewExtra,
          reviewLabel,
          auditorPack.path,
        ),
        context.permissionMode,
        context.maxTurns,
        context.timeoutMs,
        { role: "review", jobId, stageIndex },
      );
    } catch (error) {
      lastError = String(error);
      if (budget.canRetryFix()) {
        await budget.useFixRetry();
        await writeState(workspace, jobId, {
          phase: "retrying",
          stage: stage.name,
          retryReason: lastError,
        });
        continue;
      }
      const state = await finish({
        status: "review_failed",
        phase: "reviewing",
        stage: stage.name,
        error: lastError,
      });
      return outcome(true, state, 0, 0, null);
    }
    if (existsSync(cancelMarker)) return await cancelOutcome(0, 0);
    const afterReview = await snapshotDiff(workdir);
    if (JSON.stringify(afterReview) !== JSON.stringify(reviewedSnapshot)) {
      await collectDiff(writeDir, workdir);
      lastError = "审查代理修改了工作区；为避免交付未经测试的代码，任务已停止";
      const state = await finish({
        status: "review_failed",
        phase: "reviewing",
        stage: stage.name,
        reviewExitCode: reviewAgent.code,
        reviewerModifiedWorktree: true,
        error: lastError,
      });
      return outcome(true, state, 0, 0, "FAIL");
    }
    if (reviewAgent.code !== 0 || reviewAgent.timedOut) {
      lastError = reviewAgent.timedOut
        ? `审查超时（${context.timeoutMs}ms）`
        : "审查代理执行失败";
      if (budget.canRetryFix()) {
        await budget.useFixRetry();
        await writeState(workspace, jobId, {
          phase: "retrying",
          stage: stage.name,
          retryReason: lastError,
        });
        continue;
      }
      const state = await finish({
        status: "review_failed",
        phase: "reviewing",
        stage: stage.name,
        reviewExitCode: reviewAgent.code,
        timedOut: reviewAgent.timedOut,
        error: lastError,
      });
      return outcome(true, state, 0, 0, null);
    }
    if (structuredAuditRequested(context)) {
      try {
        if (!existsSync(auditCandidate))
          throw new Error("审查代理未生成 audit-candidate.json。");
        const hashes = await evidenceHashes(directory);
        const audit = parseStructuredAudit(
          await loadJson<unknown>(auditCandidate),
          definitions,
          hashes,
        );
        const currentState = await loadState(workspace, jobId);
        const verifiedProgress = reconcileVerifiedProgress(
          definitions,
          currentState.verifiedProgress as VerifiedProgress | undefined,
          audit,
          hashes,
        );
        await writeState(workspace, jobId, {
          audit,
          verifiedProgress,
          auditError: null,
        });
      } catch (error) {
        lastError = `结构化审计无效：${error instanceof Error ? error.message : String(error)}`;
        if (budget.canRetryFix()) {
          await budget.useFixRetry();
          await writeState(workspace, jobId, {
            phase: "retrying",
            stage: stage.name,
            retryReason: lastError,
            auditError: lastError,
          });
          continue;
        }
        const state = await finish({
          status: "review_failed",
          phase: "reviewing",
          stage: stage.name,
          reviewVerdict: "FAIL",
          reviewExitCode: reviewAgent.code,
          auditError: lastError,
          error: lastError,
        });
        return outcome(true, state, 0, 0, "FAIL");
      }
    }
    const review = existsSync(path.join(writeDir, "review.md"))
      ? await readFile(path.join(writeDir, "review.md"), "utf8")
      : "";
    // 统一判定解析：review.json（结构化）优先，review.md 首行回退；UNKNOWN 按失败返工（fail-closed）。
    let reviewJson: unknown;
    try {
      reviewJson = existsSync(reviewJsonCandidate)
        ? await loadJson<unknown>(reviewJsonCandidate)
        : undefined;
    } catch {
      reviewJson = undefined;
    }
    const verdict = parseReviewVerdict(review, reviewJson);
    if (verdict === "UNKNOWN") {
      const firstLine = review
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/, 1)[0]
        .trim();
      logJobEvent(workspace, jobId, "review_verdict_unparsable", {
        stage: stage.name,
        firstLine: firstLine || "<空>",
      });
    }
    if (verdict === "PASS") {
      reviewVerdict = "PASS";
      return outcome(false, await loadState(workspace, jobId), 0, 0, "PASS");
    }
    lastError = "审查发现问题";
    attemptExtra = `请读取 ${path.join(writeDir, "review.md")}，修复其中的问题后重新执行。`;
    const { semanticReviewFailure } = await import("./baseline.js");
    if (semanticReviewFailure(review)) {
      const detail = "审查发现语义或契约问题，需要主 Agent 纠偏。";
      const state = await finish({
        status: "needs_fix",
        phase: "awaiting_clarification",
        stage: stage.name,
        reviewVerdict: "FAIL",
        reviewExitCode: 0,
        contextIssue: true,
        humanGate: createHumanGate("semantic_conflict", { detail }),
        error: detail,
      });
      return outcome(true, state, 0, 0, "FAIL");
    }
    reviewVerdict = "FAIL";
    if (budget.canRetryFix()) {
      await budget.useFixRetry();
      await writeState(workspace, jobId, {
        phase: "retrying",
        stage: stage.name,
        retryReason: lastError,
      });
      continue;
    }
    const state = await finish({
      status: "needs_fix",
      phase: "reviewing",
      stage: stage.name,
      reviewVerdict: "FAIL",
      reviewExitCode: 0,
      error: lastError,
    });
    return outcome(true, state, 0, 0, "FAIL");
  }
}
