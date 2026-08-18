import path from "node:path";
import { CbxError } from "./errors.js";
import { saveJson, loadJson } from "./storage.js";
import type { JobContext } from "./types.js";

function contextFieldError(field: string, expectation: string): CbxError {
  return new CbxError(
    "E_INVALID_CONTEXT",
    `context.json 无效：${field} ${expectation}。`,
  );
}
function requireContextString(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (typeof value !== "string" || !value.trim())
    throw contextFieldError(field, "必须是非空字符串");
}
function requireContextBoolean(
  raw: Record<string, unknown>,
  field: string,
): void {
  if (typeof raw[field] !== "boolean")
    throw contextFieldError(field, "必须是布尔值");
}
function requireContextNumber(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw contextFieldError(field, "必须是有限数字");
}
function requireContextNonNegInt(
  raw: Record<string, unknown>,
  field: string,
  minimum = 0,
): void {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum)
    throw contextFieldError(field, `必须是不小于 ${minimum} 的整数`);
}
function optionalContextString(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (value !== undefined && typeof value !== "string")
    throw contextFieldError(field, "缺省或为字符串");
}
function optionalContextBoolean(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (value !== undefined && typeof value !== "boolean")
    throw contextFieldError(field, "缺省或为布尔值");
}
function optionalContextNumber(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value))
  )
    throw contextFieldError(field, "缺省或为有限数字");
}
function optionalContextNonNegInt(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 0)
  )
    throw contextFieldError(field, "缺省或为非负整数");
}
function optionalContextObject(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (
    value !== undefined &&
    (!value || typeof value !== "object" || Array.isArray(value))
  )
    throw contextFieldError(field, "缺省或为对象");
}

/** 校验 context.json 内容：核心必填字段齐全且类型正确；后期版本新增字段（trustMode、executionRetries 等）
 * 存在时做类型检查但不强制要求，保持旧 job 跨版本续跑不被硬阻断（消费方均有 ?? 兜底）。未知字段容忍（前向兼容）。 */
export function validateJobContext(value: unknown): JobContext {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CbxError("E_INVALID_CONTEXT", "context.json 无效：必须是对象。");
  const raw = value as Record<string, unknown>;
  for (const field of [
    "appVersion",
    "jobId",
    "workspace",
    "createdAt",
    "permissionMode",
    "executor",
  ])
    requireContextString(raw, field);
  for (const field of ["reviewRequested", "isolated"])
    requireContextBoolean(raw, field);
  requireContextNonNegInt(raw, "maxTurns", 1);
  requireContextNumber(raw, "timeoutMs");
  requireContextNonNegInt(raw, "maxRetries", 0);
  for (const field of [
    "testCommand",
    "reviewRules",
    "reviewExecutor",
    "commitMessage",
    "baseCommit",
    "baseBranch",
    "baseStatus",
    "dirtyFingerprint",
    "gitRoot",
  ])
    optionalContextString(raw, field);
  for (const field of [
    "keepWorktree",
    "approvalBeforeRun",
    "approvalBeforeComplete",
    "autoBranch",
    "autoCommit",
    "baseDirty",
    "dependencyGuard",
  ])
    optionalContextBoolean(raw, field);
  for (const field of ["executionRetries", "fixRetries"])
    optionalContextNonNegInt(raw, field);
  if (
    raw.trustMode !== undefined &&
    raw.trustMode !== "trusted" &&
    raw.trustMode !== "untrusted"
  )
    throw contextFieldError("trustMode", "缺省或为 trusted/untrusted");
  optionalContextObject(raw, "taskContract");
  optionalContextObject(raw, "adaptive");
  optionalContextObject(raw, "contextBudget");
  return value as JobContext;
}

/** 读取并校验任务的 context.json；schema 损坏时抛出带 E_INVALID_CONTEXT 错误码的异常（文件缺失则按 loadJson 原样抛 ENOENT），不返回半成品。 */
export async function loadJobContext(directory: string): Promise<JobContext> {
  return validateJobContext(
    await loadJson<unknown>(path.join(directory, "context.json")),
  );
}

export async function updateJobContext(
  workspace: string,
  jobId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const directory = path.join(workspace, ".cbx", "jobs", jobId);
  const file = path.join(directory, "context.json");
  const current = { ...(await loadJobContext(directory)) } as Record<
    string,
    unknown
  >;
  Object.assign(current, updates);
  await saveJson(file, current);
}
