import os from "node:os";
import path from "node:path";
import { access, readdir, readFile } from "node:fs/promises";
import {
  BUILTIN_EXECUTORS,
  findExecutable,
  notFoundMessage,
  resolveExecutor,
  type BuiltinExecutor,
} from "./executors/builtin.js";
import { locateOnPath } from "./executors/locate.js";
import { type AgentSpec, specToBuiltin } from "./executors/specs.js";

// Agent 注册中心：把「新增一个编码 CLI 要改 builtin.ts 硬编码」变成「丢一个 JSON spec 进目录即自动发现」。
// 发现顺序：builtin（不可被覆盖）> <workspace>/.cbx/agents/ > ~/.cbx/agents/（同名时 workspace 覆盖 user）。

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

// collectAgents 的进程级 TTL 缓存：label 查找（resolveAgentLabel）与执行器解析
// （resolveRegisteredExecutor）在 stage 循环中高频调用，避免每次 readdir+readFile 两个目录；
// TTL 过期后自然看到新投放的 spec 文件，测试各用独立临时 workspace 不受影响。
const agentsCache = new Map<string, { value: CollectAgentsResult; expires: number }>();
const AGENTS_CACHE_TTL_MS = 3_000;

interface CollectAgentsResult {
  agents: RegisteredAgent[];
  errors: string[];
}

/** 收集全部已注册 agent：builtin + 用户级 + workspace 级 spec 文件；校验失败不中断，聚合到 errors。 */
export async function collectAgents(workspace: string): Promise<CollectAgentsResult> {
  const key = path.resolve(workspace);
  const hit = agentsCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const found = new Map<string, RegisteredAgent>();
  const errors: string[] = [];
  const dirs = agentDirs(workspace);
  await loadSpecDir(dirs.user, "user", found, errors);
  await loadSpecDir(dirs.workspace, "workspace", found, errors);
  const builtins: RegisteredAgent[] = BUILTIN_EXECUTORS.map((spec) => ({ spec, source: "builtin" }));
  const value: CollectAgentsResult = { agents: [...builtins, ...found.values()], errors };
  agentsCache.set(key, { value, expires: Date.now() + AGENTS_CACHE_TTL_MS });
  return value;
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

/**
 * 显示名查找：builtin → 文件 spec（含别名），未命中返回 fallback。
 * 阶段日志/基线消息的 label 展示统一走这里，文件 spec agent 才能拿到真实 label。
 */
export async function resolveAgentLabel(
  executor: string,
  workspace: string,
  fallback = "编码代理",
): Promise<string> {
  const builtin = resolveExecutor(executor);
  if (builtin) return builtin.label;
  const { agents } = await collectAgents(workspace);
  const agent = agents.find(
    (a) => a.spec.name === executor || a.spec.aliases.includes(executor),
  );
  return agent?.spec.label ?? fallback;
}

async function probeAgent({ spec, source }: RegisteredAgent): Promise<AgentProbe> {
  const base = {
    name: spec.name,
    label: spec.label,
    source,
    aliases: spec.aliases,
  };
  // findExecutable 对裸二进制名不做存在性检查（兜底交给 spawn），探测需自行确认。
  const configured = process.env[spec.envVar];
  if (configured) {
    try {
      await access(configured);
      return { ...base, available: true, command: await findExecutable(spec) };
    } catch {
      return {
        ...base,
        available: false,
        command: null,
        error: `${spec.envVar} 指向的路径不存在：${configured}`,
      };
    }
  }
  if (await locateOnPath(spec.candidates))
    return { ...base, available: true, command: await findExecutable(spec) };
  return {
    ...base,
    available: false,
    command: null,
    error: notFoundMessage(spec),
  };
}

/** 探测各 agent 的二进制可用性（envVar 覆盖 / PATH 解析），不抛错，结果内联返回。 */
export async function probeAgents(agents: RegisteredAgent[]): Promise<AgentProbe[]> {
  return Promise.all(agents.map(probeAgent));
}

export async function discoverAgents(workspace: string): Promise<{
  probes: AgentProbe[];
  errors: string[];
}> {
  const { agents, errors } = await collectAgents(workspace);
  return { probes: await probeAgents(agents), errors };
}
