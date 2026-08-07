import type { AdaptiveOptions } from "./adaptive-manager.js";
import type { TaskStage as TaskStageType, TaskContract as TaskContractType } from "./validation.js";
import type { RuntimeConfig } from "./storage.js";

export type Json = Record<string, unknown>;
export type JobStatus = "queued" | "running" | "awaiting_approval" | "needs_fix" | "review_failed" | "failed" | "done" | "cancelled";

export type CbxConfig = RuntimeConfig;

export interface JobContext {
  appVersion: string;
  jobId: string;
  workspace: string;
  createdAt: string;
  testCommand?: string;
  reviewRequested: boolean;
  isolated: boolean;
  permissionMode: string;
  maxTurns: number;
  timeoutMs: number;
  maxRetries: number;
  executionRetries: number;
  fixRetries: number;
  keepWorktree: boolean;
  reviewRules?: string;
  approvalBeforeRun: boolean;
  approvalBeforeComplete: boolean;
  autoBranch: boolean;
  autoCommit: boolean;
  commitMessage: string;
  executor: string;
  reviewExecutor?: string;
  taskContract?: TaskContractType;
  baseCommit?: string;
  baseBranch?: string;
  baseDirty?: boolean;
  baseStatus?: string;
  dirtyFingerprint?: string;
  trustMode: "trusted" | "untrusted";
  gitRoot?: string;
  adaptive?: AdaptiveOptions;
  dependencyGuard?: boolean;
}

export type TaskStage = TaskStageType;
export type TaskContract = TaskContractType;

export interface JobState {
  jobId: string;
  status: JobStatus;
  phase: string;
  workspace: string;
  jobDir: string;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  [key: string]: unknown;
}

export interface StageReport {
  name: string;
  executor: string;
  exitCode: number;
  testExitCode: number | null;
  reviewVerdict: string | null;
  attempts: number;
}

export interface StageOutcome {
  terminal: boolean;
  state: JobState;
  report: StageReport;
  attempt: number;
  attemptExtra: string;
}

export interface Understanding { interpretedGoal?: string; plannedFiles?: string[]; acceptanceCriteria?: string[]; assumptions?: string[]; blockingQuestions?: string[]; }

export interface BaselineDrift { commitDrift: boolean; dirtyDrift: boolean; currentBaseline?: import("./git-ops.js").GitBaseline; currentDirtyFingerprint?: string; }
