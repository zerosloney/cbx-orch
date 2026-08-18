import os from "node:os";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import {
  AUTO_MODES,
  BUILTIN_EXECUTORS,
  type BuildArgsOptions,
  type BuiltinExecutor,
  findExecutable,
  resolveExecutor,
} from "./executors/builtin.js";

// Agent 注册中心：把「新增一个编码 CLI 要改 builtin.ts 硬编码」变成「丢一个 JSON spec 进目录即自动发现」。
// 发现顺序：builtin（不可被覆盖）> <workspace>/.cbx/agents/ > ~/.cbx/agents/（同名时 workspace 覆盖 user）。

export interface AgentSpec {
  /** 注册名，--executor 与 stage.executor 使用；约束为小写字母/数字/._- */
  name: string;
  aliases: string[];
  label: string;
  /** 覆盖二进制路径的环境变量；缺省由 name 派生（如 gemini → CBX_GEMINI） */
  envVar: string;
  /** PATH 上依次尝试的二进制名 */
  candidates: string[];
  /** 参数模板，支持 {prompt} 与 {maxTurns} 占位符 */
  args: string[];
  /** permissionMode ∈ {auto, dontAsk} 时追加 */
  autoArgs?: string[];
  /** permissionMode === "plan" 时追加 */
  planArgs?: string[];
  /** 有值时追加 [maxTurnsArg, String(maxTurns)] */
  maxTurnsArg?: string;
  /** spec 版本，仅用于展示与追溯 */
  version?: string;
}

export type AgentSource = "builtin" | "workspace" | "user";

export interface RegisteredAgent {
  spec: BuiltinExecutor;
  source: AgentSource;
  /** workspace/user 来源时的 spec 文件路径 */
  file?: string;
}

export interface AgentProbe {
  name: string;
  label: string;
  source: AgentSource;
  aliases: string[];
  available: boolean;
  command: string[] | null;
  error?: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item)
    ? (value as string[])
    : undefined;
}

export function validateAgentSpec(raw: unknown, file: string): AgentSpec {
  if (!raw || typeof raw !== "object") throw new Error(`${file}: spec 必须是 JSON 对象。`);
  const value = raw as Partial<AgentSpec>;
  if (typeof value.name !== "string" || !NAME_PATTERN.test(value.name))
    throw new Error(`${file}: name 必须匹配 ${NAME_PATTERN}。`);
  if (!value.label) throw new Error(`${file}: label 不能为空。`);
  const candidates = asStringArray(value.candidates);
  if (!candidates?.length) throw new Error(`${file}: candidates 必须是非空字符串数组。`);
  const args = asStringArray(value.args);
  if (!args) throw new Error(`${file}: args 必须是字符串数组。`);
  const aliases = value.aliases === undefined ? [] : asStringArray(value.aliases);
  if (!aliases) throw new Error(`${file}: aliases 必须是字符串数组。`);
  const envVar = value.envVar ?? `CBX_${value.name.replace(/[^a-z0-9]/g, "_").toUpperCase()}`;
  if (!ENV_VAR_PATTERN.test(envVar)) throw new Error(`${file}: envVar 必须匹配 ${ENV_VAR_PATTERN}。`);
  const optional = (key: "autoArgs" | "planArgs") => {
    const list = value[key];
    if (list === undefined) return undefined;
    const parsed = asStringArray(list);
    if (!parsed) throw new Error(`${file}: ${key} 必须是字符串数组。`);
    return parsed;
  };
  if (value.maxTurnsArg !== undefined && typeof value.maxTurnsArg !== "string")
    throw new Error(`${file}: maxTurnsArg 必须是字符串。`);
  if (value.version !== undefined && typeof value.version !== "string")
    throw new Error(`${file}: version 必须是字符串。`);
  return {
    name: value.name,
    aliases,
    label: value.label,
    envVar,
    candidates,
    args,
    autoArgs: optional("autoArgs"),
    planArgs: optional("planArgs"),
    maxTurnsArg: value.maxTurnsArg,
    version: value.version,
  };
}

/** 渲染 spec 的参数模板：{prompt}/{maxTurns} 占位符替换 + permissionMode 分支追加。 */
export function buildArgsFromSpec(spec: AgentSpec, opts: BuildArgsOptions): string[] {
  const args = spec.args.map((token) =>
    token === "{prompt}" ? opts.prompt : token === "{maxTurns}" ? String(opts.maxTurns) : token,
  );
  if (spec.maxTurnsArg) args.push(spec.maxTurnsArg, String(opts.maxTurns));
  if (opts.permissionMode === "plan" && spec.planArgs?.length) args.push(...spec.planArgs);
  else if (AUTO_MODES.has(opts.permissionMode) && spec.autoArgs?.length)
    args.push(...spec.autoArgs);
  return args;
}

export function specToBuiltin(spec: AgentSpec): BuiltinExecutor {
  return {
    name: spec.name,
    aliases: spec.aliases,
    label: spec.label,
    envVar: spec.envVar,
    candidates: spec.candidates,
    buildArgs: (opts) => buildArgsFromSpec(spec, opts),
  };
}

export function agentDirs(workspace: string): { user: string; workspace: string } {
  return {
    user: path.join(os.homedir(), ".cbx", "agents"),
    workspace: path.join(path.resolve(workspace), ".cbx", "agents"),
  };
}

async function loadSpecDir(
  dir: string,
  source: AgentSource,
  out: Map<string, RegisteredAgent>,
  errors: string[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // 目录不存在是常态，静默跳过
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    try {
      const spec = validateAgentSpec(JSON.parse(await readFile(file, "utf8")), file);
      if (resolveExecutor(spec.name))
        throw new Error(`${file}: name "${spec.name}" 与内置执行器冲突。`);
      out.set(spec.name, { spec: specToBuiltin(spec), source, file });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
}

/** 收集全部已注册 agent：builtin + 用户级 + workspace 级 spec 文件；校验失败不中断，聚合到 errors。 */
export async function collectAgents(workspace: string): Promise<{
  agents: RegisteredAgent[];
  errors: string[];
}> {
  const found = new Map<string, RegisteredAgent>();
  const errors: string[] = [];
  const dirs = agentDirs(workspace);
  await loadSpecDir(dirs.user, "user", found, errors);
  await loadSpecDir(dirs.workspace, "workspace", found, errors);
  const builtins: RegisteredAgent[] = BUILTIN_EXECUTORS.map((spec) => ({ spec, source: "builtin" }));
  return { agents: [...builtins, ...found.values()], errors };
}

/** 按注册名或别名解析（含文件 spec）；不命中返回 undefined（调用方再走 ESM 插件路径）。 */
export async function resolveRegisteredExecutor(
  name: string,
  workspace: string,
): Promise<BuiltinExecutor | undefined> {
  const builtin = resolveExecutor(name);
  if (builtin) return builtin;
  const { agents } = await collectAgents(workspace);
  return agents.find(
    (agent) =>
      agent.spec.name === name || agent.spec.aliases.includes(name),
  )?.spec;
}

/** 探测各 agent 的二进制可用性（envVar 覆盖 / PATH 解析），不抛错，结果内联返回。 */
export function probeAgents(agents: RegisteredAgent[]): AgentProbe[] {
  return agents.map(({ spec, source }) => {
    try {
      return {
        name: spec.name,
        label: spec.label,
        source,
        aliases: spec.aliases,
        available: true,
        command: findExecutable(spec),
      };
    } catch (error) {
      return {
        name: spec.name,
        label: spec.label,
        source,
        aliases: spec.aliases,
        available: false,
        command: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export async function discoverAgents(workspace: string): Promise<{
  probes: AgentProbe[];
  errors: string[];
}> {
  const { agents, errors } = await collectAgents(workspace);
  return { probes: probeAgents(agents), errors };
}
