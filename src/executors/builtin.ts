import { BUILTIN_SPECS, specToBuiltin, type BuildArgsOptions } from "./specs.js";
import { expandPathCandidates, firstExisting } from "./locate.js";

// 内置执行器适配层：codebuddy / opencode / omp / cline / qwen 的声明式定义见 specs.ts（BUILTIN_SPECS），
// 本模块负责由 spec 派生执行器表、按名/别名解析、以及二进制查找（envVar 覆盖 → PATH 解析 → 兜底 spawn）。

export interface BuiltinExecutor {
  /** 注册名，写入 .cbx.json 的 executor 字段或 --executor；内置之外可由 agent-registry 注册文件 spec */
  name: string;
  /** 别名，resolveExecutor 同样命中（oh-my-pi 指向 omp，非独立二进制） */
  aliases: string[];
  /** 显示名，注入到提示词与用户可见的错误消息中 */
  label: string;
  /** 覆盖二进制路径的环境变量，与 bin 名一一对应 */
  envVar: string;
  /** PATH 上依次尝试的二进制名 */
  candidates: string[];
  /** 路由元数据：auto 路由做任务能力匹配；缺省表示不可作为 auto 候选。 */
  capabilities?: string[];
  /** 把统一入参翻译成该 CLI 的具体参数序列（不含二进制本身） */
  buildArgs(opts: BuildArgsOptions): string[];
}

export const BUILTIN_EXECUTORS: readonly BuiltinExecutor[] =
  BUILTIN_SPECS.map(specToBuiltin);

const BY_NAME: ReadonlyMap<string, BuiltinExecutor> = (() => {
  const map = new Map<string, BuiltinExecutor>();
  for (const spec of BUILTIN_EXECUTORS) {
    map.set(spec.name, spec);
    for (const alias of spec.aliases) map.set(alias, spec);
  }
  return map;
})();

/** 按注册名或别名解析内置执行器；未命中返回 undefined（调用方再当插件路径处理）。 */
export function resolveExecutor(name: string): BuiltinExecutor | undefined {
  return BY_NAME.get(name);
}

function wrapCommand(candidate: string): string[] {
  const lower = candidate.toLowerCase();
  if (lower.endsWith(".ps1"))
    return ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", candidate];
  if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js"))
    return [process.execPath, candidate];
  return [candidate];
}

/**
 * .cmd/.bat 处理：Node 20+ 出于安全（CVE-2024-27980）禁止无 shell 直接 spawn，
 * 会抛 EINVAL。npm 全局安装的 shim 三件套（无扩展/.cmd/.ps1）同目录必有 .ps1，
 * 重定向到 .ps1 走 powershell 包装（参数由 spawn 数组传递，无 cmd 转义/注入问题）；
 * 旁边没有 .ps1 的自定义 .cmd 保持原样（调用方需自行通过 envVar 指向 .ps1/.exe）。
 */
async function resolveShim(candidate: string): Promise<string[]> {
  const lower = candidate.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const ps1 = `${candidate.slice(0, -4)}.ps1`;
    if (await firstExisting([ps1])) return wrapCommand(ps1);
  }
  return wrapCommand(candidate);
}

/** 二进制未找到时的统一指引（探测与执行路径共用同一模板，避免口径漂移）。 */
export function notFoundMessage(spec: BuiltinExecutor): string {
  return `找不到 ${spec.label} (${spec.candidates.join("/")})。请安装 ${spec.label}，或设置 ${spec.envVar}。`;
}

/**
 * 定位可执行命令，未找到返回 null（区别于 findExecutable 的裸名兜底）：
 * - envVar 覆盖路径必须真实存在；
 * - candidates 按 PATH×PATHEXT 展开探测（与 agent 探测共用 locate.ts 的同一算法）；
 * - .ps1/.js/.mjs/.cjs 会被包装成 powershell/node 调用。
 */
export async function locateExecutable(spec: BuiltinExecutor): Promise<string[] | null> {
  const configured = process.env[spec.envVar];
  if (configured) {
    return (await firstExisting([configured])) ? resolveShim(configured) : null;
  }
  for (const name of spec.candidates) {
    const found = await firstExisting(expandPathCandidates(name));
    if (found) return resolveShim(found);
  }
  return null;
}

/**
 * 返回 [command, ...rest] 形式的可执行命令；未定位到时兜底返回首个候选名，
 * 交给 spawn 报错（调用方需要确定性失败时应优先使用 locateExecutable）。
 */
export async function findExecutable(spec: BuiltinExecutor): Promise<string[]> {
  return (await locateExecutable(spec)) ?? wrapCommand(spec.candidates[0]);
}
