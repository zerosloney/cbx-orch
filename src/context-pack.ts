import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { saveJson } from "./storage.js";

export type ContextRole = "manager" | "executor" | "auditor";
export type ContextArtifact = "context-snapshot.md" | "complete.patch" | "test.log" | "review.md" | "handback.md" | "audit.json" | "verified-progress.json";

interface TaskContractProjection {
  goal?: string;
  nonGoals?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  relevantFiles?: string[];
  decisions?: string[];
  rejectedOptions?: string[];
  assumptions?: string[];
  stages?: Array<{ name: string; executor: string; task: string; reviewExecutor?: string; skipReview?: boolean }>;
}

interface ContextArtifactReference { name: ContextArtifact; path: string; sha256: string; }
interface RecentFailure { phase?: string | null; error?: string | null; retryReason?: string | null; count?: number; }
interface EvidenceProjection { artifact: string; sha256: string; }
interface CriterionProjection { id: string; criterion: string; status: "verified" | "unverified" | "blocked" | "invalidated"; evidence: EvidenceProjection[]; }
interface ProgressProjection { version: 1; criteria: CriterionProjection[]; }
interface AuditProjection extends ProgressProjection { completion: "complete" | "incomplete" | "blocked"; cleanliness: "clean" | "suspect" | "violation"; alignment: "aligned" | "unknown" | "needs_revision" | "invalid"; }
interface CommonContextPack {
  version: 1;
  projection: true;
  role: ContextRole;
  taskContract: TaskContractProjection | null;
  verifiedProgress: ProgressProjection | null;
  audit: AuditProjection | null;
  recentFailure: RecentFailure | null;
  userInstructions: string;
  artifacts: ContextArtifactReference[];
}

export interface ManagerContextPack extends CommonContextPack {
  role: "manager";
  current: { round: number; maxRounds: number; remainingRounds: number };
}
export interface ExecutorContextPack extends CommonContextPack {
  role: "executor";
  current: { stage: { name: string; executor: string; task: string }; attempt: number };
}
export interface AuditorContextPack extends CommonContextPack {
  role: "auditor";
  current: { stage: { name: string; executor: string; task: string }; reviewRules: string; criteria: Array<{ id: string; criterion: string }> };
}
export type RoleContextPack = ManagerContextPack | ExecutorContextPack | AuditorContextPack;

export const CONTEXT_PACK_MAX_CHARS = 24_000;
const ARTIFACTS = new Set<ContextArtifact>(["context-snapshot.md", "complete.patch", "test.log", "review.md", "handback.md", "audit.json", "verified-progress.json"]);
const FILES: Record<ContextRole, string> = { manager: "manager-context.json", executor: "executor-context.json", auditor: "auditor-context.json" };

function short(value: unknown, limit: number, redact: (text: string) => string = value => value): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = redact(value).trim();
  return text ? text.slice(0, limit) : undefined;
}

function strings(value: unknown, redact: (text: string) => string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.map(item => short(item, 200, redact)).filter((item): item is string => Boolean(item)).slice(0, 6);
  return result.length ? result : undefined;
}

function projectContract(value: unknown, redact: (text: string) => string): TaskContractProjection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const projected: TaskContractProjection = { goal: short(raw.goal, 1_000, redact) };
  for (const key of ["nonGoals", "acceptanceCriteria", "constraints", "relevantFiles", "decisions", "rejectedOptions", "assumptions"] as const) projected[key] = strings(raw[key], redact);
  if (Array.isArray(raw.stages)) {
    projected.stages = raw.stages.slice(0, 6).flatMap(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const stage = item as Record<string, unknown>;
      const name = short(stage.name, 120, redact); const executor = short(stage.executor, 120, redact); const task = short(stage.task, 600, redact);
      return name && executor && task ? [{ name, executor, task, reviewExecutor: short(stage.reviewExecutor, 120, redact), skipReview: typeof stage.skipReview === "boolean" ? stage.skipReview : undefined }] : [];
    });
  }
  return Object.fromEntries(Object.entries(projected).filter(([, item]) => item !== undefined)) as TaskContractProjection;
}

function projectFailure(value: RecentFailure | undefined, redact: (text: string) => string): RecentFailure | null {
  if (!value) return null;
  return {
    phase: short(value.phase, 200, redact) ?? null,
    error: short(value.error, 2_000, redact) ?? null,
    retryReason: short(value.retryReason, 2_000, redact) ?? null,
    count: Number.isInteger(value.count) && Number(value.count) > 0 ? Number(value.count) : undefined,
  };
}

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function projectCriteria(value: unknown, name: string, redact: (text: string) => string): CriterionProjection[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${name} 必须是不超过 100 项的数组。`);
  return value.slice(0, 20).map((item, index) => {
    if (!plain(item) || Object.keys(item).some(key => !["id", "criterion", "status", "evidence"].includes(key))) throw new Error(`${name}[${index}] 无效。`);
    const id = short(item.id, 200, redact); const criterion = short(item.criterion, 500, redact);
    if (!id || !criterion || !["verified", "unverified", "blocked", "invalidated"].includes(String(item.status)) || !Array.isArray(item.evidence) || item.evidence.length > 10) throw new Error(`${name}[${index}] 无效。`);
    const evidence = item.evidence.map((entry, evidenceIndex) => {
      if (!plain(entry) || Object.keys(entry).some(key => !["artifact", "sha256"].includes(key))) throw new Error(`${name}[${index}].evidence[${evidenceIndex}] 无效。`);
      const artifact = short(entry.artifact, 100, redact);
      if (!artifact || !/^[a-f0-9]{64}$/.test(String(entry.sha256))) throw new Error(`${name}[${index}].evidence[${evidenceIndex}] 无效。`);
      return { artifact, sha256: String(entry.sha256) };
    });
    return { id, criterion, status: item.status as CriterionProjection["status"], evidence };
  });
}

function projectProgress(value: unknown, name: string, redact: (text: string) => string): ProgressProjection | null {
  if (value === undefined || value === null) return null;
  if (!plain(value) || Object.keys(value).some(key => !["version", "criteria"].includes(key)) || value.version !== 1) throw new Error(`${name} 无效。`);
  return { version: 1, criteria: projectCriteria(value.criteria, `${name}.criteria`, redact) };
}

function projectAudit(value: unknown, redact: (text: string) => string): AuditProjection | null {
  if (value === undefined || value === null) return null;
  if (!plain(value) || Object.keys(value).some(key => !["version", "completion", "cleanliness", "alignment", "criteria"].includes(key)) || value.version !== 1 || !["complete", "incomplete", "blocked"].includes(String(value.completion)) || !["clean", "suspect", "violation"].includes(String(value.cleanliness)) || !["aligned", "unknown", "needs_revision", "invalid"].includes(String(value.alignment))) throw new Error("audit 无效。");
  return { version: 1, completion: value.completion as AuditProjection["completion"], cleanliness: value.cleanliness as AuditProjection["cleanliness"], alignment: value.alignment as AuditProjection["alignment"], criteria: projectCriteria(value.criteria, "audit.criteria", redact) };
}

async function references(directory: string, names: readonly ContextArtifact[]): Promise<ContextArtifactReference[]> {
  const unique = [...new Set(names)];
  return Promise.all(unique.map(async name => {
    if (!ARTIFACTS.has(name) || path.basename(name) !== name) throw new Error(`上下文包不允许引用 artifact：${name}`);
    const file = path.join(directory, name);
    if (!existsSync(file)) throw new Error(`上下文包 artifact 不存在：${name}`);
    return { name, path: file, sha256: createHash("sha256").update(await readFile(file)).digest("hex") };
  }));
}

type CommonInput = {
  directory: string;
  taskContract?: unknown;
  verifiedProgress?: unknown;
  audit?: unknown;
  recentFailure?: RecentFailure;
  userInstructions?: string;
  artifactNames: readonly ContextArtifact[];
  redact: (text: string) => string;
};

async function common(role: ContextRole, input: CommonInput): Promise<CommonContextPack> {
  return {
    version: 1,
    projection: true,
    role,
    taskContract: projectContract(input.taskContract, input.redact),
    verifiedProgress: projectProgress(input.verifiedProgress, "verifiedProgress", input.redact),
    audit: projectAudit(input.audit, input.redact),
    recentFailure: projectFailure(input.recentFailure, input.redact),
    userInstructions: input.redact(input.userInstructions ?? "").slice(0, 4_000),
    artifacts: await references(input.directory, input.artifactNames),
  };
}

async function materialize(directory: string, pack: RoleContextPack): Promise<{ pack: RoleContextPack; path: string }> {
  const validated = parseContextPack(pack);
  const file = path.join(directory, FILES[pack.role]);
  await saveJson(file, validated);
  return { pack: validated, path: file };
}

export async function createManagerContextPack(input: CommonInput & { round: number; maxRounds: number }): Promise<{ pack: ManagerContextPack; path: string }> {
  const pack = { ...await common("manager", input), role: "manager" as const, current: { round: input.round, maxRounds: input.maxRounds, remainingRounds: input.maxRounds - input.round } } as ManagerContextPack;
  return materialize(input.directory, pack) as Promise<{ pack: ManagerContextPack; path: string }>;
}

export async function createExecutorContextPack(input: CommonInput & { stage: { name: string; executor: string; task: string }; attempt: number }): Promise<{ pack: ExecutorContextPack; path: string }> {
  const stage = { name: input.redact(input.stage.name).slice(0, 120), executor: input.redact(input.stage.executor).slice(0, 120), task: input.redact(input.stage.task).slice(0, 1_000) };
  const pack = { ...await common("executor", input), role: "executor" as const, current: { stage, attempt: input.attempt } } as ExecutorContextPack;
  return materialize(input.directory, pack) as Promise<{ pack: ExecutorContextPack; path: string }>;
}

export async function createAuditorContextPack(input: CommonInput & { stage: { name: string; executor: string; task: string }; reviewRules: string; criteria: Array<{ id: string; criterion: string }> }): Promise<{ pack: AuditorContextPack; path: string }> {
  const stage = { name: input.redact(input.stage.name).slice(0, 120), executor: input.redact(input.stage.executor).slice(0, 120), task: input.redact(input.stage.task).slice(0, 1_000) };
  const criteria = input.criteria.slice(0, 100).map(item => ({ id: input.redact(item.id).slice(0, 200), criterion: input.redact(item.criterion).slice(0, 500) }));
  const pack = { ...await common("auditor", input), role: "auditor" as const, current: { stage, reviewRules: input.redact(input.reviewRules).slice(0, 2_000), criteria } } as AuditorContextPack;
  return materialize(input.directory, pack) as Promise<{ pack: AuditorContextPack; path: string }>;
}

export function contextPackFile(role: ContextRole): string { return FILES[role]; }

export function parseContextPack(value: unknown): RoleContextPack {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("context pack 必须是普通对象。");
  if (JSON.stringify(value).length > CONTEXT_PACK_MAX_CHARS) throw new Error(`context pack 超过 ${CONTEXT_PACK_MAX_CHARS} 字符上限。`);
  const raw = value as Record<string, unknown>;
  const allowed = ["version", "projection", "role", "taskContract", "verifiedProgress", "audit", "recentFailure", "userInstructions", "artifacts", "current"];
  const unknown = Object.keys(raw).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`context pack 不支持字段：${unknown.join(", ")}`);
  if (raw.version !== 1 || raw.projection !== true || !["manager", "executor", "auditor"].includes(String(raw.role))) throw new Error("context pack 版本、投影标记或角色无效。");
  if (typeof raw.userInstructions !== "string" || raw.userInstructions.length > 4_000) throw new Error("context pack userInstructions 无效。");
  if (raw.taskContract !== null) {
    if (!raw.taskContract || typeof raw.taskContract !== "object" || Array.isArray(raw.taskContract)) throw new Error("context pack taskContract 无效。");
    const contractAllowed = ["goal", "nonGoals", "acceptanceCriteria", "constraints", "relevantFiles", "decisions", "rejectedOptions", "assumptions", "stages"];
    if (Object.keys(raw.taskContract).some(key => !contractAllowed.includes(key))) throw new Error("context pack taskContract 包含未知字段。");
  }
  projectProgress(raw.verifiedProgress, "verifiedProgress", value => value);
  projectAudit(raw.audit, value => value);
  if (raw.recentFailure !== null) {
    if (!raw.recentFailure || typeof raw.recentFailure !== "object" || Array.isArray(raw.recentFailure)) throw new Error("context pack recentFailure 无效。");
    const failure = raw.recentFailure as Record<string, unknown>;
    if (Object.keys(failure).some(key => !["phase", "error", "retryReason", "count"].includes(key)) || [failure.phase, failure.error, failure.retryReason].some(item => item !== undefined && item !== null && typeof item !== "string") || (failure.count !== undefined && (!Number.isInteger(failure.count) || Number(failure.count) < 1))) throw new Error("context pack recentFailure 无效。");
  }
  if (!Array.isArray(raw.artifacts)) throw new Error("context pack artifacts 必须是数组。");
  for (const item of raw.artifacts) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("context pack artifact 必须是普通对象。");
    const artifact = item as Record<string, unknown>;
    if (Object.keys(artifact).some(key => !["name", "path", "sha256"].includes(key)) || !ARTIFACTS.has(artifact.name as ContextArtifact) || typeof artifact.path !== "string" || !path.isAbsolute(artifact.path) || path.basename(artifact.path) !== artifact.name || !/^[a-f0-9]{64}$/.test(String(artifact.sha256))) throw new Error("context pack artifact 无效。");
  }
  if (!raw.current || typeof raw.current !== "object" || Array.isArray(raw.current)) throw new Error("context pack current 无效。");
  const current = raw.current as Record<string, unknown>;
  const currentAllowed = raw.role === "manager" ? ["round", "maxRounds", "remainingRounds"] : raw.role === "executor" ? ["stage", "attempt"] : ["stage", "reviewRules", "criteria"];
  if (Object.keys(current).some(key => !currentAllowed.includes(key))) throw new Error("context pack current 包含未知字段。");
  if (raw.role === "manager") {
    if (![current.round, current.maxRounds, current.remainingRounds].every(Number.isInteger) || Number(current.round) < 1 || Number(current.maxRounds) < Number(current.round) || Number(current.remainingRounds) !== Number(current.maxRounds) - Number(current.round)) throw new Error("manager context pack current 无效。");
  } else {
    const stage = current.stage;
    if (!stage || typeof stage !== "object" || Array.isArray(stage) || Object.keys(stage).some(key => !["name", "executor", "task"].includes(key)) || ["name", "executor", "task"].some(key => typeof (stage as Record<string, unknown>)[key] !== "string" || !(stage as Record<string, string>)[key].trim())) throw new Error("role context pack stage 无效。");
    if (raw.role === "executor" && (!Number.isInteger(current.attempt) || Number(current.attempt) < 0)) throw new Error("executor context pack attempt 无效。");
    if (raw.role === "auditor") {
      if (typeof current.reviewRules !== "string" || !Array.isArray(current.criteria) || current.criteria.length > 100 || current.criteria.some(item => !plain(item) || Object.keys(item).some(key => !["id", "criterion"].includes(key)) || typeof item.id !== "string" || !item.id || typeof item.criterion !== "string" || !item.criterion)) throw new Error("auditor context pack current 无效。");
    }
  }
  return raw as unknown as RoleContextPack;
}
