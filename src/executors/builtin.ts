import { spawnSync } from "node:child_process";

// 内置执行器适配层：把 codebuddy / opencode / pi 等编码 CLI 收敛到统一的调用契约。
// 每个 adapter 描述：发现二进制的方式 + 如何把 (prompt, permissionMode, maxTurns) 翻译成 CLI 参数。

export interface BuildArgsOptions {
  prompt: string;
  permissionMode: string;
  maxTurns: number;
}

export interface BuiltinExecutor {
  /** 注册名，写入 .cbx.json 的 executor 字段或 --executor */
  name: "codebuddy" | "opencode" | "pi";
  /** 别名，resolveExecutor 同样命中（oh-my-pi 是 pi 的扩展框架，非独立二进制） */
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

// permissionMode 中表示「自动放行」的语义值：opencode/pi 用各自的 flag 表达。
const AUTO_MODES = new Set(["auto", "dontAsk"]);

export const BUILTIN_EXECUTORS: readonly BuiltinExecutor[] = [
  {
    name: "codebuddy",
    aliases: ["cbc"],
    label: "CodeBuddy",
    envVar: "CBX_CODEBUDDY",
    candidates: ["codebuddy", "cbc"],
    buildArgs: ({ prompt, permissionMode, maxTurns }) => [
      "-p",
      "--output-format", "stream-json",
      "--max-turns", String(maxTurns),
      "--permission-mode", permissionMode,
      prompt,
    ],
  },
  {
    name: "opencode",
    aliases: [],
    label: "OpenCode",
    envVar: "CBX_OPENCODE",
    candidates: ["opencode"],
    buildArgs: ({ prompt, permissionMode }) => {
      const args = ["run", "--format", "json", prompt];
      if (AUTO_MODES.has(permissionMode)) args.push("--auto");
      return args;
    },
  },
  {
    name: "pi",
    aliases: ["oh-my-pi"], // oh-my-pi 是 pi 的扩展框架，仍由 pi 二进制执行
    label: "Pi",
    envVar: "CBX_PI",
    candidates: ["pi"],
    buildArgs: ({ prompt, permissionMode }) => {
      const args = ["-p", "--mode", "json", prompt];
      if (AUTO_MODES.has(permissionMode)) args.push("-a");
      return args;
    },
  },
];

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

/**
 * 返回 [command, ...rest] 形式的可执行命令：
 * - 优先采用 envVar 指定的覆盖路径；
 * - Windows 上用 PowerShell Get-Command 解析 bin 名的真实来源；
 * - 兜底直接把候选名交给 spawn；
 * - .ps1/.js/.mjs/.cjs 会被包装成 powershell/node 调用。
 */
export function findExecutable(spec: BuiltinExecutor): string[] {
  const configured = process.env[spec.envVar];
  const candidates: string[] = [];
  if (configured) candidates.push(configured);
  if (process.platform === "win32") {
    const primary = spec.candidates[0];
    const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Command ${primary}).Source`], { encoding: "utf8", windowsHide: true });
    if (ps.status === 0 && String(ps.stdout).trim()) candidates.push(String(ps.stdout).trim());
  }
  candidates.push(...spec.candidates);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const lower = candidate.toLowerCase();
    if (lower.endsWith(".ps1")) return ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", candidate];
    if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js")) return [process.execPath, candidate];
    return [candidate];
  }
  throw new Error(`找不到 ${spec.label} (${spec.candidates.join("/")})。请安装 ${spec.label}，或设置 ${spec.envVar}。`);
}
