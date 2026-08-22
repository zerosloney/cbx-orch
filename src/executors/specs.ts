// AgentSpec：executor 的声明式描述。builtin（BUILTIN_SPECS）与 .cbx/agents/*.json 文件 spec
// 共用同一契约与渲染逻辑，消除「硬编码 builtin + 文件 spec」双轨。
import type { BuiltinExecutor } from "./builtin.js";

export interface BuildArgsOptions {
  prompt: string;
  permissionMode: string;
  maxTurns: number;
  /** 模型选择（如 "gpt-5"、"claude-sonnet-4"）；spec 声明 modelArg 且任务指定 model 时追加 */
  model?: string;
}

// permissionMode 中表示「自动放行」的语义值：opencode 用 --auto、cline 用 --auto-approve true 表达。
export const AUTO_MODES = new Set(["auto", "dontAsk"]);

export interface AgentSpec {
  /** 注册名，--executor 与 stage.executor 使用；约束为小写字母/数字/._- */
  name: string;
  aliases: string[];
  label: string;
  /** 覆盖二进制路径的环境变量；缺省由 name 派生（如 gemini → CBX_GEMINI） */
  envVar: string;
  /** PATH 上依次尝试的二进制名 */
  candidates: string[];
  /**
   * 参数模板，占位符：{prompt}、{maxTurns}、{permissionMode}（原始值）、
   * {auto}（auto/dontAsk 时 "true"，否则 "false"，表达 cline --auto-approve 类布尔开关）
   */
  args: string[];
  /** permissionMode ∈ {auto, dontAsk} 时追加 */
  autoArgs?: string[];
  /** permissionMode === "plan" 时追加 */
  planArgs?: string[];
  /** 有值时追加 [maxTurnsArg, String(maxTurns)] */
  maxTurnsArg?: string;
  /** 模型选择 flag（如 "--model"）：任务指定 model 时追加 [modelArg, model]。
   *  内置 CLI 未验证各家的模型 flag 前不声明（避免拼错参数）；文件 spec 可立即使用。 */
  modelArg?: string;
  /** spec 版本，仅用于展示与追溯 */
  version?: string;
  /**
   * 路由元数据：该 agent 擅长的领域/技术标签（如 "frontend"、"react"）。
   * executor 为保留字 "auto" 时，路由层把它与任务文本做词频匹配打分选 agent；
   * 缺省表示无可路由能力（auto 不优先选它）。纯启发式声明，不影响入参渲染。
   */
  capabilities?: string[];
}

/** 渲染 spec 的参数模板：占位符替换 + permissionMode 分支追加（plan 优先，其次 auto）。 */
export function buildArgsFromSpec(spec: AgentSpec, opts: BuildArgsOptions): string[] {
  const args = spec.args.map((token) =>
    token === "{prompt}"
      ? opts.prompt
      : token === "{maxTurns}"
        ? String(opts.maxTurns)
        : token === "{permissionMode}"
          ? opts.permissionMode
          : token === "{auto}"
            ? String(AUTO_MODES.has(opts.permissionMode))
            : token,
  );
  if (spec.maxTurnsArg) args.push(spec.maxTurnsArg, String(opts.maxTurns));
  if (spec.modelArg && opts.model) args.push(spec.modelArg, opts.model);
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
    capabilities: spec.capabilities,
    buildArgs: (opts) => buildArgsFromSpec(spec, opts),
  };
}

/**
 * 内置 executor 的声明式定义：与 .cbx/agents/*.json 文件 spec 同一形状，
 * BUILTIN_EXECUTORS 由它派生（见 builtin.ts）。行为契约由 tests/core.retry.test.ts 金样锁定。
 */
export const BUILTIN_SPECS: readonly AgentSpec[] = [
  {
    name: "codebuddy",
    aliases: ["cbc"],
    label: "CodeBuddy",
    envVar: "CBX_CODEBUDDY",
    candidates: ["codebuddy", "cbc"],
    args: [
      "-p",
      "--output-format", "stream-json",
      "--max-turns", "{maxTurns}",
      "--permission-mode", "{permissionMode}",
      "{prompt}",
    ],
  },
  {
    name: "opencode",
    aliases: [],
    label: "OpenCode",
    envVar: "CBX_OPENCODE",
    candidates: ["opencode"],
    args: ["run", "--format", "json", "{prompt}"],
    autoArgs: ["--auto"],
  },
  {
    name: "omp",
    aliases: ["oh-my-pi"], // oh-my-pi 是 omp 的扩展框架，仍由 omp 二进制执行
    label: "Oh My Pi",
    envVar: "CBX_OMP",
    candidates: ["omp"],
    // omp 官方 CLI 文档未公开 permission/auto flag；非交互 -p 默认按 omp 自身权限行事。
    // intentional-simple: 不追加 auto flag，缺已知天花板——待 omp 暴露权限 flag 后补 `-a` 类参数。
    args: ["-p", "--mode", "json", "{prompt}"],
  },
  {
    name: "cline",
    aliases: [],
    label: "Cline",
    envVar: "CBX_CLINE",
    candidates: ["cline"],
    args: ["--json", "{prompt}", "--auto-approve", "{auto}"],
    planArgs: ["--plan"],
  },
  {
    name: "qwen",
    aliases: [],
    label: "Qwen Code",
    envVar: "CBX_QWEN",
    candidates: ["qwen"],
    // qwen 非交互模式（--prompt）按官方 headless 文档映射（https://qwenlm.github.io/qwen-code-docs/zh/users/features/headless/）：
    // - maxTurns → --max-session-turns（交互轮数预算）
    // - plan → --approval-mode plan；auto/dontAsk → --yolo（auto-approve all）
    // 不传 --sandbox：cbx 需执行器在 worktree 内自由读写，沙箱会阻碍任务执行。
    // 无人值守场景建议在宿主环境设 QWEN_CODE_UNATTENDED_RETRY=1（子进程经 runProcess 继承 process.env）。
    args: ["--prompt", "{prompt}", "--output-format", "stream-json", "--max-session-turns", "{maxTurns}"],
    planArgs: ["--approval-mode", "plan"],
    autoArgs: ["--yolo"],
  },
];
