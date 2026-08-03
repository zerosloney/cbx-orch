import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ExecutorRequest {
  directory: string;
  workdir: string;
  prompt: string;
  timeoutMs: number;
  maxTurns: number;
  permissionMode: string;
  /** 执行器名（内置注册名或插件路径），让插件实现自识别 */
  executor: string;
}

export interface ExecutorResult {
  code: number;
  timedOut?: boolean;
  output?: string;
}

export interface ExecutorPlugin {
  name?: string;
  run(request: ExecutorRequest): Promise<ExecutorResult> | ExecutorResult;
}

export async function loadExecutorPlugin(spec: string, workspace: string): Promise<ExecutorPlugin> {
  const file = path.isAbsolute(spec) ? spec : path.resolve(workspace, spec);
  const module = await import(pathToFileURL(file).href) as { default?: ExecutorPlugin; run?: ExecutorPlugin["run"] };
  const plugin = module.default ?? (module.run ? { name: path.basename(file), run: module.run } : undefined);
  if (!plugin || typeof plugin.run !== "function") throw new Error(`executor 插件没有导出 run(request)：${file}`);
  return plugin;
}
