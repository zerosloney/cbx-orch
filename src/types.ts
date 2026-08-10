import type { AdaptiveOptions } from "./adaptive-manager.js";
import type {
  TaskStage as TaskStageType,
  TaskContract as TaskContractType,
} from "./validation.js";
import type { RuntimeConfig } from "./storage.js";
import type { ContextBudget } from "./context-pack.js";

export type Json = Record<string, unknown>;
export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "needs_fix"
  | "review_failed"
  | "failed"
  | "done"
  | "cancelled";

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
  contextBudget?: ContextBudget;
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
  // --- typed optional fields (reduces `as` casts) ---
  error?: string;
  retryReason?: string | null;
  approved?: boolean;
  approvalRequired?: boolean;
  humanGate?: unknown;
  pendingCompletion?: unknown;
  completionApproved?: boolean;
  approvedAt?: string;
  cancelledAt?: string;
  gitCommit?: string | null;
  baselineDrift?: boolean;
  dirtyBaselineDrift?: boolean;
  currentCommit?: string | null;
  workdir?: string;
  worktreeCleaned?: boolean;
  cleanupError?: string;
  adaptiveRound?: number;
  adaptiveRounds?: Json[];
  stages?: StageReport[];
  managerDoneStreak?: number;
  stageRetries?: Record<string, { execution: number; fix: number }>;
  stage?: string;
  executorExitCode?: number;
  testExitCode?: number;
  reviewVerdict?: string | null;
  timedOut?: boolean;
  audit?: unknown;
  verifiedProgress?: unknown;
  auditError?: string | null;
  blockingQuestions?: string[];
  continuationInstructions?: string | null;
  failureTracker?: unknown;
  stageDeps?: Record<string, string[]>;
  referenceHashes?: Record<string, string>;
  depHashes?: Record<string, string>;
  submittedAt?: string;
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

export interface Understanding {
  interpretedGoal?: string;
  plannedFiles?: string[];
  acceptanceCriteria?: string[];
  assumptions?: string[];
  blockingQuestions?: string[];
}

export interface BaselineDrift {
  commitDrift: boolean;
  dirtyDrift: boolean;
  currentBaseline?: import("./git-ops.js").GitBaseline;
  currentDirtyFingerprint?: string;
}
