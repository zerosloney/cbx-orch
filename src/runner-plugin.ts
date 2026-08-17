/**
 * Runner 插件接口（`cbx.runner/v1`）：把 executor / test / review 命令的进程执行外包给 ESM 插件。
 * 用途：`untrusted` 信任模式——由插件在容器里运行命令提供真实隔离，cbx 自身保持零依赖。
 * 插件是可信的隔离边界提供者（与 executor 插件不同，不需要白名单执行子进程）。
 */

import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

export const RUNNER_API_VERSION = "cbx.runner/v1";

export interface RunnerManifest {
  apiVersion: string;
  name: string;
  version: string;
  capabilities?: string[];
}

export type RunnerRole = "stage" | "review" | "manager" | "gate" | "test";

export interface RunnerRequest {
  /** host 侧 workspace 绝对路径（workdir 的实际 git 仓库根）。 */
  workspace: string;
  /** job 数据目录（.cbx/jobs/<id>）。 */
  directory: string;
  /** 执行工作目录（worktree / 主工作区）——插件负责映射到容器内路径。 */
  workdir: string;
  /** 完整 argv（含二进制名）。shell=true 时是单条命令串。 */
  command: string[];
  /** true 表示经 shell 执行（测试命令）。 */
  shell: boolean;
  role: RunnerRole;
  /** 单次执行超时（ms）；插件必须在此前杀掉容器进程。 */
  timeoutMs: number;
  /** 进程环境（host env 快照；插件按需透传/裁剪）。 */
  env: Record<string, string | undefined>;
  /** 建议的输出落盘路径（agent.log / test.log）；插件可写，host 也会兜底写。 */
  logFile?: string;
}

export interface RunnerResult {
  code: number;
  timedOut: boolean;
  output: string;
}

export interface RunnerPlugin {
  manifest: RunnerManifest;
  run(request: RunnerRequest): Promise<RunnerResult>;
}

export class RunnerPluginError extends Error {}

const runnerCache = new Map<string, Promise<RunnerPlugin>>();

/** 校验并加载 runner 插件（进程内动态 import：插件是可信的隔离边界提供者）。
 *  路径穿越防护与 executor 插件一致：realpath 解析符号链接后必须位于 workspace 内。 */
export async function resolveRunnerPlugin(
  runnerPath: string,
  workspace: string,
): Promise<RunnerPlugin> {
  const file = path.resolve(workspace, runnerPath);
  const realFile = await realpath(file);
  const realWorkspace = await realpath(path.resolve(workspace));
  const relative = path.relative(realWorkspace, realFile);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    realFile === realWorkspace
  )
    throw new RunnerPluginError(`runner 插件路径必须位于工作区内：${file}`);
  let pending = runnerCache.get(file);
  if (!pending) {
    // 运行时注册表加载（配置指定的插件路径），静态 import 不可行——见 ts-no-dynamic-import 例外。
    pending = import(pathToFileURL(file).href).then((module) => {
      const manifest = module.manifest as unknown;
      if (
        !manifest ||
        typeof manifest !== "object" ||
        (manifest as RunnerManifest).apiVersion !== RUNNER_API_VERSION ||
        typeof (manifest as RunnerManifest).name !== "string" ||
        !(manifest as RunnerManifest).name ||
        typeof (manifest as RunnerManifest).version !== "string" ||
        !(manifest as RunnerManifest).version
      )
        throw new RunnerPluginError(
          `runner 插件 manifest 无效（需要 apiVersion=${RUNNER_API_VERSION}）：${file}`,
        );
      if (typeof module.run !== "function")
        throw new RunnerPluginError(`runner 插件缺少 run(request)：${file}`);
      return {
        manifest: manifest as RunnerManifest,
        run: module.run as RunnerPlugin["run"],
      };
    });
    runnerCache.set(file, pending);
  }
  return pending;
}

/** 调用 runner 执行命令。插件负责在 timeoutMs 内杀掉容器进程；cbx 侧再做墙钟兜底
 *  （超时返回 timedOut，插件底层进程若未杀干净属插件缺陷，由容器运行时回收）。 */
export async function runViaRunner(
  plugin: RunnerPlugin,
  request: RunnerRequest,
): Promise<RunnerResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wallClock = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RunnerPluginError(`runner 执行超时（${request.timeoutMs}ms）`)),
      request.timeoutMs,
    );
  });
  try {
    const result = (await Promise.race([plugin.run(request), wallClock])) as
      | RunnerResult
      | undefined;
    const code = Number(result?.code ?? -1);
    return {
      code: Number.isInteger(code) ? code : -1,
      timedOut: Boolean(result?.timedOut),
      output: String(result?.output ?? ""),
    };
  } catch (error) {
    throw new RunnerPluginError(
      `runner ${plugin.manifest.name} 执行失败：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
