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
 * 返回 [command, ...rest] 形式的可执行命令：
 * - 优先采用 envVar 指定的覆盖路径（不检查存在性，由探测阶段给出更友好的错误）；
 * - 其次按 PATH×PATHEXT 展开探测 candidates（与 agent 探测共用 locate.ts 的同一算法）；
 * - 兜底直接把首个候选名交给 spawn，由 spawn 报错；
 * - .ps1/.js/.mjs/.cjs 会被包装成 powershell/node 调用。
 */
export async function findExecutable(spec: BuiltinExecutor): Promise<string[]> {
  const configured = process.env[spec.envVar];
  if (configured) return wrapCommand(configured);
  for (const name of spec.candidates) {
    const found = await firstExisting(expandPathCandidates(name));
    if (found) return wrapCommand(found);
  }
  return wrapCommand(spec.candidates[0]);
}
